import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ApiMonitorBucket, ApiMonitorTarget } from "@workspace/api-client-react";

const COLORS = ["hsl(222 40% 22%)", "hsl(174 55% 34%)", "hsl(153 57% 32%)", "hsl(42 85% 45%)"];

type Row = Record<string, number | null>;

export function buildRows(series: ApiMonitorBucket[], targets: ApiMonitorTarget[], bucketSeconds: number, field: "uptimePercent" | "meanResponseMs" | "p95ResponseMs" | "coveragePercent") {
  const map = new Map<number, Row>();
  for (const b of series) {
    const t = Date.parse(b.at);
    const row = map.get(t) ?? { t };
    row[b.target] = b[field] ?? null;
    map.set(t, row);
  }
  const sorted = [...map.values()].sort((a, b) => (a.t as number) - (b.t as number));
  const out: Row[] = [];
  const gap = bucketSeconds * 1000 * 1.5;
  sorted.forEach((r, i) => {
    for (const tg of targets) if (!(tg.id in r)) r[tg.id] = null;
    if (i > 0 && (r.t as number) - (sorted[i - 1].t as number) > gap) {
      const blank: Row = { t: ((r.t as number) + (sorted[i - 1].t as number)) / 2 };
      for (const tg of targets) blank[tg.id] = null;
      out.push(blank);
    }
    out.push(r);
  });
  return out;
}

function fmtTick(days: number) {
  return (v: number) => {
    const d = new Date(v);
    if (days <= 1) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (days <= 90) return d.toLocaleDateString([], { day: "numeric", month: "short" });
    return d.toLocaleDateString([], { month: "short", year: "2-digit" });
  };
}

export function MetricChart({ rows, targets, unit, days, from, to, domain, testId }: {
  rows: Row[]; targets: ApiMonitorTarget[]; unit: "%" | "ms"; days: number; from: string; to: string; domain?: [number, number]; testId: string;
}) {
  const fmt = (v: number) => (unit === "%" ? `${v.toFixed(v >= 99.95 || v === 0 ? 0 : 2)}%` : `${Math.round(v).toLocaleString()} ms`);
  return (
    <div data-testid={testId} className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="hsl(35 18% 86%)" strokeDasharray="2 4" vertical={false} />
          <XAxis dataKey="t" type="number" scale="time" domain={[Date.parse(from), Date.parse(to)]} tickFormatter={fmtTick(days)} tick={{ fontSize: 11, fontFamily: "JetBrains Mono" }} stroke="hsl(222 12% 55%)" minTickGap={28} />
          <YAxis type="number" domain={domain ?? [0, "auto"]} tickFormatter={(v: number) => (unit === "%" ? `${v}%` : `${v}`)} tick={{ fontSize: 11, fontFamily: "JetBrains Mono" }} stroke="hsl(222 12% 55%)" width={52} label={unit === "ms" ? { value: "ms", angle: -90, position: "insideLeft", fontSize: 11 } : undefined} />
          <Tooltip
            labelFormatter={(v: number) => new Date(v).toLocaleString()}
            formatter={(v: unknown, name: string) => [typeof v !== "number" ? "no data" : fmt(v), targets.find((t) => t.id === name)?.name ?? name]}
            contentStyle={{ background: "hsl(40 40% 99%)", border: "1px solid hsl(35 18% 84%)", borderRadius: 8, fontSize: 12 }}
          />
          <Legend formatter={(v: string) => targets.find((t) => t.id === v)?.name ?? v} wrapperStyle={{ fontSize: 12 }} />
          {targets.map((tg, i) => (
            <Line key={tg.id} dataKey={tg.id} type="linear" stroke={COLORS[i % COLORS.length]} strokeWidth={1.75} dot={rows.filter((row) => typeof row[tg.id] === "number").length < 12} connectNulls={false} isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
