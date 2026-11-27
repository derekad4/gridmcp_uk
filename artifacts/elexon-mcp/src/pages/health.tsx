import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetApiMonitoring, getGetApiMonitoringQueryKey, runApiManualCheck } from "@workspace/api-client-react";
import type { ApiMonitoring, ApiMonitorTarget, GetApiMonitoringDays } from "@workspace/api-client-react";
import { Clock, RefreshCw, WifiOff, Play } from "lucide-react";
import { MetricChart, buildRows } from "@/components/health-charts";

const RANGES: GetApiMonitoringDays[] = [1, 7, 30, 90, 365, 400];
const STATUS_STYLE: Record<string, string> = {
  up: "bg-primary text-primary-foreground", degraded: "bg-[hsl(42_85%_50%)] text-secondary",
  down: "bg-destructive text-destructive-foreground", unknown: "bg-muted text-muted-foreground border",
};
const pct = (v: number | null) => v == null ? "n/a" : `${v.toFixed(v === 100 ? 0 : 2)}%`;
const ms = (v: number | null) => v == null ? "n/a" : `${Math.round(v).toLocaleString()} ms`;
const date = (v: string | null) => v ? new Date(v).toLocaleString() : "Not checked";

export default function Health() {
  const [days, setDays] = useState<GetApiMonitoringDays>(30);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const cache = useQueryClient();
  const q = useGetApiMonitoring({ days }, { query: {
    queryKey: getGetApiMonitoringQueryKey({ days }), refetchOnWindowFocus: false, refetchInterval: 60000,
  } });
  useEffect(() => {
    document.title = "Manual API health checks | Grid MCP";
    for (const [selector, attribute, key, content] of [
      ['meta[name="description"]', "name", "description", "Run an on-demand API health check and explore saved response times and results. No continuous monitoring. Not an official Elexon status page."],
      ['meta[property="og:title"]', "property", "og:title", "Manual API health checks | Grid MCP"],
      ['meta[property="og:description"]', "property", "og:description", "Button-triggered health checks for Elexon BMRS and the production MCP API, with saved check history."],
    ]) {
      let meta = document.querySelector(selector);
      if (!meta) { meta = document.createElement("meta"); meta.setAttribute(attribute, key); document.head.appendChild(meta); }
      meta.setAttribute("content", content);
    }
  }, []);
  async function check() {
    if (running) return;
    setRunning(true); setError(""); setMessage("");
    try {
      const result = await runApiManualCheck({ days }, { headers: { "Content-Type": "application/json" } });
      cache.setQueryData(getGetApiMonitoringQueryKey({ days }), result.monitoring);
      await cache.invalidateQueries({ queryKey: getGetApiMonitoringQueryKey() });
      setMessage(result.skipped
        ? "A check is already running or was completed in the last 30 seconds. Showing the latest saved results; wait briefly before checking again."
        : "Check completed and saved. Results show each API's response at the recorded time.");
    } catch (err) {
      const data = (err as { data?: { error?: string } })?.data;
      setError(data?.error ?? "Could not run or save the check. Try again shortly; previous results remain available.");
    } finally { setRunning(false); }
  }
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-5 sm:py-10">
      <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="font-mono text-xs uppercase tracking-widest text-accent">On-demand diagnostics</p>
          <h1 className="font-display mt-1 text-4xl font-extrabold sm:text-5xl">API health checks</h1>
          <p className="mt-3 max-w-2xl text-muted-foreground">Check the Elexon BMRS API and our production MCP API when you need to. Each button press saves a snapshot for your history. Opening this page does not run a check. Not an official Elexon status page.</p>
        </div>
        <button onClick={check} disabled={running} data-testid="button-run-check" className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-primary px-5 py-3 font-semibold text-primary-foreground disabled:cursor-wait disabled:opacity-60">
          {running ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          {running ? "Checking APIs…" : "Run check"}
        </button>
      </div>
      <div aria-live="polite" role="status" className="mt-4 text-sm">
        {running && <p>Testing both endpoints and saving the results. This can take up to about 15 seconds.</p>}
        {message && <p className="text-primary">{message}</p>}
      </div>
      {error && <p role="alert" className="mt-3 rounded-lg border border-destructive/40 p-4 text-sm text-destructive">{error}</p>}
      <div className="mt-7 flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-lg border bg-card p-1" role="group" aria-label="History date range">
          {RANGES.map(r => <button key={r} data-testid={`button-range-${r}`} aria-pressed={days === r} onClick={() => setDays(r)}
            className={`rounded-md px-2.5 py-1 font-mono text-xs ${days === r ? "bg-secondary text-secondary-foreground" : "text-muted-foreground"}`}>
            {r === 1 ? "24h" : `${r}d`}
          </button>)}
        </div>
        <button onClick={() => q.refetch()} disabled={q.isFetching || running} className="inline-flex items-center gap-2 text-xs text-muted-foreground disabled:opacity-50">
          <RefreshCw className={`h-3 w-3 ${q.isFetching ? "animate-spin" : ""}`} /> Refresh saved history
        </button>
      </div>
      {q.isLoading && !q.data ? <div className="mt-8 h-40 animate-pulse rounded-xl bg-muted" data-testid="status-loading" /> :
        q.isError && !q.data ? <div data-testid="status-error" className="mt-8 rounded-xl border border-destructive/40 bg-card p-6">
          <p className="flex items-center gap-2 font-semibold text-destructive"><WifiOff className="h-5 w-5" /> Could not load saved check history</p>
          <p className="mt-2 text-sm text-muted-foreground">This is a history-loading error, not evidence that either monitored API is down.</p>
          <button onClick={() => q.refetch()} className="mt-3 text-sm underline">Try again</button>
        </div> : q.data ? <Body d={q.data} stale={q.isError} /> : null}
    </div>
  );
}

function TargetCard({ t }: { t: ApiMonitorTarget }) {
  return <section data-testid={`card-target-${t.id}`} className="min-w-0 rounded-xl border bg-card p-5">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0"><h2 className="font-display text-xl font-bold">{t.name}</h2><p className="truncate font-mono text-xs text-muted-foreground">{t.url ?? "Production URL not configured"}</p></div>
      <span data-testid={`status-target-${t.id}`} className={`rounded-full px-2.5 py-0.5 font-mono text-xs uppercase ${STATUS_STYLE[t.status]}`}>{t.status === "unknown" ? "Not current" : t.status}</span>
    </div>
    <dl className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
      <Stat label="Successful checks" value={t.checks ? pct(t.uptimePercent) : "No checks"} />
      <Stat label="Last response" value={ms(t.lastResponseMs)} /><Stat label="Checks in range" value={String(t.checks)} />
      <Stat label="Mean response" value={ms(t.meanResponseMs)} /><Stat label="p95 response" value={ms(t.p95ResponseMs)} />
      <Stat label="Failed checks" value={String(t.failedChecks)} />
    </dl>
    <p className="mt-4 text-xs text-muted-foreground">Last checked: {date(t.lastCheckedAt)}. {t.degradedChecks} slow responses in this range. Status is unknown after ten minutes until you check again.</p>
  </section>;
}
function Stat({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt><dd className="font-mono font-medium">{value}</dd></div>;
}
function Panel({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return <section className="min-w-0 rounded-xl border bg-card p-5"><h2 className="font-display text-lg font-bold">{title}</h2><p className="mb-3 text-xs text-muted-foreground">{note}</p>{children}</section>;
}
function Body({ d, stale }: { d: ApiMonitoring; stale: boolean }) {
  const success = useMemo(() => buildRows(d.series, d.targets, d.bucketSeconds, "uptimePercent"), [d]);
  const mean = useMemo(() => buildRows(d.series, d.targets, d.bucketSeconds, "meanResponseMs"), [d]);
  const p95 = useMemo(() => buildRows(d.series, d.targets, d.bucketSeconds, "p95ResponseMs"), [d]);
  const chartProps = { targets: d.targets, days: d.days, from: d.from, to: d.to };
  return <div className="mt-6 space-y-6">
    {stale && <p className="text-sm text-destructive">History refresh failed. Previously loaded results are shown.</p>}
    <div data-testid="status-runner" className="rounded-xl border bg-card p-5">
      <p className="flex items-center gap-2 font-semibold"><Clock className="h-4 w-4" /> {d.lastRunnerAt ? `Last manual check: ${date(d.lastRunnerAt)}` : "Ready for your first manual check"}</p>
      <p className="mt-2 text-sm text-muted-foreground">Press Run check to test both APIs. There is no background schedule or automatic outage email. Results describe the instant checked—not continuous uptime, downtime duration or health between checks. Manual history is retained for {d.retentionDays} days; it starts with your first check.</p>
    </div>
    <div className="grid gap-4 md:grid-cols-2">{d.targets.map(t => <TargetCard key={t.id} t={t} />)}</div>
    <p className="text-xs text-muted-foreground">Range: {date(d.from)} to {date(d.to)}. Successful checks include valid but slow responses (over 2 seconds). Missing observations are not treated as successes or failures. {d.firstCheckAt && `First manual check: ${date(d.firstCheckAt)}.`}</p>
    {d.series.some(s => s.checks > 0) ? <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="Successful manual checks" note="Percentage of recorded checks that succeeded per time bucket. Gaps have no observations; this is not an uptime measurement."><MetricChart testId="chart-success" rows={success} unit="%" domain={[0, 100]} {...chartProps} /></Panel>
      <Panel title="Mean response time" note="Average response time of recorded checks per time bucket."><MetricChart testId="chart-mean" rows={mean} unit="ms" {...chartProps} /></Panel>
      <Panel title="p95 response time" note="95th percentile of recorded response times per time bucket."><MetricChart testId="chart-p95" rows={p95} unit="ms" {...chartProps} /></Panel>
    </div> : <div data-testid="status-empty" className="grid-paper rounded-xl border p-10 text-center">
      <p className="font-display text-xl font-bold">No manual checks in this range</p><p className="mt-2 text-sm text-muted-foreground">Run your first check above, or choose another date range to see saved results.</p>
    </div>}
    <Panel title="Manual check history" note="Latest 100 recorded results in the selected range, including unsuccessful requests. History is shared across visitors.">
      {!d.recentChecks.length ? <p className="py-4 text-sm text-muted-foreground">No checks logged yet.</p> : <div className="max-h-96 overflow-auto"><table className="w-full text-sm">
        <thead className="sticky top-0 bg-card"><tr className="text-left text-[11px] uppercase text-muted-foreground">{["Time", "API", "Result", "HTTP", "Response", "Details"].map(h => <th key={h} className="py-2 pr-4">{h}</th>)}</tr></thead>
        <tbody>{d.recentChecks.map(c => <tr key={c.id} className="border-t text-xs">
          <td className="whitespace-nowrap py-2 pr-4">{date(c.checkedAt)}</td><td className="pr-4">{d.targets.find(t => t.id === c.target)?.name ?? c.target}</td>
          <td className="pr-4"><span className={`rounded px-1.5 py-0.5 uppercase ${STATUS_STYLE[c.status]}`}>{c.status}</span></td>
          <td className="pr-4">{c.httpStatus ?? "No response"}</td><td className="pr-4">{ms(c.responseMs)}</td><td className="text-muted-foreground">{c.reason}</td>
        </tr>)}</tbody>
      </table></div>}
    </Panel>
    <Panel title="What this check covers" note="Point-in-time diagnostics, not an official service-level report.">
      <p className="text-sm text-muted-foreground">{d.setup.instructions}</p>
      <p className="mt-2 text-sm text-muted-foreground">Only fixed, configured endpoints are called. This does not exercise every API endpoint or run a paid AI analysis. Requests have a 12-second timeout and a shared 30-second cooldown to avoid excessive upstream traffic. This website cannot check itself while it is unreachable.</p>
    </Panel>
  </div>;
}
