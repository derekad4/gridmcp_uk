import { after, test } from "node:test";
import assert from "node:assert/strict";
import { pool } from "@workspace/db";
import { alertConfig } from "./alert-config";
import { alertEmail, deliverAlert } from "./alert-email";
import { ALERT_COOLDOWN_MS, evaluateAlerts, initialAlertState, type AlertState, type Sample } from "./alert-policy";
import { RETRY_WINDOW_MS, runAlerts } from "./alerts";

after(async () => { await pool.end(); });
const start = Date.parse("2040-01-01T00:00:00Z");
const minute = 60000;
function pair(at: number, down: boolean, target: "elexon" | "mcp" = "elexon"): Sample[] {
  return [0, 5].map((delta) => ({ target, at: at - delta * minute, slot: at - delta * minute, down }));
}
const both = (at: number, down = false) => [...pair(at, down), ...pair(at, false, "mcp")];

test("email is opt-in, simulations default on, live mode validates addresses", () => {
  assert.equal(alertConfig({}).mode, "disabled");
  assert.equal(alertConfig({ MONITOR_EMAIL_ENABLED: "true" }).mode, "dry-run");
  assert.equal(alertConfig({ MONITOR_EMAIL_ENABLED: "true", MONITOR_EMAIL_DRY_RUN: "false" }).mode, "misconfigured");
  assert.equal(alertConfig({
    MONITOR_EMAIL_ENABLED: "true", MONITOR_EMAIL_DRY_RUN: "false",
    MONITOR_EMAIL_FROM: "monitor@example.com", MONITOR_EMAIL_TO: "owner@example.com",
  }).mode, "live");
});

test("two consecutive slots confirm outage and recovery; duplicates and flapping are suppressed", () => {
  const initial = initialAlertState(start);
  const one = both(start + 5 * minute, true).filter((s) => s.target !== "elexon" || s.at !== start);
  assert.equal(evaluateAlerts(initial, one, start + 5 * minute).transitions.length, 0);
  const outage = evaluateAlerts(initial, both(start + 10 * minute, true), start + 10 * minute);
  assert.deepEqual(outage.transitions.map((e) => [e.subject, e.kind]), [["elexon", "outage"]]);
  assert.equal(evaluateAlerts(outage.state, both(start + 10 * minute, true), start + 10 * minute).transitions.length, 0);
  assert.equal(evaluateAlerts(outage.state, both(start + 15 * minute, true), start + 15 * minute).transitions.length, 0);
  const mixed = [...both(start + 15 * minute), { target: "elexon" as const, at: start + 20 * minute, slot: start + 20 * minute, down: true }];
  assert.equal(evaluateAlerts(outage.state, mixed, start + 20 * minute).transitions.length, 0);
  const recovery = evaluateAlerts(outage.state, both(start + 20 * minute), start + 20 * minute);
  assert.deepEqual(recovery.transitions.map((e) => [e.subject, e.kind]), [["elexon", "recovery"]]);
  assert.equal(evaluateAlerts(recovery.state, both(start + 30 * minute, true), start + 30 * minute).transitions.length, 0);
  const later = start + 10 * minute + ALERT_COOLDOWN_MS;
  assert.equal(evaluateAlerts(recovery.state, both(later, true), later).transitions[0]?.kind, "outage");
});

test("both API targets alert independently, and gaps and stale observations are never API outages", () => {
  const initial = initialAlertState(start);
  const at = start + 10 * minute;
  const allDown = [...pair(at, true), ...pair(at, true, "mcp")];
  assert.deepEqual(evaluateAlerts(initial, allDown, at).transitions.map((e) => e.subject), ["elexon", "mcp"]);
  const gap = pair(at, true).map((s, i) => i ? { ...s, slot: start - minute } : s);
  assert.equal(evaluateAlerts(initial, [...gap, ...pair(at, false, "mcp")], at).transitions.length, 0);
  const old = evaluateAlerts(initial, allDown, start + 30 * minute);
  assert.deepEqual(old.transitions.map((e) => e.subject), ["checker"]);
  const historical = evaluateAlerts(initial, both(start - minute, true), start + minute);
  assert.equal(historical.transitions.length, 0);
});

test("watchdog detects no runs or an incomplete checker, deduplicates and confirms resumed coverage", () => {
  const initial = initialAlertState(start);
  assert.equal(evaluateAlerts(initial, [], start + 10 * minute).transitions.length, 0);
  const stale = evaluateAlerts(initial, [], start + 11 * minute);
  assert.deepEqual(stale.transitions.map((e) => [e.subject, e.kind]), [["checker", "outage"]]);
  assert.equal(evaluateAlerts(stale.state, [], start + 20 * minute).transitions.length, 0);
  const partial = evaluateAlerts(stale.state, pair(start + 20 * minute, false), start + 20 * minute);
  assert.equal(partial.transitions.length, 0);
  const oneNew = both(start + 15 * minute);
  assert.equal(evaluateAlerts(stale.state, oneNew, start + 15 * minute).transitions.length, 0);
  // Health of the APIs is separate from checker coverage.
  const resumed = evaluateAlerts(stale.state, both(start + 20 * minute, true), start + 20 * minute);
  assert.ok(resumed.transitions.some((e) => e.subject === "checker" && e.kind === "recovery"));
});

test("email transport uses a stable idempotency key, bounded request, and explicit acknowledgment (no network)", async () => {
  const email = alertEmail({ subject: "checker", kind: "outage", at: start }, "monitor@example.com", "owner@example.com");
  assert.match(email.subject, /stale/);
  assert.match(email.text, /unknown, not API downtime/);
  await deliverAlert("stable-event", email, async (path, options) => {
    assert.equal(path, "/emails");
    assert.equal(options.method, "POST");
    assert.equal((options.headers as Record<string, string>)["Idempotency-Key"], "stable-event");
    assert.ok(options.signal);
    assert.deepEqual(JSON.parse(options.body as string), email);
    return Response.json({ id: "fake-acknowledgement" });
  });
  await assert.rejects(deliverAlert("stable-event", email, async () => Response.json({ error: "test" }, { status: 429 })), /HTTP 429/);
  await assert.rejects(deliverAlert("stable-event", email, async () => Response.json({})), /acknowledge/);
  await assert.rejects(deliverAlert("stable-event", email, async () => { throw new Error("simulated timeout"); }), /timeout/);
});

test("persistent queue survives failed delivery, retries with same key, separates simulations and cancels on opt-out", async () => {
  const oldEnv = { ...process.env };
  const client = await pool.connect();
  // Temporary shadow tables isolate this entire test from real monitoring data.
  // runAlerts owns its transactions, so an outer rollback would not isolate it.
  try {
    await client.query("CREATE TEMP TABLE api_health_checks (LIKE public.api_health_checks INCLUDING ALL)");
    await client.query("CREATE TEMP TABLE api_monitor_alert_state (LIKE public.api_monitor_alert_state INCLUDING ALL)");
    await client.query("CREATE TEMP TABLE api_monitor_alert_events (LIKE public.api_monitor_alert_events INCLUDING ALL)");
    const database = { connect: async () => ({ query: client.query.bind(client), release() {} }) } as unknown as typeof pool;
    Object.assign(process.env, {
      MONITOR_EMAIL_ENABLED: "true", MONITOR_EMAIL_DRY_RUN: "false",
      MONITOR_EMAIL_FROM: "monitor@example.com", MONITOR_EMAIL_TO: "owner@example.com",
    });
    async function observations(at: number, down: boolean, source = "independent") {
      for (const s of both(at, down)) await client.query(`INSERT INTO api_health_checks
        (target,slot_at,checked_at,source,status,reason) VALUES($1,$2,$2,$3,$4,'Test only') ON CONFLICT DO NOTHING`,
      [s.target, new Date(s.slot), source, s.down ? "down" : "degraded"]);
    }
    const calls: string[] = [];
    let fail = true;
    const send = async (id: string) => { calls.push(id); if (fail) throw new Error("Simulated unacknowledged email"); };
    await runAlerts({ database, send, now: start, watchdog: true });
    // Verification records are excluded even when they show both APIs failed.
    await observations(start + 10 * minute, true, "verification");
    await runAlerts({ database, send, now: start + 10 * minute });
    assert.equal(calls.length, 0);
    await observations(start + 10 * minute, true);
    await assert.rejects(runAlerts({ database, send, now: start + 10 * minute }), /delivery failed/);
    assert.equal(calls.length, 1);
    let events = await client.query("SELECT * FROM api_monitor_alert_events");
    assert.equal(events.rows.length, 1);
    assert.equal(events.rows[0].attempts, 1);
    assert.equal(events.rows[0].status, "pending");
    fail = false;
    await runAlerts({ database, send, now: start + 10 * minute });
    assert.deepEqual(calls, [calls[0], calls[0]]);
    await runAlerts({ database, send, now: start + 10 * minute });
    assert.equal(calls.length, 2);
    await observations(start + 20 * minute, false);
    await runAlerts({ database, send, now: start + 20 * minute });
    assert.equal(calls.length, 3);
    events = await client.query("SELECT * FROM api_monitor_alert_events");
    assert.equal(events.rows.filter((e) => e.status === "sent").length, 2);
    const saved = (await client.query("SELECT state FROM api_monitor_alert_state WHERE namespace='live'")).rows[0].state as AlertState;
    assert.equal(saved.subjects.elexon.down, false);
    // Simulate a restart: persisted state still deduplicates the same readings.
    await runAlerts({ database, send, now: start + 20 * minute });
    assert.equal(calls.length, 3);
    // Retried events must expire BEFORE the provider forgets its idempotency key.
    await client.query(`INSERT INTO api_monitor_alert_events(id,namespace,payload,created_at) VALUES('expired-test','live',$1,$2)`,
      [JSON.stringify(alertEmail({ subject: "mcp", kind: "outage", at: start }, "monitor@example.com", "owner@example.com")), new Date(start - RETRY_WINDOW_MS)]);
    await runAlerts({ database, send, now: start + 20 * minute });
    assert.equal((await client.query("SELECT status FROM api_monitor_alert_events WHERE id='expired-test'")).rows[0].status, "expired");
    assert.equal(calls.length, 3);
    process.env.MONITOR_EMAIL_DRY_RUN = "true";
    await runAlerts({ database, send, now: start + 25 * minute, watchdog: true });
    await runAlerts({ database, send, now: start + 36 * minute, watchdog: true });
    assert.equal(calls.length, 3);
    assert.equal((await client.query("SELECT count(*)::int AS count FROM api_monitor_alert_events WHERE status='simulated'")).rows[0].count, 1);
    await client.query(`INSERT INTO api_monitor_alert_events(id,namespace,payload) VALUES('cancel-test','live','{}')`);
    process.env.MONITOR_EMAIL_ENABLED = "false";
    await runAlerts({ database, send, now: start + 40 * minute });
    assert.equal((await client.query("SELECT count(*)::int AS count FROM api_monitor_alert_state")).rows[0].count, 0);
    assert.equal((await client.query("SELECT status FROM api_monitor_alert_events WHERE id='cancel-test'")).rows[0].status, "cancelled");
    assert.equal(calls.length, 3);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
    await client.query("DROP TABLE IF EXISTS pg_temp.api_health_checks, pg_temp.api_monitor_alert_state, pg_temp.api_monitor_alert_events");
    client.release();
  }
});
