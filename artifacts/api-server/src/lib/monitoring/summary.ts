import { pool } from "@workspace/db";
import type { ApiMonitoring } from "@workspace/api-zod";
import { INTERVAL_SECONDS, RETENTION_DAYS, STALE_MS, monitorTargets } from "./probe";
import { alertConfig } from "./alert-config";

const number = (value: unknown) => value == null ? null : Number(value);
const iso = (value: unknown) => value == null ? null : new Date(String(value)).toISOString();
export const expectedChecks = (from: number, to: number) => Math.max(0, Math.ceil(to / (INTERVAL_SECONDS * 1000)) - Math.ceil(from / (INTERVAL_SECONDS * 1000)));
const percentage = (part: number, whole: number) => whole > 0 ? Math.min(100, part / whole * 100) : 0;
type Query = Pick<typeof pool, "query">;

export async function monitoringSummary(days: number, now = new Date(), database: Query = pool, source: "manual" | "independent" = "independent"): Promise<ApiMonitoring> {
  const manual = source === "manual";
  const filter = manual ? "source='manual'" : "source='independent'";
  const notifications = manual ? { mode: "disabled" as const } : alertConfig();
  const alertStatus = manual ? { rows: [] } : await database.query(`SELECT
    (SELECT watchdog_at FROM api_monitor_alert_state WHERE namespace=$1) AS watchdog,
    count(*) FILTER(WHERE status='pending')::int AS pending,
    count(*) FILTER(WHERE status='expired' OR (status='pending' AND attempts>0))::int AS failed
    FROM api_monitor_alert_events WHERE namespace=$1`, [notifications.mode === "dry-run" ? "dry-run" : "live"]);
  const to = now.getTime(), from = to - days * 86400000;
  const bucketSeconds = days <= 1 ? 300 : days <= 7 ? 3600 : 86400;
  const args = [new Date(from), now];
  const [stats, buckets, latest, bounds, checks, episodes] = await Promise.all([
    database.query(`SELECT target, count(*)::int AS checks,
      count(*) FILTER(WHERE status='down')::int AS failed,
      count(*) FILTER(WHERE status='degraded')::int AS degraded,
      avg(response_ms) AS mean, percentile_cont(0.95) WITHIN GROUP(ORDER BY response_ms) AS p95
      FROM api_health_checks WHERE ${filter} AND slot_at >= $1 AND slot_at < $2 GROUP BY target`, args),
    database.query(`SELECT target, floor(extract(epoch from slot_at)/$3)::bigint * $3 AS epoch,
      count(*)::int AS checks, count(*) FILTER(WHERE status='down')::int AS failed,
      avg(response_ms) AS mean, percentile_cont(0.95) WITHIN GROUP(ORDER BY response_ms) AS p95
      FROM api_health_checks WHERE ${filter} AND slot_at >= $1 AND slot_at < $2
      GROUP BY target, floor(extract(epoch from slot_at)/$3) ORDER BY epoch`, [...args, bucketSeconds]),
    database.query(`SELECT DISTINCT ON(target) target, checked_at, status, response_ms
      FROM api_health_checks WHERE ${filter} AND checked_at <= $1
      AND checked_at >= $1::timestamptz-interval '400 days' ORDER BY target, checked_at DESC`, [now]),
    database.query(`SELECT min(checked_at) AS first, max(checked_at) AS last FROM api_health_checks
      WHERE ${filter} AND checked_at <= $1 AND checked_at >= $1::timestamptz-interval '400 days'`, [now]),
    database.query(`SELECT id,target,checked_at,status,response_ms,http_status,reason
      FROM api_health_checks WHERE ${filter} AND slot_at >= $1 AND slot_at < $2 ORDER BY checked_at DESC LIMIT 100`, args),
    manual ? Promise.resolve({ rows: [] }) : database.query(`WITH ordered AS (
      SELECT target,checked_at,status,
        lag(status) OVER w AS previous_status, lag(checked_at) OVER w AS previous_at,
        lead(status) OVER w AS next_status, lead(checked_at) OVER w AS next_at
      FROM api_health_checks WHERE source='independent'
        AND checked_at >= $2::timestamptz-interval '400 days' AND checked_at <= $2
      WINDOW w AS (PARTITION BY target ORDER BY checked_at)
    ), labelled AS (
      SELECT *,sum(CASE WHEN status='down' AND (previous_status IS DISTINCT FROM 'down'
        OR checked_at-previous_at > interval '450 seconds') THEN 1 ELSE 0 END)
        OVER(PARTITION BY target ORDER BY checked_at) AS episode
      FROM ordered
    ) SELECT target,min(checked_at) AS started,max(checked_at) AS last_failed,count(*)::int AS failed,
      max(next_at) FILTER(WHERE next_status <> 'down' AND next_at-checked_at <= interval '450 seconds') AS recovered
      FROM labelled WHERE status='down' GROUP BY target,episode
      HAVING max(checked_at) >= $1 ORDER BY min(checked_at) DESC LIMIT 101`, args),
  ]);
  const expected = manual ? 0 : expectedChecks(from, to);
  const targets = monitorTargets().map((target) => {
    const stat = stats.rows.find((s) => s.target === target.id);
    const current = latest.rows.find((s) => s.target === target.id);
    const count = Number(stat?.checks ?? 0), failed = Number(stat?.failed ?? 0);
    const fresh = current && to - new Date(current.checked_at).getTime() <= STALE_MS;
    return {
      ...target, status: fresh ? current.status as "up" | "degraded" | "down" : "unknown" as const,
      lastCheckedAt: iso(current?.checked_at), lastResponseMs: number(current?.response_ms),
      uptimePercent: count ? (count - failed) / count * 100 : null,
      coveragePercent: percentage(count, expected), checks: count, successfulChecks: count - failed,
      failedChecks: failed, degradedChecks: Number(stat?.degraded ?? 0),
      expectedChecks: expected, unknownChecks: Math.max(0, expected - count),
      meanResponseMs: number(stat?.mean), p95ResponseMs: number(stat?.p95),
    };
  });
  const byBucket = new Map(buckets.rows.map((b) => [`${b.target}:${Number(b.epoch)}`, b]));
  const series: ApiMonitoring["series"] = [];
  for (let epoch = Math.floor(from / (bucketSeconds * 1000)) * bucketSeconds; epoch * 1000 < to; epoch += bucketSeconds) {
    const bucketExpected = manual ? 0 : expectedChecks(Math.max(from, epoch * 1000), Math.min(to, (epoch + bucketSeconds) * 1000));
    for (const target of targets) {
      const b = byBucket.get(`${target.id}:${epoch}`);
      const count = Number(b?.checks ?? 0), failed = Number(b?.failed ?? 0);
      series.push({
        target: target.id, at: new Date(epoch * 1000).toISOString(),
        uptimePercent: count ? (count - failed) / count * 100 : null,
        coveragePercent: percentage(count, bucketExpected),
        meanResponseMs: number(b?.mean), p95ResponseMs: number(b?.p95),
        checks: count, failedChecks: failed, expectedChecks: bucketExpected,
      });
    }
  }
  const last = iso(bounds.rows[0]?.last);
  return {
    mode: source, generatedAt: now.toISOString(), from: new Date(from).toISOString(), to: now.toISOString(), days,
    intervalSeconds: manual ? 0 : INTERVAL_SECONDS, retentionDays: RETENTION_DAYS, bucketSeconds,
    firstCheckAt: iso(bounds.rows[0]?.first), lastRunnerAt: last,
    runnerState: !last ? "waiting" : to - Date.parse(last) > STALE_MS ? "stale" : "fresh",
    targets, series, incidentsTruncated: episodes.rows.length > 100,
    notifications: {
      mode: notifications.mode, watchdogLastAt: iso(alertStatus.rows[0]?.watchdog),
      pending: Number(alertStatus.rows[0]?.pending ?? 0), failed: Number(alertStatus.rows[0]?.failed ?? 0),
    },
    recentChecks: checks.rows.map((c) => ({
      id: c.id, target: c.target, checkedAt: iso(c.checked_at)!, status: c.status,
      responseMs: number(c.response_ms), httpStatus: number(c.http_status), reason: c.reason,
    })),
    incidents: episodes.rows.slice(0, 100).map((e) => ({
      target: e.target, startedAt: iso(e.started)!, lastFailedAt: iso(e.last_failed)!,
      recoveredAt: iso(e.recovered), failedChecks: e.failed,
      observedDurationSeconds: Math.max(0, (new Date(e.recovered ?? e.last_failed).getTime() - new Date(e.started).getTime()) / 1000),
    })),
    setup: manual ? {
      schedule: "On demand only", command: "", targetUrl: monitorTargets().find(t => t.id === "mcp")?.url ?? null,
      instructions: "Press Run check to test the Elexon reference endpoint and configured production MCP metadata endpoint. Opening or refreshing this page only reads saved results. Checks are snapshots, not continuous uptime or outage-duration measurements. No scheduled deployment, AI query or email is involved. Manual check history is retained for 400 days. Latest check and failed-check tables show at most 100 entries in the chosen range.",
    } : {
      schedule: "*/5 * * * *",
      command: "node --enable-source-maps artifacts/api-server/dist/monitor-worker.mjs",
      targetUrl: process.env.MONITOR_APP_URL ?? null,
      instructions: "Publish the app and monitoring database schema first. Build with pnpm --filter @workspace/api-server run build, then run this one-shot command every five minutes in a SEPARATE scheduled deployment or external scheduler with access to the same production PostgreSQL database and MONITOR_APP_URL. Keep the web deployment running as a web app; do not replace its run command or change it to a scheduled job. No Better Stack account is required. The web server does not schedule these probes. This page reports recent received checks, not proof that a recurring scheduler has been activated. History starts with real checks; missing periods remain unknown. Availability is the percentage of recorded successful checks (including slow responses), not guaranteed continuous uptime. The probes validate a representative Elexon endpoint and this app's server metadata; they do not exercise every API endpoint or paid AI. Samples are retained for 400 days; recent-check and incident lists show the latest 100 entries in the selected range.",
    },
  };
}
