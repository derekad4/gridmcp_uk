import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { logger } from "../logger";
import { alertConfig } from "./alert-config";
import { alertEmail, deliverAlert, type EmailPayload } from "./alert-email";
import { evaluateAlerts, initialAlertState, type AlertState, type Sample } from "./alert-policy";

// The provider retains idempotency keys for 24h. Never retry an uncertain send
// beyond that window, where the same key could otherwise produce a duplicate.
export const RETRY_WINDOW_MS = 23 * 3600000;
export async function runAlerts(options: {
  watchdog?: boolean;
  database?: typeof pool;
  send?: typeof deliverAlert;
  now?: number;
} = {}) {
  const config = alertConfig();
  const database = options.database ?? pool;
  const client = await database.connect();
  const now = options.now ?? Date.now();
  const namespace = config.mode === "dry-run" ? "dry-run" : "live";
  let locked = false, transaction = false;
  try {
    locked = (await client.query("SELECT pg_try_advisory_lock(74231991) AS locked")).rows[0].locked;
    if (!locked) return;
    if (config.mode === "misconfigured") throw new Error("Configure MONITOR_EMAIL_FROM and MONITOR_EMAIL_TO before enabling live email");
    if (config.mode === "disabled") {
      // Opt-out discards pending deliveries and resets the baseline. Old outages
      // must not be delivered retrospectively when the owner opts in again.
      await client.query("UPDATE api_monitor_alert_events SET status='cancelled' WHERE status='pending'");
      await client.query("DELETE FROM api_monitor_alert_state");
      return;
    }
    await client.query("BEGIN");
    transaction = true;
    await client.query("UPDATE api_monitor_alert_events SET status='cancelled' WHERE namespace!=$1 AND status='pending'", [namespace]);
    await client.query("DELETE FROM api_monitor_alert_state WHERE namespace!=$1", [namespace]);
    const saved = await client.query("SELECT state FROM api_monitor_alert_state WHERE namespace=$1", [namespace]);
    const state = saved.rows[0]?.state as AlertState | undefined;
    const records = await client.query(`SELECT target,slot_at,checked_at,status FROM (
      SELECT *, row_number() OVER(PARTITION BY target ORDER BY slot_at DESC) AS rn
      FROM api_health_checks WHERE source='independent' AND checked_at <= $1
      AND target IN ('elexon','mcp')) checks WHERE rn <= 2`, [new Date(now)]);
    const samples: Sample[] = records.rows.map((r) => ({
      target: r.target, slot: new Date(r.slot_at).getTime(), at: new Date(r.checked_at).getTime(), down: r.status === "down",
    }));
    const result = evaluateAlerts(state ?? initialAlertState(now), samples, now);
    await client.query(`INSERT INTO api_monitor_alert_state(namespace,state,watchdog_at) VALUES($1,$2,$3)
      ON CONFLICT(namespace) DO UPDATE SET state=$2,watchdog_at=COALESCE($3,api_monitor_alert_state.watchdog_at)`,
    [namespace, JSON.stringify(result.state), options.watchdog ? new Date(now) : null]);
    for (const event of result.transitions) {
      const id = `monitor-${namespace}-${randomUUID()}`;
      await client.query(`INSERT INTO api_monitor_alert_events(id,namespace,payload,created_at,status) VALUES($1,$2,$3,$4,$5)`,
        [id, namespace, JSON.stringify(alertEmail(event, config.from, config.to)), new Date(now), namespace === "dry-run" ? "simulated" : "pending"]);
    }
    await client.query("COMMIT");
    transaction = false;
    await client.query(`UPDATE api_monitor_alert_events SET status='expired'
      WHERE status='pending' AND created_at < $1`, [new Date(now - RETRY_WINDOW_MS)]);
    const pending = await client.query(`SELECT id,payload FROM api_monitor_alert_events
      WHERE namespace=$1 AND status='pending' ORDER BY created_at,id LIMIT 3`, [namespace]);
    let failed = false;
    for (const event of pending.rows) {
      await client.query("UPDATE api_monitor_alert_events SET attempts=attempts+1 WHERE id=$1", [event.id]);
      try {
        await (options.send ?? deliverAlert)(event.id, event.payload as EmailPayload);
        await client.query("UPDATE api_monitor_alert_events SET status='sent' WHERE id=$1", [event.id]);
      } catch {
        failed = true;
        logger.warn({ eventId: event.id }, "Monitor email was not acknowledged; will retry with the same idempotency key.");
        // Preserve transition ordering: do not send recovery ahead of its outage.
        break;
      }
    }
    await client.query("DELETE FROM api_monitor_alert_events WHERE status!='pending' AND created_at < $1", [new Date(now - 400 * 86400000)]);
    if (failed) throw new Error("Monitor email delivery failed");
  } finally {
    try {
      if (transaction) await client.query("ROLLBACK");
      if (locked) await client.query("SELECT pg_advisory_unlock(74231991)");
    } finally { client.release(); }
  }
}
