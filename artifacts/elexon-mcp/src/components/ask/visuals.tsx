import { useMemo, useState } from "react";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, LabelList, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis,
} from "recharts";
import type { AnalysisChart, AnalysisDataset, AnalysisDiagram } from "@workspace/api-client-react";
import { fmtExact, fmtNum } from "@/lib/ask";
import { categoryLabel, fieldLabel, metricLabel, seriesLabel } from "@workspace/elexon-labels";

const COLORS = ["#61A9BD", "#CED14E", "#44986D", "#DD83C9", "#1F74AD", "#E98E2E", "#9267C6", "#8D6C5B", "#D8524F", "#979797"];
const TIP = { background: "hsl(40 40% 99%)", border: "1px solid hsl(35 18% 84%)", borderRadius: 8, fontSize: 12 };
const INK = "hsl(222 12% 40%)";
const MONO = { fontSize: 11, fontFamily: "JetBrains Mono" };

const isPct = (unit: string) => unit.trim() === "%";
/** Axis/label formatting that respects percentage units. */
function fmtVal(v: number, unit: string) {
  if (isPct(unit)) return `${v.toLocaleString("en-GB", { maximumFractionDigits: Math.abs(v) < 10 ? 2 : 1 })}%`;
  if (unit === "Hz") return v.toLocaleString("en-GB", { maximumFractionDigits: 3 });
  return fmtNum(v);
}
function fmtFull(v: number, unit: string) {
  return isPct(unit) ? `${fmtExact(v)}%` : `${fmtExact(v)}${unit ? ` ${unit}` : ""}`;
}
/** Domain that always contains every value plus zero, so the largest bar is never clipped. */
function fullDomain(values: number[], includeZero = true): [number, number] {
  const f = values.filter(Number.isFinite);
  if (!f.length) return [0, 1];
  let lo = Math.min(...f), hi = Math.max(...f);
  if (includeZero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  if (lo === hi) { const d = Math.abs(lo) || 1; return [lo - d * 0.1, hi + d * 0.1]; }
  const pad = (hi - lo) * 0.06;
  return [lo < 0 || !includeZero ? lo - pad : lo, hi > 0 || !includeZero ? hi + pad : hi];
}

function ScopeLine({ dataset, extra }: { dataset: AnalysisDataset; extra: string }) {
  return (
    <p data-testid="text-chart-scope" className="mt-3 border-t pt-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
      Source: {dataset.tool} · {dataset.coverage} · {extra} · {dataset.count} of {dataset.totalCount} rows{dataset.truncated ? " (bounded, truncated)" : ""}
    </p>
  );
}

function ViewToggle<V extends string>({ index, views, names, active, disabled, onChange }: {
  index: number; views: V[]; names: Record<V, string>; active: V; disabled?: (v: V) => boolean; onChange: (v: V) => void;
}) {
  if (views.length < 2) return null;
  return (
    <div role="group" aria-label="Chart view" className="inline-flex flex-wrap rounded-md border bg-muted/60 p-0.5">
      {views.map((v) => (
        <button key={v} type="button" data-testid={`button-chart-${index}-${v}`} disabled={disabled?.(v)} aria-pressed={active === v} onClick={() => onChange(v)}
          className={`rounded px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-40 ${active === v ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
          {names[v]}
        </button>
      ))}
    </div>
  );
}

function asTime(v: unknown): number | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/* ---------------- Categorical single-measure: pie / donut / ranked bars ---------------- */

type CatView = "pie" | "donut" | "hbar";
const CAT_NAMES: Record<CatView, string> = { pie: "Pie", donut: "Donut", hbar: "Ranked bars" };

function CategoryPanel({ chart, dataset, index }: { chart: AnalysisChart; dataset: AnalysisDataset; index: number }) {
  const key = chart.yKeys[0];
  const unit = chart.unit;
  const rows = useMemo(() => dataset.rows
    .map((r) => ({ raw: r[chart.xKey], name: String(categoryLabel(chart.xKey, r[chart.xKey] ?? "")), value: typeof r[key] === "number" ? (r[key] as number) : NaN }))
    .filter((r) => Number.isFinite(r.value))
    .sort((a, b) => b.value - a.value), [dataset, chart, key]);
  const hasNeg = rows.some((r) => r.value < 0);
  const total = rows.reduce((s, r) => s + r.value, 0);
  const pieOk = !hasNeg && total > 0 && chart.yKeys.length === 1;
  const initial: CatView = chart.kind === "pie" ? "pie" : chart.kind === "donut" ? "donut" : chart.kind === "horizontalBar" ? "hbar" : rows.length <= 8 ? "donut" : "hbar";
  const [view, setView] = useState<CatView>(initial);
  const effective: CatView = pieOk ? view : "hbar";
  const pct = (v: number) => (pieOk ? (v / total) * 100 : NaN);
  const share = (v: number) => (pieOk ? `${pct(v).toLocaleString("en-GB", { maximumFractionDigits: 2 })}%` : "n/a");
  const tip = (v: number, n: string) => [`${fmtFull(v, unit)}${pieOk && !isPct(unit) ? ` (${share(v)})` : ""}`, n];
  const isRound = effective !== "hbar";
  const longest = Math.max(0, ...rows.map((r) => r.name.length));
  const narrow = typeof window !== "undefined" && window.matchMedia?.("(max-width: 480px)").matches;
  const maxChars = narrow ? 14 : 26;
  const yWidth = Math.min(narrow ? 96 : 180, Math.max(72, Math.min(longest, maxChars) * 6.3));
  const clipName = (n: string) => (n.length > maxChars ? n.slice(0, maxChars - 1) + "…" : n);
  const dom = isPct(unit) && rows.every((r) => r.value >= 0 && r.value <= 100) ? [0, 100] as [number, number] : fullDomain(rows.map((r) => r.value));
  const pieLabel = ({ percent, name, cx, cy, midAngle, innerRadius, outerRadius }: { percent: number; name: string; cx: number; cy: number; midAngle: number; innerRadius: number; outerRadius: number }) => {
    if (percent < 0.03) return null;
    const angle = -midAngle * Math.PI / 180, radius = innerRadius ? (innerRadius + outerRadius) / 2 : outerRadius * .62;
    const label = `${(percent * 100).toLocaleString("en-GB", { maximumFractionDigits: 1 })}%`;
    // Keep labels inside the plot; the adjacent legend supplies full names.
    return <text x={cx + Math.cos(angle) * radius} y={cy + Math.sin(angle) * radius} textAnchor="middle" dominantBaseline="central" aria-label={`${name}: ${label}`} fontSize={11} fontFamily="JetBrains Mono" fill="hsl(222 40% 18%)">{label}</text>;
  };
  const views: CatView[] = pieOk ? ["pie", "donut", "hbar"] : ["hbar"];
  return (
    <figure data-testid={`chart-${index}`} className="min-w-0 rounded-xl border bg-card p-4 sm:p-5">
      <figcaption className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="font-display text-base font-semibold">{metricLabel(chart.title)}</h4>
          <p className="font-mono text-[11px] text-muted-foreground">{seriesLabel(key)} by {fieldLabel(chart.xKey)} · {unit || "value"} · total {fmtFull(total, unit)}</p>
        </div>
        <ViewToggle index={index} views={views} names={CAT_NAMES} active={effective} onChange={setView} />
      </figcaption>
      {!pieOk && (chart.kind === "pie" || chart.kind === "donut" || chart.kind === "composition") && (
        <p data-testid={`text-chart-${index}-pie-blocked`} className="mb-3 rounded-md border border-chart-4/40 bg-chart-4/10 px-3 py-2 text-xs">
          {hasNeg ? "Some categories are negative (signed flows), so shares of a whole are undefined." : "The total is zero, so shares cannot be computed."} Values are shown as ranked bars with their original signs.
        </p>
      )}
      {isRound ? (
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,15rem)]">
          <div className="h-80 w-full min-w-0">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
                <Pie data={rows} dataKey="value" nameKey="name" innerRadius={effective === "donut" ? "45%" : 0} outerRadius="68%" paddingAngle={rows.length > 1 ? 0.6 : 0}
                  label={pieLabel} labelLine={false} isAnimationActive={false}>
                  {rows.map((r, i) => <Cell key={`${r.name}-${i}`} fill={COLORS[i % COLORS.length]} stroke="hsl(40 40% 99%)" />)}
                </Pie>
                <Tooltip formatter={tip} contentStyle={TIP} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <ul data-testid={`legend-chart-${index}`} aria-label="Shares by category" className="max-h-80 space-y-1 overflow-y-auto pr-1 text-xs">
            {rows.map((r, i) => (
              <li key={`${r.name}-${i}`} className="flex items-center gap-2 border-b border-border/50 py-1">
                <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: COLORS[i % COLORS.length] }} aria-hidden />
                <span className="min-w-0 flex-1 truncate" title={String(categoryLabel(chart.xKey, r.raw, true))}>{r.name}</span>
                <span className="font-mono tabular-nums">{share(r.value)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="w-full" style={{ height: Math.max(220, rows.length * 28 + 48) }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} layout="vertical" margin={{ top: 4, right: narrow ? 52 : 64, bottom: 18, left: 0 }}>
              <CartesianGrid stroke="hsl(35 18% 84%)" strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" domain={dom} allowDataOverflow={false} tick={MONO} tickFormatter={(v: number) => fmtVal(v, unit)}
                label={{ value: isPct(unit) ? "%" : unit, position: "insideBottom", offset: -4, fontSize: 11, fill: INK }} />
              <YAxis type="category" dataKey="name" width={yWidth} interval={0} tick={{ fontSize: narrow ? 10 : 11 }} tickFormatter={clipName} />
              <Tooltip formatter={tip} contentStyle={TIP} />
              <Bar dataKey="value" name={seriesLabel(key)} radius={[0, 3, 3, 0]} isAnimationActive={false}>
                {rows.map((r, i) => <Cell key={`${r.name}-${i}`} fill={COLORS[i % COLORS.length]} />)}
                {(isPct(unit) || rows.length <= 25) && <LabelList dataKey="value" position="right" formatter={(v: number) => fmtVal(v, unit)} style={{ ...MONO, fontSize: 10, fill: INK }} />}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Underlying values</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full font-mono text-xs">
            <caption className="sr-only">{chart.title}</caption>
            <thead><tr className="border-b text-left"><th scope="col" className="py-1 pr-3">{fieldLabel(chart.xKey)}</th><th scope="col" className="py-1 pr-3 text-right">{seriesLabel(key)} ({unit})</th><th scope="col" className="py-1 text-right">Share of total</th></tr></thead>
            <tbody>{rows.map((r, i) => <tr key={`${r.name}-${i}`} className="border-b border-border/50"><th scope="row" className="py-1 pr-3 text-left font-normal">{String(categoryLabel(chart.xKey, r.raw, true))}</th><td className="py-1 pr-3 text-right tabular-nums">{fmtExact(r.value)}</td><td className="py-1 text-right tabular-nums">{share(r.value)}</td></tr>)}</tbody>
          </table>
        </div>
      </details>
      <ScopeLine dataset={dataset} extra={`${rows.length} categories · values may be totals aggregated over the queried period, not a single instant`} />
    </figure>
  );
}

/* ---------------- Series: line / area / bar / stacked / scatter ---------------- */

type View = "line" | "area" | "bar" | "stackedBar" | "stackedArea" | "scatter";
const VIEW_NAMES: Record<View, string> = { line: "Line", area: "Area", bar: "Bar", stackedBar: "Stacked bar", stackedArea: "Stacked area", scatter: "Scatter" };
const CATEGORY_KINDS = new Set(["composition", "pie", "donut", "horizontalBar"]);

export function ChartPanel({ chart, dataset, index }: { chart: AnalysisChart; dataset?: AnalysisDataset; index: number }) {
  // Identity key: a reused index with a different saved chart remounts and re-honours the requested kind.
  const id = [chart.datasetId, chart.kind, chart.xKey, chart.yKeys.join(","), chart.unit, chart.title, dataset?.id ?? ""].join("|");
  if (dataset && CATEGORY_KINDS.has(chart.kind) && chart.yKeys.length === 1) return <CategoryPanel key={id} chart={chart} dataset={dataset} index={index} />;
  return <SeriesPanel key={id} chart={chart} dataset={dataset} index={index} />;
}

function SeriesPanel({ chart, dataset, index }: { chart: AnalysisChart; dataset?: AnalysisDataset; index: number }) {
  const unit = chart.unit;
  const prepared = useMemo(() => {
    if (!dataset) return null;
    const rows = dataset.rows;
    const isTime = rows.length > 0 && rows.every((r) => asTime(r[chart.xKey]) !== null);
    const isNumX = !isTime && rows.length > 0 && rows.every((r) => typeof r[chart.xKey] === "number" && Number.isFinite(r[chart.xKey] as number));
    let hasNeg = false;
    const vals: number[] = [];
    const data = rows.map((r) => {
      const xv = r[chart.xKey];
      const o: Record<string, number | string | null> = { __x: isTime ? (asTime(xv) as number) : isNumX ? (xv as number) : String(xv ?? "") };
      let sum = 0;
      for (const k of chart.yKeys) {
        const v = r[k];
        const n = typeof v === "number" && Number.isFinite(v) ? v : null;
        if (n !== null) { if (n < 0) hasNeg = true; vals.push(n); sum += n; }
        o[k] = n;
      }
      o.__sum = sum;
      return o;
    });
    if (isTime || isNumX) data.sort((a, b) => (a.__x as number) - (b.__x as number));
    const span = isTime && data.length > 1 ? (data[data.length - 1].__x as number) - (data[0].__x as number) : 0;
    return { data, isTime, isNumX, hasNeg, vals, sums: data.map((d) => d.__sum as number), multiDay: span > 36e5 * 30, short: isTime && data.length > 1 && span < 300000 };
  }, [dataset, chart]);

  const requested: View = chart.kind === "composition" ? "stackedArea" : CATEGORY_KINDS.has(chart.kind) ? "bar" : (chart.kind as View);
  const [view, setView] = useState<View>(requested);

  if (!dataset || !prepared) {
    return <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">Chart “{chart.title}” references dataset {chart.datasetId}, which is not in this answer.</div>;
  }
  const { data, isTime, isNumX, hasNeg, vals, sums, multiDay, short } = prepared;
  const multi = chart.yKeys.length > 1;
  const views: View[] = ["line", "area", "bar"];
  if (multi) views.push("stackedBar", "stackedArea");
  if (isNumX) views.push("scatter");
  if (!views.includes(requested)) views.unshift(requested);
  const blocked = (v: View) => (v === "scatter" && !isNumX) || (v === "stackedArea" && hasNeg);
  const effective: View = blocked(view) ? "line" : view;
  const stacked = effective === "stackedBar" || effective === "stackedArea";
  const yDomain = stacked
    ? fullDomain([...sums, ...vals.filter((v) => v < 0)])
    : fullDomain(vals, effective !== "line" && effective !== "scatter" || isPct(unit));

  const tickX = (v: number | string) => {
    if (isNumX) return fmtNum(v as number);
    if (!isTime) return String(categoryLabel(chart.xKey, v));
    const d = new Date(v as number);
    return multiDay
      ? d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" })
      : d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", ...(short ? { second: "2-digit" as const } : {}), timeZone: "UTC" });
  };
  const labelX = (v: unknown) => (isTime ? new Date(v as number).toISOString().replace("T", " ").replace("Z", " UTC") : isNumX ? `${fieldLabel(chart.xKey)}: ${fmtExact(v)}` : String(categoryLabel(chart.xKey, v, true)));
  const xProps = isTime
    ? { dataKey: "__x", type: "number" as const, scale: "time" as const, domain: ["dataMin", "dataMax"] as [string, string], tickFormatter: tickX }
    : isNumX
      ? { dataKey: "__x", type: "number" as const, domain: ["dataMin", "dataMax"] as [string, string], tickFormatter: tickX, name: fieldLabel(chart.xKey) }
      : { dataKey: "__x", type: "category" as const, tickFormatter: tickX };
  // Recharts 2 discovers axes/tooltips among direct children, not inside a Fragment.
  const common = [
    <CartesianGrid key="grid" stroke="hsl(35 18% 84%)" strokeDasharray="3 3" vertical={false} />,
    <XAxis key="x-axis" {...xProps} tick={MONO} stroke={INK} minTickGap={24}
      padding={(isTime || isNumX) && (effective === "bar" || effective === "stackedBar") ? { left: 24, right: 24 } : undefined}
      label={{ value: isTime ? `${fieldLabel(chart.xKey)} (UTC)` : fieldLabel(chart.xKey), position: "insideBottom", offset: -4, fontSize: 11, fill: INK }} />,
    <YAxis key="y-axis" type="number" tick={MONO} stroke={INK} width={68} domain={yDomain} allowDataOverflow={false}
      tickFormatter={(v: number) => fmtVal(v, unit)}
      label={{ value: isPct(unit) ? "%" : unit, angle: -90, position: "insideLeft", fontSize: 11, fill: INK, style: { textAnchor: "middle" } }} />,
    <Tooltip key="tooltip" labelFormatter={labelX}
      formatter={(v: number, name: string) => [typeof v === "number" ? fmtFull(v, unit) : "—", name]} contentStyle={TIP} />,
    <Legend key="legend" wrapperStyle={{ fontSize: 12, paddingTop: 12 }} />,
  ];
  const margin = { top: 16, right: 16, bottom: 18, left: 4 };
  const showLabels = isPct(unit) && data.length <= 24 && !stacked;
  const lbl = (k: string, pos: "top" | "insideTop" = "top") => showLabels
    ? <LabelList dataKey={k} position={pos} formatter={(v: number) => (typeof v === "number" ? fmtVal(v, unit) : "")} style={{ ...MONO, fontSize: 10, fill: INK }} />
    : null;
  let body;
  if (effective === "bar" || effective === "stackedBar") {
    body = (
      <BarChart data={data} margin={margin} barGap={0} maxBarSize={40 / Math.max(1, chart.yKeys.length)} stackOffset={effective === "stackedBar" ? "sign" : "none"}>{common}
        {chart.yKeys.map((k, i) => <Bar key={k} dataKey={k} name={seriesLabel(k)} stackId={effective === "stackedBar" ? "s" : undefined} fill={COLORS[i % COLORS.length]} radius={effective === "stackedBar" ? 0 : [3, 3, 0, 0]} isAnimationActive={false}>{lbl(k)}</Bar>)}
      </BarChart>
    );
  } else if (effective === "area" || effective === "stackedArea") {
    body = (
      <AreaChart data={data} margin={margin}>{common}
        {chart.yKeys.map((k, i) => <Area key={k} name={seriesLabel(k)} type="linear" dataKey={k} stackId={stacked ? "s" : undefined} stroke={COLORS[i % COLORS.length]} fill={COLORS[i % COLORS.length]} fillOpacity={stacked ? 0.75 : 0.18} connectNulls={false} isAnimationActive={false}>{lbl(k)}</Area>)}
      </AreaChart>
    );
  } else if (effective === "scatter") {
    body = (
      <ScatterChart margin={margin}>{common}
        {chart.yKeys.map((k, i) => <Scatter key={k} name={seriesLabel(k)} data={data.filter((d) => d[k] !== null)} dataKey={k} fill={COLORS[i % COLORS.length]} isAnimationActive={false}>{lbl(k)}</Scatter>)}
      </ScatterChart>
    );
  } else {
    body = (
      <LineChart data={data} margin={margin}>{common}
        {chart.yKeys.map((k, i) => <Line key={k} dataKey={k} name={seriesLabel(k)} type="linear" stroke={COLORS[i % COLORS.length]} strokeWidth={2} dot={data.length < 40} connectNulls={false} isAnimationActive={false}>{lbl(k)}</Line>)}
      </LineChart>
    );
  }
  return (
    <figure data-testid={`chart-${index}`} className="min-w-0 rounded-xl border bg-card p-4 sm:p-5">
      <figcaption className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="font-display text-base font-semibold">{metricLabel(chart.title)}</h4>
          <p className="font-mono text-[11px] text-muted-foreground">{isPct(unit) ? "percentage (%)" : unit} · {dataset.tool} · {data.length} points</p>
        </div>
        <ViewToggle index={index} views={views} names={VIEW_NAMES} active={effective} disabled={blocked} onChange={setView} />
      </figcaption>
      {view === "stackedArea" && hasNeg && (
        <p data-testid={`text-chart-${index}-stack-blocked`} className="mb-3 rounded-md border border-chart-4/40 bg-chart-4/10 px-3 py-2 text-xs">
          Some parts are negative, so a stacked area would misstate the total. Each series is shown as a separate line instead.
        </p>
      )}
      {effective === "stackedBar" && hasNeg && (
        <p className="mb-3 rounded-md border border-chart-4/40 bg-chart-4/10 px-3 py-2 text-xs">
          Some series are negative; stacks are split above and below zero, so stack heights are not shares of a total.
        </p>
      )}
      <div className="h-64 w-full sm:h-72">
        <ResponsiveContainer width="100%" height="100%">{body}</ResponsiveContainer>
      </div>
      <ScopeLine dataset={dataset} extra={isTime ? "x axis in UTC, true time spacing" : isNumX ? `numeric x (${fieldLabel(chart.xKey)})` : `${data.length} categories`} />
    </figure>
  );
}

export function DataTable({ dataset }: { dataset: AnalysisDataset }) {
  const [page, setPage] = useState(0);
  const pageSize = 50;
  const pages = Math.max(1, Math.ceil(dataset.rows.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const start = currentPage * pageSize;
  const visibleRows = dataset.rows.slice(start, start + pageSize);
  const cols = dataset.columns.length ? dataset.columns : Object.keys(dataset.rows[0] ?? {}).map((key) => ({ key, unit: "" }));
  if (!dataset.rows.length) return <p className="p-4 text-sm text-muted-foreground">The query returned no rows for these filters.</p>;
  return (
    <div className="space-y-2">
    <div className="max-h-96 overflow-auto rounded-lg border" tabIndex={0} role="region" aria-label={`Rows from ${dataset.tool}`}>
      <table data-testid={`table-${dataset.id}`} className="w-full border-collapse text-left font-mono text-xs">
        <caption className="sr-only">{dataset.tool}: {dataset.count} of {dataset.totalCount} rows</caption>
        <thead className="sticky top-0 bg-secondary text-secondary-foreground">
          <tr>
            {cols.map((c) => (
              <th key={c.key} title={c.key} scope="col" className="whitespace-nowrap px-3 py-2 font-medium">
                {fieldLabel(c.key)}{c.unit && <span className="ml-1 text-secondary-foreground/60">({c.unit})</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visibleRows.map((r, i) => (
            <tr key={start + i} className="border-t odd:bg-card even:bg-muted/40">
              {cols.map((c) => (
                <td key={c.key} title={fmtExact(r[c.key])} className={`whitespace-nowrap px-3 py-1.5 ${typeof r[c.key] === "number" ? "text-right tabular-nums" : ""}`}>{fmtExact(categoryLabel(c.key, r[c.key], true))}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" aria-label="Evidence table pagination">
      <span aria-live="polite">Rows {start + 1}–{Math.min(start + pageSize, dataset.rows.length)} of {dataset.rows.length.toLocaleString("en-GB")} · Page {currentPage + 1} of {pages}</span>
      <button type="button" aria-label="Previous evidence page" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} className="ml-auto rounded-md border px-2 py-1 hover:text-foreground disabled:opacity-40">Previous</button>
      <button type="button" aria-label="Next evidence page" disabled={currentPage === pages - 1} onClick={() => setPage(currentPage + 1)} className="rounded-md border px-2 py-1 hover:text-foreground disabled:opacity-40">Next</button>
    </div>
    </div>
  );
}

export function DiagramView({ diagram }: { diagram: AnalysisDiagram }) {
  const layout = useMemo(() => {
    const ids = diagram.nodes.map((n) => n.id);
    const level: Record<string, number> = {};
    const incoming = new Set(diagram.edges.map((e) => e.to));
    const roots = ids.filter((id) => !incoming.has(id));
    (roots.length ? roots : ids.slice(0, 1)).forEach((r) => (level[r] = 0));
    for (let pass = 0; pass < ids.length; pass++) {
      for (const e of diagram.edges) {
        if (level[e.from] !== undefined && e.from !== e.to) {
          const next = level[e.from] + 1;
          if (level[e.to] === undefined || (level[e.to] < next && next < ids.length)) level[e.to] = next;
        }
      }
    }
    ids.forEach((id) => { if (level[id] === undefined) level[id] = 0; });
    const cols: string[][] = [];
    ids.forEach((id) => { (cols[level[id]] ??= []).push(id); });
    const W = 170, H = 46, GX = 90, GY = 34;
    const maxRows = Math.max(1, ...cols.map((c) => c?.length ?? 0));
    const pos: Record<string, { x: number; y: number }> = {};
    cols.forEach((c, ci) => c?.forEach((id, ri) => {
      const offset = ((maxRows - c.length) * (H + GY)) / 2;
      pos[id] = { x: 20 + ci * (W + GX), y: 20 + offset + ri * (H + GY) };
    }));
    return { pos, W, H, width: 40 + cols.length * (W + GX) - GX, height: 40 + maxRows * (H + GY) - GY };
  }, [diagram]);
  const label = (id: string) => diagram.nodes.find((n) => n.id === id)?.label ?? id;
  const clip = (s: string, n = 24) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const { pos, W, H } = layout;
  return (
    <figure data-testid="diagram" className="rounded-xl border bg-card p-4 sm:p-5">
      <figcaption className="mb-1 font-display text-base font-semibold">{diagram.title}</figcaption>
      <p className="mb-3 text-sm text-muted-foreground">{diagram.description}</p>
      <p className="mb-3 inline-block rounded bg-muted px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Conceptual relationships, not measured data</p>
      <div className="grid-paper overflow-x-auto rounded-lg border">
        <svg role="img" aria-label={diagram.title} viewBox={`0 0 ${layout.width} ${layout.height}`} width={layout.width} height={layout.height} className="max-w-none">
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 z" fill="hsl(222 40% 30%)" />
            </marker>
          </defs>
          {diagram.edges.map((e, i) => {
            const a = pos[e.from], b = pos[e.to];
            if (!a || !b) return null;
            const forward = b.x > a.x;
            const x1 = forward ? a.x + W : a.x + W / 2, y1 = forward ? a.y + H / 2 : a.y + H;
            const x2 = forward ? b.x : b.x + W / 2, y2 = forward ? b.y + H / 2 : b.y;
            const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
            const d = forward ? `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}` : `M${x1} ${y1} Q${x1 + 60} ${my} ${x2} ${y2}`;
            return (
              <g key={i}>
                <path d={d} fill="none" stroke="hsl(222 40% 30%)" strokeWidth="1.4" markerEnd="url(#arrow)" />
                {e.label && (
                  <text x={mx} y={my - 5} textAnchor="middle" fontSize="10" fontFamily="JetBrains Mono" fill="hsl(153 57% 24%)" paintOrder="stroke" stroke="hsl(40 33% 96%)" strokeWidth="3">
                    {clip(e.label, 22)}
                  </text>
                )}
              </g>
            );
          })}
          {diagram.nodes.map((n) => {
            const p = pos[n.id];
            return (
              <g key={n.id}>
                <title>{n.label}</title>
                <rect x={p.x} y={p.y} width={W} height={H} rx="8" fill="hsl(222 40% 14%)" />
                <rect x={p.x} y={p.y} width="4" height={H} rx="2" fill="hsl(153 57% 40%)" />
                <text x={p.x + W / 2 + 2} y={p.y + H / 2 + 4} textAnchor="middle" fontSize="12" fontFamily="Source Sans 3" fill="hsl(40 33% 96%)">{clip(n.label)}</text>
              </g>
            );
          })}
        </svg>
      </div>
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Relationships as text</summary>
        <ul className="mt-2 space-y-1 font-mono text-xs">
          {diagram.edges.map((e, i) => <li key={i}>{label(e.from)} → {label(e.to)}{e.label ? `: ${e.label}` : ""}</li>)}
        </ul>
      </details>
    </figure>
  );
}
