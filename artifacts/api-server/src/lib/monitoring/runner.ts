import { pool } from "@workspace/db";
import { INTERVAL_SECONDS, RETENTION_DAYS, monitorTargets, probeTarget } from "./probe";
import { runAlerts } from "./alerts";

// This module is called by the independent worker entrypoint, NEVER from the
// web server startup, a browser request, or an in-process setInterval.
export async function runMonitorOnce(source: "independent" | "verification" = "independent") {
  const targets = monitorTargets();
  if (targets.some((t) => !t.url)) throw new Error("Set MONITOR_APP_URL to the published HTTPS origin before running the independent checker.");
  const client = await pool.connect();
  let locked = false;
  try {
    locked = (await client.query("SELECT pg_try_advisory_lock(74231990) AS locked")).rows[0].locked;
    if (!locked) return { skipped: true, checks: [] };
    const slot = new Date(Math.floor(Date.now() / (INTERVAL_SECONDS * 1000)) * INTERVAL_SECONDS * 1000);
    const existing = await client.query("SELECT target FROM api_health_checks WHERE slot_at=$1 AND source=$2", [slot, source]);
    const checked = new Set(existing.rows.map((row) => row.target));
    const checks = await Promise.all(targets.filter((t) => !checked.has(t.id)).map((t) => probeTarget(t.id, t.url!)));
    for (const check of checks) await client.query(`INSERT INTO api_health_checks
      (target,slot_at,checked_at,source,status,response_ms,http_status,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(target,slot_at,source) DO NOTHING`,
      [check.target, slot, check.checkedAt, source, check.status, check.responseMs, check.httpStatus, check.reason]);
    // Retain more than a leap year. This is monitoring data cleanup only,
    // never a deletion of users' saved analyses or their underlying evidence.
    await client.query("DELETE FROM api_health_checks WHERE checked_at < now()-($1 * interval '1 day')", [RETENTION_DAYS]);
    // Verification runs cannot advance alert state, queue events or send email.
    if (source === "independent") await runAlerts();
    return { skipped: !checks.length, checks };
  } finally {
    try { if (locked) await client.query("SELECT pg_advisory_unlock(74231990)"); }
    finally { client.release(); }
  }
}
