import { pool } from "@workspace/db";
import { monitorTargets, probeTarget, RETENTION_DAYS } from "./probe";

const connect = () => pool.connect();
type Connection = Pick<Awaited<ReturnType<typeof connect>>, "query" | "release">;
type Database = { connect: () => Promise<Connection> };

// Explicit button presses only. Never invoked by reads, server startup or timers.
// The transaction-scoped lock also limits requests across Autoscale instances.
export async function runManualCheck(database: Database = { connect }, probe = probeTarget) {
  const targets = monitorTargets();
  if (targets.some(t => !t.url)) throw new Error("Published application URL is not configured.");
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const lock = await client.query("SELECT pg_try_advisory_xact_lock(74231991) AS locked");
    if (!lock.rows[0].locked) { await client.query("ROLLBACK"); return { skipped: true }; }
    const recent = await client.query("SELECT 1 FROM api_health_checks WHERE source='manual' AND checked_at > now()-interval '30 seconds' LIMIT 1");
    if (recent.rows.length) { await client.query("ROLLBACK"); return { skipped: true }; }
    const slot = new Date();
    const checks = await Promise.all(targets.map(t => probe(t.id, t.url!)));
    for (const check of checks) {
      await client.query(`INSERT INTO api_health_checks
        (target,slot_at,checked_at,source,status,response_ms,http_status,reason)
        VALUES($1,$2,$3,'manual',$4,$5,$6,$7)`,
      [check.target, slot, check.checkedAt, check.status, check.responseMs, check.httpStatus, check.reason]);
    }
    await client.query("DELETE FROM api_health_checks WHERE source='manual' AND checked_at < now()-($1 * interval '1 day')", [RETENTION_DAYS]);
    await client.query("COMMIT");
    return { skipped: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}
