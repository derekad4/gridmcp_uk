import type { Answer, Chart, Dataset } from "./validation";

const DOMESTIC = new Set(["BIOMASS", "CCGT", "OCGT", "COAL", "NUCLEAR", "NPSHYD", "PS", "WIND", "SOLAR", "OIL", "OTHER"]);
const numeric = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Honour explicit presentation requests using saved, computed evidence.
 * Pure and idempotent: also upgrades old saved answers without another AI/API call.
 */
export function fulfilVisualRequests(answer: Answer): Answer {
  const wanted = (pattern: string) => {
    const present = pattern === "%" ? answer.question.includes("%") : new RegExp(`\\b(?:${pattern})\\b`, "i").test(answer.question);
    const excluded = new RegExp(`\\b(?:no|not|without|avoid|omit|exclude|remove|instead of|rather than|do not (?:use|show|add|include)|don['’]t (?:use|show|add|include))\\s+(?:(?:a|an|the|any)\\s+)?(?:${pattern})(?=\\s|[,.!?]|$)`, "i").test(answer.question);
    return present && !excluded;
  };
  const percent = wanted("percent(?:age)?s?|shares?|proportions?") || wanted("%");
  // "pir chart" is a common typo present in the reported question.
  const pie = wanted("pie(?:\\s+chart)?|pir\\s+chart");
  const donut = wanted("donut|doughnut");
  if (!percent && !pie && !donut) return answer;
  const datasets = [...answer.datasets], charts = [...answer.charts], limitations = [...answer.limitations];
  const rankings = datasets.filter((d) => d.metadata?.automaticFuelRanking === true && !d.id.includes("_view_") && !d.metadata?.visualShare);
  const ranking = rankings.length === 1 ? rankings[0] : undefined;
  if (!ranking && !percent && (!pie || charts.some((c) => c.kind === "pie")) && (!donut || charts.some((c) => c.kind === "donut"))) return answer;
  let source: Dataset | undefined, xKey = "", valueKey = "";
  if (ranking && ranking.columns.some((c) => c.key === "fuelType")) {
    const rows = ranking.rows.filter((r) => DOMESTIC.has(String(r.fuelType)));
    if (rows.length && rows.every((r) => numeric(r.energyMWh) && r.energyMWh >= 0)) {
      source = { ...ranking, rows };
      xKey = "fuelType"; valueKey = "energyMWh";
    }
  } else {
    // Prefer an already validated categorical, additive-total view. A share of
    // prices, frequencies, time points or unequal-coverage power means is invalid.
    const candidate = charts.find((c) => {
      const d = datasets.find((d) => d.id === c.datasetId);
      const measures = (d?.metadata?.calculation as { measures?: { name: string; operation: string }[] } | undefined)?.measures;
      const additive = /^[kMGT]?Wh$/.test(c.unit) || (c.unit === "index / count" && measures?.some((m) => m.operation === "count"));
      return d && c.yKeys.length === 1 && additive && d.rows.length > 0
        && d.metadata?.visualAggregation !== "mean" && !/Derived view: mean\b/.test(d.note)
        && d.rows.every((r) => r[c.xKey] != null && !/^\d{4}-\d\d-\d\d/.test(String(r[c.xKey]))
          && numeric(r[c.yKeys[0]]) && Number(r[c.yKeys[0]]) >= 0);
    });
    if (candidate) { source = datasets.find((d) => d.id === candidate.datasetId); xKey = candidate.xKey; valueKey = candidate.yKeys[0]; }
  }
  if (!source) {
    const message = "Requested percentage/pie visuals need verified nonnegative category totals and a meaningful denominator. Signed flows, prices and unintegrated power observations were not converted into misleading shares; their original charts and data are retained.";
    return { ...answer, limitations: [...new Set([...limitations, message])] };
  }
  const total = source.rows.reduce((sum, row) => sum + Number(row[valueKey]), 0);
  if (!(total > 0) || !Number.isFinite(total)) return { ...answer, limitations: [...new Set([...limitations, "Percentage and pie charts cannot be calculated because the verified category total is zero or invalid."])] };
  const id = `${source.id}_requested_shares`;
  const scope = ranking
    ? "Percentages are shares of summed observed domestic GB electrical generation, including pumped-storage discharge where reported. Interconnector imports/exports and unclassified categories are excluded from this denominator, not deleted from the original evidence. This is not whole-UK energy production."
    : `Percentages use the sum of all plotted nonnegative ${valueKey} category totals as the denominator.`;
  const shared: Dataset = {
    ...source, id, rows: source.rows.map((r) => ({ ...r, sharePercent: Number(r[valueKey]) / total * 100 })),
    columns: [...source.columns.filter((c) => c.key !== "sharePercent"), { key: "sharePercent", unit: "%" }],
    count: source.rows.length, totalCount: source.rows.length, nextOffset: null,
    coverage: `${source.coverage} ${scope}`,
    note: `${source.note} ${scope} Denominator: ${total} ${source.columns.find((c) => c.key === valueKey)?.unit}. Shares use unrounded totals; missing intervals are not extrapolated.`,
    metadata: { ...source.metadata, automaticFuelRanking: false, visualShare: true, shareDenominator: total, shareSourceKey: valueKey, sourceDatasetId: source.id },
  };
  if (!datasets.some((d) => d.id === id)) datasets.push(shared);
  const add = (kind: Chart["kind"], yKey: string, title: string, unit: string) => {
    if (!charts.some((c) => c.kind === kind && c.datasetId === id && c.yKeys[0] === yKey)) charts.push({ kind, title, datasetId: id, xKey, yKeys: [yKey], unit });
  };
  const label = ranking ? "Observed domestic generation" : "Observed category totals";
  if (percent) add("horizontalBar", "sharePercent", `${label} — percentage shares`, "%");
  const unit = source.columns.find((c) => c.key === valueKey)!.unit;
  if (pie) add("pie", valueKey, `${label} — pie chart`, unit);
  if (donut) add("donut", valueKey, `${label} — donut chart`, unit);
  limitations.push(scope);
  return { ...answer, datasets, charts, limitations: [...new Set(limitations)] };
}
