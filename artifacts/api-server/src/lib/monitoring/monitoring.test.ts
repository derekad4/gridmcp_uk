import { test, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "@workspace/db";
import request from "supertest";
import app from "../../app";
import { monitorTargets, probeTarget, RETENTION_DAYS } from "./probe";
import { monitoringSummary, expectedChecks } from "./summary";
import { GetApiMonitoringResponse } from "@workspace/api-zod";
import { runManualCheck } from "./manual";

after(async () => { await pool.end(); });
const fetcher = (body: unknown, status = 200) => (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as typeof fetch;

test("probes verify actual API responses, classify slow results and never call paid AI", async () => {
  const target = monitorTargets()[0];
  const up = await probeTarget("elexon", target.url!, { fetcher: fetcher(["WIND", "CCGT"]) });
  assert.equal(up.status, "up");
  assert.equal(up.httpStatus, 200);
  const mcp = await probeTarget("mcp", "https://example.com/api/server", { fetcher: fetcher({ status: "online", toolCount: 330 }) });
  assert.equal(mcp.status, "up");
  let tick = 0;
  const slow = await probeTarget("elexon", target.url!, { fetcher: fetcher(["WIND"]), clock: () => tick++ ? 2501 : 0 });
  assert.equal(slow.status, "degraded");
  assert.equal(slow.responseMs, 2501);
  for (const bad of [fetcher([], 503), fetcher("<html>not JSON</html>"), fetcher([])]) {
    assert.equal((await probeTarget("elexon", target.url!, { fetcher: bad })).status, "down");
  }
  const network = await probeTarget("elexon", target.url!, { fetcher: (async () => { throw new Error("Private diagnostic must not leak"); }) as typeof fetch });
  assert.equal(network.reason, "Network or TLS request failed");
  assert.equal(network.responseMs, null);
  const timeout = await probeTarget("elexon", target.url!, { timeoutMs: 10, fetcher: ((_url, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  })) as typeof fetch });
  assert.equal(timeout.reason, "Request timed out");
  assert.equal(timeout.status, "down");
});

test("monitoring uses the published origin and retains more than a leap year", () => {
  assert.ok(RETENTION_DAYS >= 366);
  assert.equal(expectedChecks(0, 86400000), 288);
  assert.equal(expectedChecks(1000, 86401000), 288);
  const previous = process.env.MONITOR_APP_URL;
  try {
    for (const value of ["http://localhost", "https://127.0.0.1", "https://app.replit.dev", "https://user:password@example.com"]) {
      process.env.MONITOR_APP_URL = value;
      assert.throws(monitorTargets);
    }
  } finally {
    if (previous === undefined) delete process.env.MONITOR_APP_URL;
    else process.env.MONITOR_APP_URL = previous;
  }
});

test("empty history stays unknown; gaps, outages, latency and stale checks are calculated from recorded evidence", async () => {
  const client = await pool.connect();
  await client.query("BEGIN");
  const now = new Date("2038-02-21T12:27:00Z");
  try {
    const empty = await monitoringSummary(365, now, client);
    GetApiMonitoringResponse.parse(empty);
    assert.equal(empty.runnerState, "waiting");
    assert.equal(empty.targets[0].uptimePercent, null);
    assert.equal(empty.targets[0].coveragePercent, 0);
    assert.ok(empty.series.every((b) => b.uptimePercent === null && b.meanResponseMs === null));
    assert.ok(empty.series.length >= 730);
    for (const [time, status, latency] of [
      ["12:00", "up", 100], ["12:05", "down", null], ["12:10", "down", null],
      ["12:20", "down", 400], ["12:25", "degraded", 2500],
    ] as const) {
      const at = `2038-02-21T${time}:00Z`;
      await client.query(`INSERT INTO api_health_checks(target,slot_at,checked_at,source,status,response_ms,http_status,reason)
        VALUES('elexon',$1,$1,'independent',$2,$3,$4,'Test observation')`, [at, status, latency, status === "down" ? 503 : 200]);
    }
    // Verification data is a real check, but must not imply a recurring
    // independent scheduler or silently fill production monitoring coverage.
    await client.query(`INSERT INTO api_health_checks(target,slot_at,checked_at,source,status,response_ms,http_status,reason)
      VALUES('mcp','2038-02-21T12:25:00Z','2038-02-21T12:26:00Z','verification','up',15,200,'Test verification')`);
    const data = await monitoringSummary(1, now, client);
    GetApiMonitoringResponse.parse(data);
    assert.equal(data.runnerState, "fresh");
    const elexon = data.targets.find((t) => t.id === "elexon")!;
    assert.equal(elexon.checks, 5);
    assert.equal(elexon.successfulChecks, 2);
    assert.equal(elexon.failedChecks, 3);
    assert.equal(elexon.degradedChecks, 1);
    assert.equal(elexon.uptimePercent, 40);
    assert.equal(elexon.unknownChecks, 283);
    assert.equal(elexon.meanResponseMs, 1000);
    assert.equal(data.targets.find((t) => t.id === "mcp")!.status, "unknown");
    assert.equal(data.incidents.length, 2);
    assert.equal(data.incidents[0].recoveredAt, "2038-02-21T12:25:00.000Z");
    assert.equal(data.incidents[1].recoveredAt, null);
    const missing = data.series.find((b) => b.target === "elexon" && b.at === "2038-02-21T12:15:00.000Z")!;
    assert.equal(missing.checks, 0);
    assert.equal(missing.uptimePercent, null);
    const stale = await monitoringSummary(1, new Date("2038-02-21T12:50:00Z"), client);
    assert.equal(stale.runnerState, "stale");
    assert.equal(stale.targets.find((t) => t.id === "elexon")!.status, "unknown");
  } finally { await client.query("ROLLBACK"); client.release(); }
});

test("monitoring HTTP reads validate ranges and never initiate checks", async () => {
  await request(app).get("/api/monitoring?days=2").expect(400);
  await request(app).get("/api/monitoring?days=365").expect(200).expect((response) => {
    assert.equal(response.body.days, 365);
    assert.equal(response.body.retentionDays, 400);
    assert.equal(response.body.mode, "manual");
    assert.equal(response.body.intervalSeconds, 0);
    assert.equal(response.body.setup.schedule, "On demand only");
    assert.match(response.headers["cache-control"], /no-store/);
    assert.ok(response.body.targets.every((t: { id: string }) => ["elexon", "mcp"].includes(t.id)));
  });
});

test("manual probes save actual snapshots, enforce a shared cooldown and never advance scheduled evidence", async () => {
  const client = await pool.connect();
  try {
    await client.query("CREATE TEMP TABLE api_health_checks (LIKE public.api_health_checks INCLUDING ALL)");
    let probes = 0;
    const database = { connect: async () => ({ query: client.query.bind(client), release() {} }) };
    const probe: typeof probeTarget = async target => {
      probes++;
      return { target, checkedAt: new Date().toISOString(), status: target === "elexon" ? "up" : "down",
        responseMs: target === "elexon" ? 150 : null, httpStatus: target === "elexon" ? 200 : null, reason: "Test observation" };
    };
    assert.deepEqual(await runManualCheck(database, probe), { skipped: false });
    assert.equal(probes, 2);
    const manual = await monitoringSummary(365, new Date(), client, "manual");
    assert.equal(manual.mode, "manual");
    assert.equal(manual.recentChecks.length, 2);
    assert.equal(manual.targets.find(t => t.id === "elexon")!.checks, 1);
    assert.equal(manual.targets.find(t => t.id === "mcp")!.failedChecks, 1);
    assert.equal(manual.targets[0].expectedChecks, 0);
    assert.deepEqual(manual.incidents, []);
    assert.equal(manual.notifications.mode, "disabled");
    assert.equal(manual.targets.find(t => t.id === "elexon")!.uptimePercent, 100);
    assert.equal(manual.targets.find(t => t.id === "mcp")!.uptimePercent, 0);
    GetApiMonitoringResponse.parse(manual);
    assert.deepEqual(await runManualCheck(database, probe), { skipped: true });
    assert.equal(probes, 2);
    const scheduled = await monitoringSummary(365, new Date(), client);
    assert.equal(scheduled.recentChecks.length, 0);
    assert.equal(scheduled.runnerState, "waiting");
    await client.query("DELETE FROM api_health_checks");
    await assert.rejects(runManualCheck(database, async () => { throw new Error("Probe failure"); }));
    assert.equal(Number((await client.query("SELECT count(*) AS n FROM api_health_checks")).rows[0].n), 0);
  } finally {
    await client.query("DROP TABLE IF EXISTS pg_temp.api_health_checks");
    client.release();
  }
});

test("manual HTTP checks reject cross-origin and invalid requests before probing", async () => {
  await request(app).post("/api/monitoring/check").expect(403);
  await request(app).post("/api/monitoring/check").set("Origin", "https://other.example").send({}).expect(403);
  await request(app).post("/api/monitoring/check").set("Host", "example.com").set("Origin", "https://example.com")
    .set("Sec-Fetch-Site", "cross-site").send({}).expect(403);
  await request(app).post("/api/monitoring/check?days=2").set("Host", "example.com").set("Origin", "https://example.com")
    .send({}).expect(400);
});
