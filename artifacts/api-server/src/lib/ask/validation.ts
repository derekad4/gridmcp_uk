import { z } from "zod";
import { GetAskAnswerResponse } from "@workspace/api-zod";
import { ToolError } from "../elexon";
import { questionInterval } from "./dates";
import { categoryLabel } from "@workspace/elexon-labels";
import { fulfilVisualRequests } from "./visual-requests";

export const answerSchema = GetAskAnswerResponse;
export type Answer = z.infer<typeof answerSchema>;
export type Dataset = Answer["datasets"][number];
export type Chart = Answer["charts"][number];
const short = z.string().min(1).max(160);
export const planSchema = z.object({
  title: short,
  narrative: z.string().max(5000),
  limitations: z.array(z.string().max(600)).max(12),
  views: z.array(z.object({
    datasetId: short, title: short,
    kind: z.enum(["line", "area", "bar", "composition", "pie", "donut", "horizontalBar", "stackedBar", "stackedArea", "scatter"]),
    xKey: short, yKey: short, groupKey: short.optional(),
    aggregation: z.enum(["none", "sum", "mean"]),
  }).strict()),
  metrics: z.array(z.object({ datasetId: short, key: short, calculation: z.enum(["mean", "min", "max"]) }).strict()).optional(),
  diagram: z.boolean(),
}).strict();
export type Plan = z.infer<typeof planSchema>;

function flatten(row: Record<string, unknown>, prefix = "", result: Record<string, unknown> = {}, depth = 0) {
  for (const [key, value] of Object.entries(row)) {
    const field = prefix ? `${prefix}.${key}` : key;
    if (["__proto__", "constructor", "prototype"].includes(key)) continue;
    if (value && typeof value === "object" && !Array.isArray(value) && depth < 4) flatten(value as Record<string, unknown>, field, result, depth + 1);
    else Object.defineProperty(result, field, { enumerable: true, configurable: true, writable: true, value: value && typeof value === "object" ? JSON.stringify(value) : value ?? null });
  }
  return result;
}
export function unitFor(key: string, rows: Record<string, unknown>[], description: string) {
  const measure = /quantity|generation|demand|output|volume|capacity|frequency|price/i.test(key);
  const reported = [...new Set(rows.map((r) => String(r[`${key}Unit`] ?? r.unit ?? r.units ?? "")).filter(Boolean))];
  if (measure && reported.length > 1) return "not specified";
  if (measure && reported.length === 1 && reported[0].length < 40) return reported[0];
  // The pinned FREQ dataset description documents transmission system frequency in hertz,
  // including the same observation field served by /system/frequency.
  if (key === "frequency") return "Hz";
  if (/price/i.test(key) && /GBP|£|system.*price/i.test(description)) return "GBP/MWh";
  if (/^(settlementPeriod|revisionNumber|version|id|count|offset|limit)$/i.test(key)) return "index / count";
  if (/quantity|generation|demand|output|volume|capacity|frequency/i.test(key)) {
    const units = [...new Set(rows.map((r) => String(r[`${key}Unit`] ?? r.unit ?? r.units ?? "")).filter(Boolean))];
    if (units.length === 1 && units[0].length < 40) return units[0];
    const documented = [...new Set(description.match(/\b(?:GBP\/MWh|MWh|MW|Hz|kV)\b/g) ?? [])];
    if (documented.length === 1) return documented[0];
  }
  return "not specified";
}
export function normalizeResult(raw: unknown, args: Record<string, unknown>, id: string, description: string): Dataset {
  const result = z.object({
    tool: z.string(), sourceUrl: z.string().url(), fetchedAt: z.string(),
    data: z.array(z.record(z.unknown())).max(500), totalCount: z.number().int().nonnegative(),
    truncated: z.boolean(), note: z.string().optional(),
  }).passthrough().parse(raw);
  if (new URL(result.sourceUrl).hostname !== "data.elexon.co.uk") throw new ToolError("Unexpected tool source was rejected.", 502);
  const expanded = result.data.flatMap((row) => {
    const { data, ...parent } = row;
    return Array.isArray(data) && data.every((v) => v && typeof v === "object" && !Array.isArray(v))
      ? data.map((v) => flatten({ ...parent, ...v as Record<string, unknown> }))
      : [flatten(row)];
  });
  let clippedCells = false;
  const rows: Record<string, unknown>[] = [];
  for (const row of expanded) {
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === "string" && value.length > 12000) {
        row[key] = `${value.slice(0, 12000)} [VALUE TRUNCATED]`;
        clippedCells = true;
      }
    }
    rows.push(row);
  }
  const allKeys = [...new Set(rows.flatMap(Object.keys))];
  const keys = allKeys;
  const filtered = rows.map((r) => Object.fromEntries(keys.map((key) => [key, r[key] ?? null])));
  const dates = filtered.flatMap((r) => Object.entries(r).filter(([k, v]) => /time|date/i.test(k) && typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)).map(([, v]) => String(v))).sort();
  const additionalLimit = rows.length < expanded.length || keys.length < allKeys.length || clippedCells;
  const metadataText = JSON.stringify(result.metadata ?? {});
  const metadata = metadataText.length <= 8000 ? (result.metadata ?? {}) as Record<string, unknown> : { boundedMetadataPreview: metadataText.slice(0, 8000), incomplete: true };
  return {
    id, tool: result.tool, sourceUrl: result.sourceUrl, fetchedAt: result.fetchedAt,
    arguments: args, rows: filtered, metadata,
    nextOffset: typeof result.nextOffset === "number" ? result.nextOffset : null,
    columns: keys.map((key) => ({ key, unit: unitFor(key, filtered, description) })),
    count: filtered.length, totalCount: Math.max(result.totalCount, expanded.length),
    truncated: result.truncated || additionalLimit || metadataText.length > 8000,
    coverage: dates.length ? `${dates[0]} through ${dates.at(-1)} (observed date/time fields; query filters below define requested coverage)` : "No observed date range in returned rows; see exact query filters.",
    note: `${result.note ?? ""}${keys.includes("frequency") ? " Frequency unit: Hz, as documented for FREQ in the pinned Elexon catalog (https://data.elexon.co.uk/bmrs/api/v1/datasets/FREQ)." : ""}${additionalLimit ? " Additional cell content beyond 12,000 characters was omitted." : ""} Nested objects flattened; arrays retained as JSON unless a data array contains records. Missing values are null, not zero.`,
  };
}
export function numericKeys(d: Dataset) {
  const calculation = (d.metadata?.sourceDatasetId ? d.metadata.calculation : undefined) as { measures?: { name?: string }[] } | undefined;
  const calculatedMeasures = new Set(calculation && Array.isArray(calculation.measures) ? calculation.measures.map((m) => m.name) : []);
  return d.columns.filter(({ key }) => d.rows.some((r) => typeof r[key] === "number") && (calculatedMeasures.has(key) || !/period|revision|version|^id$|offset|count|index/i.test(key))).map((c) => c.key);
}
export function datasetStats(d: Dataset, key: string) {
  const values = d.rows.map((row, index) => ({ value: row[key], row, index })).filter((v): v is { value: number; row: Record<string, unknown>; index: number } => typeof v.value === "number" && Number.isFinite(v.value));
  if (!values.length) return undefined;
  const ordered = [...values].sort((a, b) => a.value - b.value);
  const context = (entry: typeof values[number]) => ({
    savedRow: entry.index + 1,
    ...Object.fromEntries(Object.entries(entry.row).filter(([field, v]) => /time|date|period|fuel|psr|type|name|unit/i.test(field) && v != null).slice(0, 6).map(([field, v]) => [field, String(v).slice(0, 100)])),
  });
  return {
    count: values.length, mean: values.reduce((s, v) => s + v.value, 0) / values.length,
    min: ordered[0].value, minContext: context(ordered[0]),
    max: ordered.at(-1)!.value, maxContext: context(ordered.at(-1)!),
  };
}
export function makeView(source: Dataset, view: Plan["views"][number], index: number): { dataset: Dataset; chart: Chart } {
  const keys = new Set(source.columns.map((c) => c.key));
  if (!keys.has(view.xKey) || !numericKeys(source).includes(view.yKey) || (view.groupKey && !keys.has(view.groupKey))) throw new ToolError("The requested visual referenced unavailable data columns.", 502);
  const unit = source.columns.find((c) => c.key === view.yKey)!.unit;
  if (unit === "not specified") throw new ToolError(`Cannot chart ${view.yKey}: its unit is not documented in the returned data or tool description.`, 422);
  if (view.aggregation === "sum" && /price|GBP\/MWh|Hz/i.test(`${view.yKey} ${unit}`)) throw new ToolError("Summing prices or frequency is not a meaningful supported calculation. Select individual observations or an explicitly scoped mean.", 422);
  if (view.aggregation === "sum" && unit === "MW" && !/time|period/i.test(view.xKey)) {
    const timeKeys = source.columns.map((c) => c.key).filter((key) => /^(startTime|measurementTime|settlementPeriod)$/i.test(key));
    if (timeKeys.some((key) => new Set(source.rows.map((r) => r[key]).filter((v) => v != null)).size > 1)) throw new ToolError("Power in MW cannot be summed across time into an energy total. Use a single observation time or a scoped mean; MWh needs interval-duration integration.", 422);
  }
  const groups = new Map<string, Map<string, number[]>>();
  if (view.kind === "scatter" && source.rows.some((r) => r[view.xKey] != null && (typeof r[view.xKey] !== "number" || !Number.isFinite(r[view.xKey])))) throw new ToolError("Scatter plots require measured numeric x values.", 422);
  const series = new Set<string>();
  for (const row of source.rows) {
    const x = row[view.xKey], value = row[view.yKey];
    if (x == null || typeof value !== "number" || !Number.isFinite(value)) continue;
    const name = view.groupKey ? String(row[view.groupKey] ?? "Unspecified") : view.yKey;
    if (name.length > 80) throw new ToolError("A category label exceeds the supported chart length. The full value remains in the data table.", 422);
    series.add(name);
    if (series.size > 16) throw new ToolError("This visual has more than 16 series. Narrow the category filters.", 422);
    const key = String(x);
    if (!groups.has(key)) groups.set(key, new Map());
    const bucket = groups.get(key)!;
    if (!bucket.has(name)) bucket.set(name, []);
    bucket.get(name)!.push(value);
  }
  if (!groups.size) throw new ToolError("No numeric values were returned for this visual.", 422);
  const yKeys = [...series].map((name) => `Measure: ${name}`);
  const rows = [...groups].map(([x, values]) => {
    const row: Record<string, unknown> = { [view.xKey]: view.kind === "scatter" ? Number(x) : x };
    [...series].forEach((name, i) => {
      const vals = values.get(name) ?? [];
      if (view.aggregation === "none" && vals.length > 1) throw new ToolError("Duplicate x/category values require an explicit sum or mean; no implicit aggregation was used.", 422);
      row[yKeys[i]] = vals.length ? view.aggregation === "mean" ? vals.reduce((a, b) => a + b, 0) / vals.length : view.aggregation === "sum" ? vals.reduce((a, b) => a + b, 0) : vals[0] : null;
    });
    return row;
  });
  // Calculated rankings already have a deliberate order; do not turn them
  // back into alphabetical charts. Raw observations still sort by x/time.
  if (!(source.metadata?.calculation as { sort?: unknown } | undefined)?.sort) rows.sort((a, b) => String(a[view.xKey]).localeCompare(String(b[view.xKey]), undefined, { numeric: true }));
  if (["composition", "pie", "donut"].includes(view.kind) && (yKeys.length !== 1 || rows.some((r) => Number(r[yKeys[0]]) < 0) || rows.reduce((s, r) => s + Number(r[yKeys[0]] ?? 0), 0) <= 0 || rows.some((r) => /^\d{4}-\d\d-\d\d/.test(String(r[view.xKey]))))) throw new ToolError("Composition needs categorical parts of a nonnegative whole with a positive total; use bar or line for signed values or observations across time.", 422);
  if (view.kind === "scatter" && rows.some((r) => typeof r[view.xKey] !== "number" || !Number.isFinite(r[view.xKey]))) throw new ToolError("Scatter plots require a numeric x measure, not categories or timestamp strings.", 422);
  if (["stackedArea", "stackedBar"].includes(view.kind) && rows.some((r) => yKeys.some((key) => Number(r[key]) < 0))) throw new ToolError("Nonnegative stacked charts cannot represent signed flows. Use separate series or signed bars.", 422);
  if (["stackedArea", "stackedBar"].includes(view.kind) && rows.some((r) => yKeys.some((key) => r[key] == null))) throw new ToolError("Stacked charts require aligned observed values for each part. Missing observations cannot be filled with zero; use separate lines.", 422);
  const id = `${source.id}_view_${index + 1}`;
  return {
    dataset: { ...source, id, rows, count: rows.length, columns: [{ key: view.xKey, unit: view.kind === "scatter" ? source.columns.find((c) => c.key === view.xKey)!.unit : "category / time" }, ...yKeys.map((key) => ({ key, unit }))], metadata: { ...source.metadata, visualAggregation: view.aggregation, visualSourceDatasetId: source.id }, note: `${source.note} Derived view: ${view.aggregation} of ${view.yKey}, grouped by ${view.xKey}${view.groupKey ? ` and ${view.groupKey}` : ""}. Series mapping: ${yKeys.map((k, i) => `${k} = ${[...series][i]}`).join("; ")}. Computed only from the bounded returned rows, not the entire market.` },
    chart: { title: `${/\d/.test(view.title) ? `Measured ${view.yKey}` : view.title} (${[...series].join(", ")})`, kind: view.kind, datasetId: id, xKey: view.xKey, yKeys, unit },
  };
}
export function buildAnswer(id: string, question: string, plan: Plan, datasets: Dataset[], tokens: number): Answer {
  const limitations = [...plan.limitations];
  const charts: Chart[] = [];
  const derived: Dataset[] = [];
  const fuelRankings = datasets.filter((d) => d.metadata?.automaticFuelRanking === true);
  const ranking = fuelRankings.length === 1 ? fuelRankings[0] : undefined;
  // A single verified source is unambiguous even if the model writes its tool
  // name or a display alias instead of query_1. Never guess between sources.
  const resolveSource = (reference: string) => datasets.find((d) => d.id === reference)
    ?? (datasets.filter((d) => d.tool === reference).length === 1 ? datasets.find((d) => d.tool === reference) : undefined)
    ?? (datasets.length === 1 ? datasets[0] : undefined);
  for (const [i, view] of plan.views.entries()) {
    const source = resolveSource(view.datasetId);
    if (!source) { limitations.push("A requested visual referenced an unavailable query and was omitted."); continue; }
    try { const result = makeView(source, view, i); charts.push(result.chart); derived.push(result.dataset); }
    catch (error) {
      if (["composition", "pie", "donut"].includes(view.kind)) {
        try {
          const fallback = makeView(source, { ...view, kind: "bar", aggregation: "mean", title: `${view.title} — arithmetic mean output` }, i);
          charts.push(fallback.chart);
          derived.push(fallback.dataset);
          limitations.push("A signed bar chart of arithmetic mean output over the retrieved observations replaces the requested composition: negative values or multiple observation times do not form a nonnegative single-moment share. Negative flows are retained, not discarded; means are not energy shares or time-weighted.");
          continue;
        } catch { /* Preserve the original validation explanation below. */ }
      }
      limitations.push(error instanceof ToolError ? error.message : "A visual could not be validated against the source data.");
    }
  }
  if (ranking && !charts.some((c) => derived.find((d) => d.id === c.datasetId)?.metadata?.automaticFuelRanking)) {
    const key = ranking.columns.some((c) => c.key === "fuelType") ? "fuelType" : "psrType";
    try {
      const result = makeView(ranking, { datasetId: ranking.id, title: "Measured electrical energy by category, including signed interconnector flows", kind: "bar", xKey: key, yKey: "energyMWh", aggregation: "none" }, plan.views.length + charts.length);
      charts.unshift(result.chart);
      derived.push(result.dataset);
    } catch (error) {
      limitations.push(error instanceof ToolError ? error.message : "The calculated fuel totals did not contain chartable observations.");
    }
  }
  if (!charts.length && /\b(plot|graph|chart|dashboard|composition)\b/i.test(question) && /\bfuel\b|\bgeneration mix\b/i.test(question)) {
    const interval = questionInterval(question);
    const fuelSources = datasets.filter((d) => /^(?:elexon_get_datasets_fuel(?:hh|inst)(?:_stream)?|get_generation_by_fuel)$/.test(d.tool) && d.rows.length);
    const matches = fuelSources.filter((d) => {
      const range = d.metadata?.requestedInterval as { from?: unknown; to?: unknown } | undefined;
      return interval && range?.from === interval.from && range?.to === interval.to;
    });
    // Prefer one source verified against the exact requested interval. Never
    // guess between multiple unrelated sources to repair an invalid model view.
    const source = matches.length === 1 ? matches[0] : fuelSources.length === 1 ? fuelSources[0] : undefined;
    if (source) {
      const xKey = ["fuelType", "psrType"].find((key) => source.columns.some((c) => c.key === key));
      const yKey = ["generation", "quantity"].find((key) => numericKeys(source).includes(key));
      if (xKey && yKey) {
        try {
          const fallback = makeView(source, { datasetId: source.id, title: "Mean measured generation by fuel across the retrieved interval", kind: "bar", xKey, yKey, aggregation: "mean" }, plan.views.length);
          charts.push(fallback.chart);
          derived.push(fallback.dataset);
          limitations.push("A validated bar chart of arithmetic mean measured output by fuel replaces the missing or invalid generated visual. Signed flows are retained. Means cover the retrieved observations only, are not time-weighted, and are not energy shares.");
        } catch (error) {
          limitations.push(error instanceof ToolError ? error.message : "The verified fuel data could not support a fallback chart.");
        }
      }
    }
  }
  const requestedMetrics = plan.metrics ?? datasets.flatMap((d) => numericKeys(d).slice(0, 1).flatMap((key) => (["mean", "min", "max"] as const).map((calculation) => ({ datasetId: d.id, key, calculation }))));
  const metrics: Answer["metrics"] = requestedMetrics.flatMap((m) => {
    const d = resolveSource(m.datasetId);
    if (!d || !numericKeys(d).includes(m.key)) { limitations.push("A metric referenced unavailable numeric data and was omitted."); return []; }
    const stat = datasetStats(d, m.key), unit = d.columns.find((c) => c.key === m.key)!.unit;
    if (!stat || unit === "not specified") return [];
    const context = m.calculation === "mean" ? "Arithmetic mean, not time-weighted." : `Context of first matching extreme (ties may exist): ${JSON.stringify(m.calculation === "min" ? stat.minContext : stat.maxContext)}.`;
    return [{ label: `${{ mean: "Mean", min: "Minimum", max: "Maximum" }[m.calculation]} ${m.key}`, value: stat[m.calculation], unit, datasetId: d.id, calculation: `${m.calculation} over all ${stat.count} non-null retrieved or calculated rows. ${context}` }];
  }).slice(0, 12);
  const diagramRequested = plan.diagram || /\bdiagram\b/i.test(question);
  const diagram: Answer["diagram"] = diagramRequested ? {
    title: "Data provenance relationships",
    description: "Relationship diagram, not measured energy flows. Shows only verified source → tool → returned dataset relationships.",
    nodes: [{ id: "source", label: "Elexon Insights" }, ...datasets.map((d) => ({ id: d.id, label: `${d.tool} · ${d.count} rows` }))],
    edges: datasets.map((d) => ({ from: "source", to: d.id, label: "read-only query" })),
  } : { title: "", description: "", nodes: [], edges: [] };
  if (diagramRequested) limitations.push("The diagram depicts retrieval provenance only. These API records do not establish physical network topology or causal relationships; those would require additional relationship data.");
  if (/\b(plot|graph|chart|dashboard)\b/i.test(question) && !charts.length) limitations.push("No supported measured chart could be built from the returned columns and documented units. See query results and visual validation limits.");
  if (!datasets.length) limitations.push("No successful Elexon data query was returned. This answer contains no measured findings.");
  for (const d of datasets) {
    if (d.truncated) limitations.push(`${d.id}: bounded/incomplete data (${d.count} displayed rows; upstream response ${d.totalCount} records). No claim of exhaustive coverage.`);
    if (!d.rows.length) limitations.push(`${d.id}: no data returned; this does not mean zero.`);
    if (Array.isArray(d.metadata?.warnings)) limitations.push(...d.metadata.warnings.filter((v): v is string => typeof v === "string"));
  }
  limitations.push("Dates in questions are interpreted in Europe/London. UTC timestamps retain Z/offsets; settlement dates are local calendar dates with 46/48/50 periods. Data can be revised. Unknown units are explicitly marked.");
  // Unsupported numerical claims are not allowed into the saved answer. The model is an interpreter,
  // never a calculator: every measured figure comes from the deterministic metric/data model.
  let narrative = /\d/.test(plan.narrative)
    ? "The query results and calculated page statistics are shown below. Numerical claims from the generated commentary were omitted; use the underlying observations and explicitly scoped metrics."
    : plan.narrative;
  if (ranking) {
    const key = ranking.columns.some((c) => c.key === "fuelType") ? "fuelType" : "psrType";
    // Recognised domestic categories only: signed interconnector imports must
    // not be called domestic production, and unknown future codes need review.
    const domestic = new Set(["BIOMASS", "CCGT", "OCGT", "COAL", "NUCLEAR", "NPSHYD", "PS", "WIND", "SOLAR", "OIL", "OTHER"]);
    const candidates = ranking.rows.filter((r) => key === "fuelType" && domestic.has(String(r[key])) && typeof r.energyMWh === "number");
    const best = Math.max(...candidates.map((r) => Number(r.energyMWh)));
    const winners = candidates.filter((r) => r.energyMWh === best);
    if (winners.length) {
      const names = winners.map((r) => String(categoryLabel(key, r[key])));
      const incomplete = ranking.truncated || (ranking.metadata?.warnings as string[] | undefined)?.some((w) => /Some category|excluded|unverified/i.test(w));
      const total = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(best);
      narrative = `${names.join(" and ")} ${winners.length > 1 ? "tie for the highest" : "has the highest"} measured electrical energy output among the retrieved domestic fuel categories: ${total} MWh${winners.length > 1 ? " each" : ""}. This was calculated by grouping all retrieved half-hourly observations by fuel and summing average MW multiplied by each interval's duration in hours. ${incomplete ? "This is a ranking of the available observations, not a confirmed winner for a fully observed period: some intervals are missing, unpublished or incomplete." : "The comparison uses the retrieved interval totals, rather than a snapshot or an average of samples."} Interconnector imports and exports are shown separately as signed flows, not domestic production. The source covers Great Britain electricity, not Northern Ireland or all forms of UK energy.`;
      metrics.unshift({ label: `${names.join(" / ")} — highest observed domestic energy`, value: best, unit: "MWh", datasetId: ranking.id, calculation: `Maximum grouped interval energy among recognised domestic fuel categories. Ties retained. ${ranking.note}` });
    }
    limitations.push("FUELHH is measured Great Britain electricity output by fuel category, not whole-UK energy production. Interconnector flows and pumped-storage discharge are not primary domestic energy sources.");
    const range = ranking.metadata?.requestedInterval as { from?: number; to?: number } | undefined;
    if (range?.from && range?.to) limitations.push(`Energy comparison requested interval: ${new Date(range.from).toISOString()} to ${new Date(range.to).toISOString()} (end exclusive).`);
  }
  return answerSchema.parse(fulfilVisualRequests({
    id, question, title: /\d/.test(plan.title) ? "Grid MCP data analysis" : plan.title, narrative, createdAt: new Date().toISOString(), timezone: "Europe/London (settlement dates); UTC/explicit offsets for timestamps",
    datasets: [...datasets, ...derived], charts, diagram, metrics, limitations: [...new Set(limitations)], tokens,
  }));
}
