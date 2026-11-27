import { z } from "zod";
import type { Dataset } from "./validation";
import { ToolError } from "../elexon";
import { questionInterval } from "./dates";

const field = z.string().min(1).max(160).refine((s) => !["__proto__", "constructor", "prototype"].includes(s));
export const calculationSchema = z.object({
  datasetId: field,
  groupBy: z.array(field).max(4).default([]),
  filters: z.array(z.object({
    key: field, operator: z.enum(["eq", "ne", "gt", "gte", "lt", "lte"]),
    value: z.union([z.string(), z.number().finite(), z.boolean()]),
  }).strict()).max(20).default([]),
  timeBucket: z.object({ key: field, period: z.enum(["day", "month"]) }).strict().optional(),
  measures: z.array(z.object({
    key: field.optional(), name: field,
    operation: z.enum(["count", "sum", "mean", "min", "max", "energy", "weighted_mean"]),
    weightKey: field.optional(),
    shareOfTotal: z.boolean().optional(),
  }).strict()).min(1).max(12),
  sort: z.object({ key: field, direction: z.enum(["asc", "desc"]) }).strict().optional(),
}).strict();
export type Calculation = z.infer<typeof calculationSchema>;

// A restricted relational calculation language, never executable model code.
export const calculationTool = {
  type: "function" as const,
  function: {
    name: "calculate_dataset",
    description: "Calculate over ALL saved rows, not samples. Filter, group, bucket timestamps by UTC day/month, aggregate, rank by sorting, compare categories and optionally calculate shares. Returns a derived dataset usable in more calculations, charts, metrics and exports. Operations: count, sum, mean, min, max, weighted_mean (weightKey required), energy (integrates MW over verified intervals into MWh). Never sum MW across time for energy; use energy. Missing values are not zero. Fuel energy rankings automatically include coverage checks. Do required preprocessing before answering; never ask the user to aggregate retrieved data.",
    parameters: {
      type: "object", additionalProperties: false, required: ["datasetId", "measures"],
      properties: {
        datasetId: { type: "string" },
        groupBy: { type: "array", items: { type: "string" } },
        filters: { type: "array", items: { type: "object", additionalProperties: false, required: ["key", "operator", "value"], properties: {
          key: { type: "string" }, operator: { type: "string", enum: ["eq", "ne", "gt", "gte", "lt", "lte"] },
          value: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] },
        } } },
        timeBucket: { type: "object", additionalProperties: false, required: ["key", "period"], properties: { key: { type: "string" }, period: { type: "string", enum: ["day", "month"] } } },
        measures: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "operation"], properties: {
          key: { type: "string" }, name: { type: "string" },
          operation: { type: "string", enum: ["count", "sum", "mean", "min", "max", "energy", "weighted_mean"] },
          weightKey: { type: "string" }, shareOfTotal: { type: "boolean" },
        } } },
        sort: { type: "object", additionalProperties: false, required: ["key", "direction"], properties: { key: { type: "string" }, direction: { type: "string", enum: ["asc", "desc"] } } },
      },
    },
  },
};

export function fuelEnergyIntent(question: string) {
  return /\b(energy|generation|electricity)\b/i.test(question)
    && /\b(fuel|categor(?:y|ies)|mix|producer|produces|produced)\b/i.test(question)
    && /\b(biggest|largest|most|top|rank|total|energy|share)\b/i.test(question);
}
export function fuelQuestion(question: string) {
  return (/\bgeneration\b/i.test(question) && /\bfuel\b|\bmix\b/i.test(question)) || fuelEnergyIntent(question);
}

export function calculateDataset(source: Dataset, raw: unknown, id: string): Dataset {
  const spec = calculationSchema.parse(raw);
  const columns = new Map(source.columns.map((c) => [c.key, c.unit]));
  const requireKey = (key: string | undefined) => {
    if (!key || !columns.has(key)) throw new ToolError(`Calculation references an unavailable field: ${key ?? "(missing)"}.`);
    return key;
  };
  spec.groupBy.forEach(requireKey);
  spec.filters.forEach((f) => requireKey(f.key));
  if (spec.timeBucket) {
    requireKey(spec.timeBucket.key);
    if (spec.groupBy.includes(spec.timeBucket.key)) throw new ToolError("Do not also group by the unbucketed timestamp.");
  }
  const outputKeys = [...spec.groupBy, ...(spec.timeBucket ? [spec.timeBucket.key] : []), ...spec.measures.flatMap((m) => [m.name, ...(m.shareOfTotal ? [`${m.name}SharePercent`] : [])])];
  if (new Set(outputKeys).size !== outputKeys.length) throw new ToolError("Calculation output fields must have distinct names.");
  const warnings: string[] = [];
  const units = spec.measures.map((m) => {
    if (m.operation === "count") return "index / count";
    const key = requireKey(m.key), unit = columns.get(key)!;
    const previous = source.metadata?.calculation as Calculation | undefined;
    const computedCount = unit === "index / count" && previous?.measures?.some((m) => m.name === key && m.operation === "count");
    if (unit === "not specified" || (unit === "index / count" && !computedCount)) throw new ToolError(`A documented measure unit is required for ${key}.`);
    if (m.operation === "sum" && /^(MW|Hz|GBP\/MWh)$/i.test(unit)) throw new ToolError(`Do not sum ${unit} observations. Use energy for MW over time, or a meaningful mean.`);
    if (m.operation === "energy" && unit !== "MW") throw new ToolError("Energy integration requires measured power in MW; existing MWh measures can be summed.");
    if (m.operation === "weighted_mean") requireKey(m.weightKey);
    if (m.shareOfTotal && !["sum", "energy", "count"].includes(m.operation)) throw new ToolError("Shares require additive totals, not means or extrema.");
    return m.operation === "energy" ? "MWh" : unit;
  });
  const range = source.metadata?.requestedInterval as { from?: number; to?: number } | undefined;
  const rows = source.rows.filter((row) => spec.filters.every((f) => {
    const v = row[f.key];
    if (v == null) return false;
    if (f.operator === "eq") return v === f.value;
    if (f.operator === "ne") return v !== f.value;
    if (typeof v !== typeof f.value || (typeof v !== "number" && typeof v !== "string")) return false;
    const comparison = typeof v === "number" && typeof f.value === "number" ? Math.sign(v - f.value) : String(v).localeCompare(String(f.value));
    return f.operator === "gt" ? comparison > 0 : f.operator === "gte" ? comparison >= 0 : f.operator === "lt" ? comparison < 0 : comparison <= 0;
  }));
  type Accumulator = { sum: number; count: number; min: number; max: number; weight: number; hours: number; seen: Map<string, number> };
  const groups = new Map<string, { row: Record<string, unknown>; values: Accumulator[] }>();
  let skipped = 0, duplicates = 0;
  for (const row of rows) {
    const labels: Record<string, unknown> = Object.fromEntries(spec.groupBy.map((key) => [key, row[key] ?? null]));
    if (spec.timeBucket) {
      const time = typeof row[spec.timeBucket.key] === "string" ? Date.parse(String(row[spec.timeBucket.key])) : NaN;
      if (!Number.isFinite(time)) { skipped++; continue; }
      labels[spec.timeBucket.key] = new Date(time).toISOString().slice(0, spec.timeBucket.period === "month" ? 7 : 10);
    }
    const groupId = JSON.stringify(Object.values(labels));
    let group = groups.get(groupId);
    if (!group) {
      group = { row: labels, values: spec.measures.map(() => ({ sum: 0, count: 0, min: Infinity, max: -Infinity, weight: 0, hours: 0, seen: new Map() })) };
      groups.set(groupId, group);
    }
    for (const [i, measure] of spec.measures.entries()) {
      const acc = group.values[i];
      const value = measure.operation === "count" ? 1 : row[measure.key!];
      if (typeof value !== "number" || !Number.isFinite(value)) { skipped++; continue; }
      let weight = 1;
      if (measure.operation === "weighted_mean") {
        const w = row[measure.weightKey!];
        if (typeof w !== "number" || !Number.isFinite(w) || w < 0) throw new ToolError("Weights must be finite nonnegative numbers; missing weights cannot be treated as zero.");
        weight = w;
      }
      if (measure.operation === "energy") {
        const start = typeof row.startTime === "string" ? Date.parse(row.startTime) : NaN;
        // Only FUELHH has the documented fixed half-hour duration. Never infer
        // a duration by bridging missing observations or integrate instantaneous power.
        const halfHourly = /^elexon_get_datasets_fuelhh(?:_stream)?$/.test(source.tool);
        const end = typeof row.endTime === "string" ? Date.parse(row.endTime) : halfHourly ? start + 1800000 : NaN;
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || (!halfHourly && !row.endTime)) throw new ToolError("Energy needs verified interval start/end times or the documented half-hourly FUELHH source. Instantaneous readings cannot be integrated by assuming a duration.");
        if (halfHourly && (start % 1800000 !== 0 || end - start !== 1800000)) throw new ToolError("FUELHH energy requires aligned, non-overlapping half-hour intervals.");
        if (spec.timeBucket && spec.timeBucket.key === "startTime") {
          const length = spec.timeBucket.period === "month" ? 7 : 10;
          if (new Date(start).toISOString().slice(0, length) !== new Date(end - 1).toISOString().slice(0, length)) throw new ToolError("This interval crosses the requested bucket boundary; split it by verified duration before bucketing energy.");
        }
        const a = Math.max(start, range?.from ?? -Infinity), b = Math.min(end, range?.to ?? Infinity);
        if (b <= a) continue;
        const identity = JSON.stringify([row.fuelType ?? "", row.psrType ?? "", row.bmUnit ?? "", start, end]);
        const previous = acc.seen.get(identity);
        if (previous !== undefined) {
          if (previous !== value) throw new ToolError("Conflicting observations/revisions occupy the same category and interval. Resolve the source revision or entity filters before calculating energy.");
          duplicates++;
          continue;
        }
        acc.seen.set(identity, value);
        weight = (b - a) / 3600000;
        acc.hours += weight;
      }
      acc.sum += value * weight;
      acc.weight += weight;
      acc.count++;
      acc.min = Math.min(acc.min, value);
      acc.max = Math.max(acc.max, value);
    }
  }
  const output = [...groups.values()].map(({ row, values }) => {
    for (const [i, m] of spec.measures.entries()) {
      const a = values[i];
      row[m.name] = !a.count ? null : m.operation === "mean" ? a.sum / a.count
        : m.operation === "weighted_mean" ? a.weight > 0 ? a.sum / a.weight : null
        : m.operation === "min" ? a.min : m.operation === "max" ? a.max : a.sum;
    }
    return row;
  });
  for (const m of spec.measures.filter((m) => m.shareOfTotal)) {
    const values = output.map((r) => r[m.name]);
    if (values.some((v) => typeof v === "number" && v < 0)) throw new ToolError("Signed totals do not form nonnegative shares. Retain signed values and use totals or a bar chart instead.");
    const total = values.reduce<number>((s, v) => s + (typeof v === "number" ? v : 0), 0);
    for (const row of output) row[`${m.name}SharePercent`] = total > 0 && typeof row[m.name] === "number" ? Number(row[m.name]) / total * 100 : null;
  }
  if (spec.sort) {
    if (!outputKeys.includes(spec.sort.key)) throw new ToolError("Sort must reference a calculation output field.");
    const { key, direction } = spec.sort;
    output.sort((a, b) => a[key] == null ? 1 : b[key] == null ? -1 : (typeof a[key] === "number" && typeof b[key] === "number" ? Number(a[key]) - Number(b[key]) : String(a[key]).localeCompare(String(b[key]))) * (direction === "desc" ? -1 : 1));
  }
  if (skipped) warnings.push(`${skipped} missing/invalid measure or timestamp values were excluded, not replaced with zero.`);
  if (duplicates) warnings.push(`${duplicates} identical duplicate interval observations were counted once.`);
  if (spec.measures.some((m) => m.operation === "mean")) warnings.push("Means are arithmetic, not time-weighted.");
  if (spec.measures.some((m) => m.operation === "energy")) warnings.push("Energy = sum of interval-average MW × interval hours; signed flows retained. Missing intervals are not interpolated or extrapolated.");
  const coverage = [...groups.values()].map((g) => ({ category: g.row, observations: g.values[0]?.count ?? 0, observedHours: g.values[0]?.hours ?? 0 }));
  if (range && spec.measures.some((m) => m.operation === "energy")) {
    const expectedHours = (Number(range.to) - Number(range.from)) / 3600000;
    if (coverage.some((c) => c.observedHours < expectedHours - 1e-6)) warnings.push("Some category intervals are missing or unpublished relative to the requested range. Totals and rankings apply only to observed records, not a proven complete period.");
  } else if (spec.measures.some((m) => m.operation === "energy")) {
    warnings.push("Requested interval coverage is unverified; totals and rankings apply only to retrieved observations, not a proven complete period.");
  }
  return {
    ...source, id, rows: output, count: output.length, totalCount: output.length, nextOffset: null,
    columns: [
      ...[...spec.groupBy, ...(spec.timeBucket ? [spec.timeBucket.key] : [])].map((key) => ({ key, unit: spec.timeBucket?.key === key ? "UTC calendar bucket" : columns.get(key)! })),
      ...spec.measures.flatMap((m, i) => [{ key: m.name, unit: units[i] }, ...(m.shareOfTotal ? [{ key: `${m.name}SharePercent`, unit: "%" }] : [])]),
    ],
    metadata: { ...source.metadata, calculation: spec, sourceDatasetId: source.id, warnings, groupCoverage: coverage },
    note: `Calculated from all ${source.rows.length} retrieved rows of ${source.id}; ${rows.length} rows passed filters. ${JSON.stringify(spec)} ${warnings.join(" ")} Source: ${source.sourceUrl}`,
  };
}

export function automaticFuelCalculation(source: Dataset, question: string, id: string): Dataset | undefined {
  if (!fuelEnergyIntent(question) || !/^elexon_get_datasets_fuelhh(?:_stream)?$/.test(source.tool)) return;
  const group = ["fuelType", "psrType"].find((key) => source.columns.some((c) => c.key === key));
  const measure = ["generation", "quantity"].find((key) => source.columns.some((c) => c.key === key && c.unit === "MW"));
  if (!group || !measure || !source.rows.length) return;
  const result = calculateDataset(source, {
    datasetId: source.id, groupBy: [group],
    measures: [{ key: measure, name: "energyMWh", operation: "energy" }],
    sort: { key: "energyMWh", direction: "desc" },
  }, id);
  const interval = questionInterval(question);
  result.metadata = { ...result.metadata, automaticFuelRanking: true, ...(interval ? { requestedQuestionInterval: interval } : {}) };
  return result;
}
