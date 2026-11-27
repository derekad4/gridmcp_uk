import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { automaticFuelCalculation, calculateDataset, fuelEnergyIntent } from "./calculations";
import { buildAnswer, makeView, type Dataset, type Plan } from "./validation";
import { fulfilVisualRequests } from "./visual-requests";
import { chartSvg } from "./snapshots";
import { questionInterval } from "./dates";
import { runAnalysis, type Model } from "./engine";
import { generateExport } from "./exports";

after(async () => { await pool.end(); });
const from = Date.parse("2026-10-25T00:00:00Z"), to = from + 3600000;
const source: Dataset = {
  id: "query_1", tool: "elexon_get_datasets_fuelhh", sourceUrl: "https://data.elexon.co.uk/bmrs/api/v1/datasets/FUELHH",
  fetchedAt: "2026-10-26T12:00:00Z", arguments: {}, truncated: false, count: 6, totalCount: 6, nextOffset: null,
  coverage: "Fixture, one observed hour", note: "Test fixture only.",
  metadata: { requestedInterval: { from, to } },
  columns: [{ key: "fuelType", unit: "category" }, { key: "startTime", unit: "time" }, { key: "generation", unit: "MW" }],
  rows: [
    { fuelType: "WIND", startTime: new Date(from).toISOString(), generation: 100 },
    { fuelType: "WIND", startTime: new Date(from + 1800000).toISOString(), generation: 300 },
    { fuelType: "CCGT", startTime: new Date(from).toISOString(), generation: 250 },
    { fuelType: "CCGT", startTime: new Date(from + 1800000).toISOString(), generation: 250 },
    { fuelType: "INTFR", startTime: new Date(from).toISOString(), generation: -50 },
    { fuelType: "INTFR", startTime: new Date(from + 1800000).toISOString(), generation: -100 },
  ],
};
const question = "what category is the biggest producer of energy across the uk in the past 6 months";
const plan: Plan = {
  title: "Generation comparison", narrative: "The largest category cannot be stated without a further grouped calculation.",
  limitations: [], views: [], metrics: [], diagram: false,
};

test("rolling calendar months clamp month ends and use London DST boundaries", () => {
  const range = questionInterval(question, new Date("2026-11-19T12:00:00Z"))!;
  assert.equal(new Date(range.from).toISOString(), "2026-05-18T23:00:00.000Z");
  assert.equal(new Date(range.to).toISOString(), "2026-11-19T12:00:00.000Z");
  assert.equal(new Date(questionInterval("past six months", new Date("2026-08-31T12:00:00Z"))!.from).toISOString(), "2026-02-28T00:00:00.000Z");
  assert.equal(fuelEnergyIntent(question), true);
  assert.equal(fuelEnergyIntent("What is the system sell price?"), false);
});

test("energy totals integrate every half hour, rank categories and retain signed flows", () => {
  const result = automaticFuelCalculation(source, question, "calc_2")!;
  assert.deepEqual(result.rows, [
    { fuelType: "CCGT", energyMWh: 250 },
    { fuelType: "WIND", energyMWh: 200 },
    { fuelType: "INTFR", energyMWh: -75 },
  ]);
  assert.equal(result.columns[1].unit, "MWh");
  assert.equal(source.rows[0].generation, 100);
  assert.equal(result.metadata?.sourceDatasetId, source.id);
  const answer = buildAnswer(randomUUID(), question, plan, [source, result], 10);
  assert.match(answer.narrative, /Gas \(combined cycle\).*250 MWh/);
  assert.doesNotMatch(answer.narrative, /cannot be stated|missing, unpublished/);
  assert.match(answer.narrative, /not Northern Ireland/);
  assert.equal(answer.metrics[0].value, 250);
  assert.equal(answer.charts[0].unit, "MWh");
  assert.equal(answer.datasets.find((d) => d.id === answer.charts[0].datasetId)!.rows[0].fuelType, "CCGT");
});

test("missing observations are flagged, duplicates counted once, conflicting revisions rejected", () => {
  const missing = automaticFuelCalculation({ ...source, rows: source.rows.slice(1) }, question, "calc_2")!;
  const answer = buildAnswer(randomUUID(), question, plan, [source, missing], 0);
  assert.match(answer.narrative, /not a confirmed winner/);
  assert.ok((missing.metadata?.warnings as string[]).some((s) => /Some category intervals/.test(s)));
  const duplicate = automaticFuelCalculation({ ...source, rows: [...source.rows, source.rows[0]] }, question, "calc_2")!;
  assert.equal(duplicate.rows.find((r) => r.fuelType === "WIND")!.energyMWh, 200);
  assert.throws(() => automaticFuelCalculation({ ...source, rows: [...source.rows, { ...source.rows[0], generation: 999 }] }, question, "calc_2"), /Conflicting observations/);
  assert.equal(automaticFuelCalculation({ ...source, tool: "elexon_get_datasets_fuelinst" }, question, "calc_2"), undefined);
});

test("generic calculations filter, bucket, group, rank, count, average and calculate shares", () => {
  const result = calculateDataset(source, {
    datasetId: source.id, groupBy: ["fuelType"], filters: [{ key: "generation", operator: "gt", value: 0 }],
    timeBucket: { key: "startTime", period: "month" },
    measures: [{ key: "generation", name: "meanPower", operation: "mean" }, { name: "observations", operation: "count", shareOfTotal: true }],
    sort: { key: "meanPower", direction: "desc" },
  }, "calc_2");
  assert.deepEqual(result.rows[0], { fuelType: "CCGT", startTime: "2026-10", meanPower: 250, observations: 2, observationsSharePercent: 50 });
  const weighted = calculateDataset({ ...source, rows: source.rows.slice(0, 2).map((r, i) => ({ ...r, weight: i ? 3 : 1 })), columns: [...source.columns, { key: "weight", unit: "hours" }] }, {
    datasetId: source.id, measures: [{ name: "weightedPower", key: "generation", operation: "weighted_mean", weightKey: "weight" }],
  }, "calc_3");
  assert.equal(weighted.rows[0].weightedPower, 250);
  const counted = calculateDataset(source, { datasetId: source.id, groupBy: ["fuelType"], measures: [{ name: "count", operation: "count" }] }, "calc_counts");
  const summed = calculateDataset(counted, { datasetId: counted.id, measures: [{ name: "totalCount", key: "count", operation: "sum" }] }, "calc_total");
  assert.equal(summed.rows[0].totalCount, 6);
  const charted = buildAnswer(randomUUID(), "Chart counts", { ...plan, views: [{ datasetId: counted.id, kind: "bar", xKey: "fuelType", yKey: "count", title: "Observations by fuel", aggregation: "none" }] }, [counted], 0);
  assert.equal(charted.charts.length, 1);
  assert.throws(() => calculateDataset(source, { datasetId: source.id, measures: [{ key: "generation", name: "total", operation: "sum" }] }, "bad"), /Do not sum MW/);
  assert.throws(() => calculateDataset(source, { datasetId: source.id, measures: [{ key: "notAField", name: "total", operation: "mean" }] }, "bad"), /unavailable field/);
  assert.throws(() => calculateDataset(source, { datasetId: source.id, groupBy: ["fuelType"], measures: [{ key: "generation", name: "energy", operation: "energy", shareOfTotal: true }] }, "bad"), /Signed totals/);
  assert.throws(() => calculateDataset({ ...source, tool: "instantaneous" }, { datasetId: source.id, measures: [{ key: "generation", name: "energy", operation: "energy" }] }, "bad"), /verified interval/);
});

test("ranked energy charts and tables are exportable in all three formats", async () => {
  const result = automaticFuelCalculation(source, question, "calc_2")!;
  const answer = buildAnswer(randomUUID(), question, plan, [source, result], 0);
  for (const format of ["xlsx", "docx", "pdf"] as const) {
    const bytes = await generateExport(answer, format);
    assert.ok(bytes.length > 1000);
    assert.equal(bytes.subarray(0, format === "pdf" ? 4 : 2).toString(), format === "pdf" ? "%PDF" : "PK");
  }
});

test("the reported percentage and pie request gets both visuals with a domestic denominator, even when the model supplies neither", async () => {
  const asked = `${question}, include percentages in the graph and maybe a pir chart as well`;
  const ranked = automaticFuelCalculation(source, asked, "calc_2")!;
  const answer = buildAnswer(randomUUID(), asked, plan, [source, ranked], 0);
  const percentage = answer.charts.find((c) => c.kind === "horizontalBar" && c.unit === "%")!;
  const pie = answer.charts.find((c) => c.kind === "pie")!;
  assert.ok(percentage); assert.ok(pie);
  const shares = answer.datasets.find((d) => d.id === percentage.datasetId)!;
  assert.equal(shares.metadata?.shareDenominator, 450);
  assert.ok(Math.abs(shares.rows.reduce((n, r) => n + Number(r.sharePercent), 0) - 100) < 1e-10);
  assert.equal(shares.rows.find((r) => r.fuelType === "CCGT")!.sharePercent, 250 / 450 * 100);
  assert.ok(!shares.rows.some((r) => r.fuelType === "INTFR"));
  assert.equal(answer.datasets.find((d) => d.id === "calc_2")!.rows.find((r) => r.fuelType === "INTFR")!.energyMWh, -75);
  assert.ok(answer.charts.some((c) => c.kind === "bar" && c.unit === "MWh"));
  assert.match(answer.limitations.join(" "), /excluded from this denominator/);
  assert.deepEqual(fulfilVisualRequests(answer), answer, "reading/exporting saved answers must not accumulate duplicate charts");
  assert.match(chartSvg(percentage, shares), /55\.56%/);
  assert.match(chartSvg(pie, shares), /55\.6%/);
  assert.match(chartSvg(pie, shares), /Gas \(combined cycle\)/);
  for (const format of ["xlsx", "docx", "pdf"] as const) {
    const bytes = await generateExport(answer, format);
    assert.ok(bytes.length > 1000);
    assert.equal(bytes.subarray(0, format === "pdf" ? 4 : 2).toString(), format === "pdf" ? "%PDF" : "PK");
  }
  const old = buildAnswer(randomUUID(), question, plan, [source, ranked], 0);
  old.question = asked;
  assert.ok(fulfilVisualRequests(old).charts.some((c) => c.kind === "pie"), "old saved analyses can be repaired without new retrieval");
  const without = { ...old, question: `${question}; without percentages, do not include a pie chart` };
  assert.deepEqual(fulfilVisualRequests(without), without);
  const instead = fulfilVisualRequests({ ...old, question: `${question}; use a donut instead of a pie chart` });
  assert.ok(instead.charts.some((c) => c.kind === "donut"));
  assert.ok(!instead.charts.some((c) => c.kind === "pie"));
});

test("pie/donut, numeric scatter and stacked views are validated and exported as distinct geometries", () => {
  const ranked = automaticFuelCalculation(source, question, "calc_2")!;
  const positive = { ...ranked, rows: ranked.rows.filter((r) => r.fuelType !== "INTFR") };
  for (const kind of ["pie", "donut"] as const) {
    const { chart, dataset } = makeView(positive, { datasetId: ranked.id, kind, title: "Domestic generation", xKey: "fuelType", yKey: "energyMWh", aggregation: "none" }, 0);
    assert.equal(chart.kind, kind);
    const image = chartSvg(chart, dataset);
    assert.match(image, /55\.6%/);
    assert.equal(image.includes('r="74"'), kind === "donut");
    assert.throws(() => makeView(ranked, { datasetId: ranked.id, kind, title: "Invalid signed pie", xKey: "fuelType", yKey: "energyMWh", aggregation: "none" }, 0), /nonnegative/);
  }
  const numeric: Dataset = { ...source, columns: [{ key: "x", unit: "MW" }, { key: "y", unit: "GBP/MWh" }], rows: [{ x: 10, y: 3 }, { x: 30, y: 7 }], count: 2 };
  const scatter = makeView(numeric, { datasetId: numeric.id, title: "Price versus demand", kind: "scatter", xKey: "x", yKey: "y", aggregation: "none" }, 0);
  assert.equal(typeof scatter.dataset.rows[0].x, "number");
  assert.equal((chartSvg(scatter.chart, scatter.dataset).match(/<circle/g) ?? []).length, 2);
  assert.throws(() => makeView({ ...numeric, rows: [{ x: "10", y: 3 }] }, { datasetId: numeric.id, title: "Invalid scatter", kind: "scatter", xKey: "x", yKey: "y", aggregation: "none" }, 0), /numeric/);
  for (const kind of ["stackedBar", "stackedArea"] as const) {
    const view = { datasetId: source.id, title: "Fuel composition through time", kind, xKey: "startTime", yKey: "generation", groupKey: "fuelType", aggregation: "none" as const };
    const clean = { ...source, rows: source.rows.filter((r) => r.fuelType !== "INTFR") };
    const built = makeView(clean, view, 0);
    assert.equal(built.chart.kind, kind);
    assert.match(chartSvg(built.chart, built.dataset), kind === "stackedBar" ? /<rect/ : /fill-opacity=".75"/);
    assert.throws(() => makeView(source, view, 0), /signed/);
    assert.throws(() => makeView({ ...clean, rows: clean.rows.slice(1) }, view, 0), /Missing observations/);
  }
});

test("the LLM can request full-dataset calculations and chart their derived output", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [
    { measurementTime: "2026-05-04T00:00:00Z", frequency: 49 },
    { measurementTime: "2026-05-04T00:00:15Z", frequency: 51 },
  ] }), { headers: { "content-type": "application/json" } });
  let calls = 0;
  const fake: Model = async (input) => {
    calls++;
    assert.ok(input.tools?.some((t) => t.type === "function" && t.function.name === "calculate_dataset"));
    const call = (name: string, args: unknown) => ({ role: "assistant", content: null, tool_calls: [{ type: "function", id: `call_${calls}`, function: { name, arguments: JSON.stringify(args) } }] });
    if (calls === 4) {
      const calculation = input.messages.find((m) => m.role === "tool" && typeof m.content === "string" && m.content.includes('"calculatedRows"'));
      assert.ok(calculation);
      assert.match(String(calculation.content), /"meanFrequency":50/);
    }
    const message = calls === 1 ? call("discover_tools", { query: "frequency" })
      : calls === 2 ? call("elexon_get_system_frequency", { from: "2026-05-04T00:00:00Z", to: "2026-05-04T00:01:00Z" })
      : calls === 3 ? call("calculate_dataset", { datasetId: "query_1", measures: [{ key: "frequency", name: "meanFrequency", operation: "mean" }] })
      : { role: "assistant", content: JSON.stringify({ ...plan, narrative: "The mean frequency was calculated over every returned reading.", metrics: [{ datasetId: "calc_2", key: "meanFrequency", calculation: "max" }] }) };
    return { id: "fixture", choices: [{ index: 0, message, finish_reason: "stop" }], usage: { total_tokens: 90 } } as Awaited<ReturnType<Model>>;
  };
  try {
    const result = await runAnalysis({ id: randomUUID(), question: "Calculate the mean system frequency", signal: AbortSignal.timeout(15000), progress: () => {}, model: fake });
    assert.equal(calls, 4);
    assert.equal(result.metrics[0].value, 50);
    assert.ok(result.datasets.some((d) => d.id === "calc_2"));
  } finally { globalThis.fetch = original; }
});

test("the reported six-month producer question is calculated before the model can refuse", async () => {
  const original = globalThis.fetch;
  let windows = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input)), day = url.searchParams.get("settlementDateFrom")!;
    assert.equal(url.searchParams.get("settlementDateTo"), day);
    windows++;
    return new Response(JSON.stringify({ data: [
      { startTime: `${day}T12:00:00Z`, fuelType: "WIND", generation: 100 },
      { startTime: `${day}T12:00:00Z`, fuelType: "CCGT", generation: 250 },
    ] }), { headers: { "content-type": "application/json" } });
  };
  const fake: Model = async (input) => {
    assert.ok(windows >= 180);
    assert.ok(input.messages.some((m) => String(m.content).includes('"automaticCalculations"') || String(m.content).includes('"energyMWh"')));
    return { id: "fixture", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(plan) }, finish_reason: "stop" }], usage: { total_tokens: 90 } } as Awaited<ReturnType<Model>>;
  };
  try {
    const result = await runAnalysis({ id: randomUUID(), question, signal: AbortSignal.timeout(30000), progress: () => {}, model: fake });
    assert.match(result.narrative, /Gas \(combined cycle\)/);
    assert.doesNotMatch(result.narrative, /without a further grouped calculation/);
    assert.equal(result.charts[0].unit, "MWh");
    assert.match(result.narrative, /not a confirmed winner/);
  } finally { globalThis.fetch = original; }
});
