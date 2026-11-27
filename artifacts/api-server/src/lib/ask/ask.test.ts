import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import request from "supertest";
import ExcelJS from "exceljs";
import { pool } from "@workspace/db";
import { AskQuestionBody } from "@workspace/api-zod";
import app from "../../app";
import { buildAnswer, makeView, normalizeResult, planSchema, type Plan, type Dataset } from "./validation";
import { chartSvg, diagramSvg } from "./snapshots";
import { generateExport, spreadsheetValue } from "./exports";
import { connectMcp, runAnalysis, searchCatalog, type Model } from "./engine";
import { sessionFor, reserve, LIMITS } from "./store";
import { questionInterval, relativeDates } from "./dates";
import { retrieveDataset, measurementQuery } from "./retrieve";
import type { Request, Response } from "express";
import { categoryLabel, fieldLabel, metricLabel, seriesLabel, tableHeading } from "@workspace/elexon-labels";

const id = randomUUID();
const dataset: Dataset = normalizeResult({
  tool: "test_power", sourceUrl: "https://data.elexon.co.uk/bmrs/api/v1/test?from=2026-03-29",
  fetchedAt: "2026-03-30T12:00:00Z", totalCount: 3, truncated: true,
  data: [
    { startTime: "2026-03-29T00:00:00Z", fuelType: "WIND", quantity: 100, unit: "MW", text: "=SUM(1,2)" },
    { startTime: "2026-03-29T00:30:00Z", fuelType: "WIND", quantity: 120, unit: "MW", text: "Électricité" },
    { startTime: "2026-03-29T01:00:00Z", fuelType: "WIND", quantity: null, unit: "MW", text: "<script>bad()</script>" },
  ], note: "Fixture only; not live Elexon evidence.",
}, { from: "2026-03-29T00:00:00Z", to: "2026-03-29T02:00:00Z" }, "query_1", "Electricity quantity in MW");
const plan: Plan = { title: "Power analysis", narrative: "The returned observations are bounded and may be revised.", limitations: [], views: [{ datasetId: "query_1", title: "Power observations", kind: "line", xKey: "startTime", yKey: "quantity", aggregation: "none" }], diagram: true };
const answer = buildAnswer(id, "Show a graph, diagram and dashboard", plan, [dataset], 150);
after(async () => { await pool.end(); });

test("friendly labels are field-aware, retain codes on request and never alter measured values", () => {
  assert.equal(categoryLabel("fuelType", "CCGT"), "Gas (combined cycle)");
  assert.equal(categoryLabel("fuelType", "NPSHYD", true), "Hydro (non-pumped storage) (NPSHYD)");
  assert.equal(categoryLabel("fuelType", "INTNSL"), "North Sea Link interconnector");
  assert.equal(categoryLabel("psrType", "B18"), "Wind (offshore)");
  assert.equal(categoryLabel("dataset", "FUELHH", true), "Half-hourly generation by fuel (FUELHH)");
  assert.equal(categoryLabel("bmUnit", "CCGT"), "CCGT");
  assert.equal(categoryLabel("fuelType", "UNKNOWN_NEW_FUEL"), "UNKNOWN_NEW_FUEL");
  assert.equal(categoryLabel("fuelType", null), null);
  assert.equal(categoryLabel("generation", -1050), -1050);
  assert.equal(fieldLabel("systemSellPrice"), "System sell price");
  assert.equal(fieldLabel("settlementPeriod"), "Settlement period");
  assert.equal(tableHeading("fuelType"), "Fuel type (fuelType)");
  assert.equal(seriesLabel("Measure: CCGT"), "Gas (combined cycle)");
  assert.equal(seriesLabel("Measure: UNKNOWN_NEW_FUEL"), "UNKNOWN_NEW_FUEL");
  assert.equal(metricLabel("Maximum systemSellPrice"), "Maximum system sell price");
  const view = makeView(dataset, { ...plan.views[0], kind: "bar", xKey: "fuelType", aggregation: "mean" }, 0);
  assert.match(chartSvg(view.chart, view.dataset), /Wind/);
  assert.match(chartSvg(view.chart, view.dataset), /Fuel type/);
  assert.equal(dataset.rows[0].fuelType, "WIND");
  assert.equal(dataset.rows[0].quantity, 100);
  assert.equal(view.chart.xKey, "fuelType");
});

test("questions and declarative artifact schemas reject oversized, executable or unknown fields", () => {
  assert.equal(AskQuestionBody.strict().safeParse({ question: "a".repeat(32001) }).success, false);
  assert.equal(AskQuestionBody.strict().safeParse({ question: "Test question", parentId: "../../other" }).success, false);
  assert.equal(planSchema.safeParse({ ...plan, script: "fetch('bad')" }).success, false);
  assert.equal(planSchema.safeParse({ ...plan, views: [{ ...plan.views[0], kind: "javascript" }] }).success, false);
  assert.equal(planSchema.safeParse({ ...plan, views: [{ ...plan.views[0], values: [900000] }] }).success, false);
  assert.equal(planSchema.safeParse(plan).success, true);
});
test("charts and metrics can only use actual returned observations and documented units", () => {
  assert.equal(answer.metrics[0].value, 110);
  assert.equal(answer.metrics[0].unit, "MW");
  assert.equal(answer.metrics.find((m) => m.label === "Maximum quantity")?.value, 120);
  assert.match(answer.metrics.find((m) => m.label === "Maximum quantity")!.calculation, /savedRow/);
  assert.equal(answer.datasets[1].rows[0][answer.charts[0].yKeys[0]], 100);
  assert.equal(answer.datasets[1].rows.length, 2); // Missing observation excluded, never turned into zero.
  assert.throws(() => makeView(dataset, { ...plan.views[0], yKey: "inventedNumber" }, 0), /unavailable/);
  assert.throws(() => makeView({ ...dataset, columns: dataset.columns.map((c) => ({ ...c, unit: "not specified" })) }, plan.views[0], 0), /unit/);
  const duplicates = { ...dataset, rows: [dataset.rows[0], dataset.rows[0]] };
  assert.throws(() => makeView(duplicates, plan.views[0], 0), /Duplicate/);
  const summed = makeView(duplicates, { ...plan.views[0], aggregation: "sum" }, 0);
  assert.equal(summed.dataset.rows[0][summed.chart.yKeys[0]], 200);
  const signed = { ...dataset, rows: [{ ...dataset.rows[0], quantity: -100 }] };
  assert.throws(() => makeView(signed, { ...plan.views[0], kind: "composition" }, 0), /nonnegative/);
  assert.equal(buildAnswer(id, "graph", { ...plan, narrative: "An invented claim of 999999 MW" }, [dataset], 10).narrative.includes("999999"), false);
  assert.ok(answer.limitations.some((s) => s.includes("incomplete")));
  assert.match(answer.diagram.description, /not measured/);
});
test("normalization retains full MCP pages and nested data, and blocks unexpected sources", () => {
  assert.throws(() => normalizeResult({ ...dataset, data: [], sourceUrl: "https://attacker.example/test" }, {}, "x", ""), /Unexpected/);
  const output = normalizeResult({ tool: "nested", sourceUrl: dataset.sourceUrl, fetchedAt: dataset.fetchedAt, totalCount: 300, truncated: false, data: Array.from({ length: 300 }, () => ({ data: [{ quantity: 2, fuelType: "WIND" }], nested: { version: 4 }, extra: ["a", "b"] })) }, {}, "nested", "MW");
  assert.equal(output.rows.length, 300);
  assert.equal(output.rows[0]["nested.version"], 4);
  assert.equal(output.rows[0].extra, '["a","b"]');
  assert.equal(output.truncated, false);
  assert.doesNotMatch(output.note, /omitted/);
  const mixed = normalizeResult({ tool: "mixed", sourceUrl: dataset.sourceUrl, fetchedAt: dataset.fetchedAt, totalCount: 2, truncated: false, data: [{ quantity: 1, unit: "MW" }, { quantity: 2, unit: "MWh" }] }, {}, "mixed", "Power MW");
  assert.equal(mixed.columns.find((c) => c.key === "quantity")?.unit, "not specified");
});
test("the exact reported fuel plot survives invalid model fields and a rejected twenty-series view", () => {
  const question = "plot the generation mix by fuel type between 2026-11-01 and 2026-11-19";
  assert.deepEqual(questionInterval(question), { from: Date.parse("2026-11-01T00:00:00Z"), to: Date.parse("2026-11-20T00:00:00Z") });
  const fuel: Dataset = {
    ...dataset, id: "query_1", tool: "elexon_get_datasets_fuelhh",
    columns: [{ key: "startTime", unit: "not specified" }, { key: "fuelType", unit: "not specified" }, { key: "generation", unit: "MW" }],
    rows: Array.from({ length: 40 }, (_, i) => ({ startTime: `2026-11-${i < 20 ? "01" : "19"}T00:00:00Z`, fuelType: `FUEL_${i % 20}`, generation: i % 20 === 19 ? -50 : 100 + i })),
    count: 40, totalCount: 40, truncated: false,
    metadata: { requestedInterval: questionInterval(question) },
  };
  const invalidViews: Plan["views"] = [
    { datasetId: fuel.id, title: "All fuel series", kind: "line", xKey: "startTime", yKey: "generation", groupKey: "fuelType", aggregation: "none" },
    { datasetId: fuel.id, title: "Wrong source field", kind: "bar", xKey: "fuelType", yKey: "quantity", aggregation: "mean" },
  ];
  for (const views of [[], ...invalidViews.map((v) => [v])]) {
    const result = buildAnswer(randomUUID(), question, { ...plan, views, diagram: false }, [fuel], 10);
    assert.equal(result.charts.length, 1);
    assert.equal(result.charts[0].kind, "bar");
    const values = result.datasets.find((d) => d.id === result.charts[0].datasetId)!;
    assert.equal(values.rows.length, 20);
    assert.ok(values.rows.some((row) => row[result.charts[0].yKeys[0]] === -50));
    assert.ok(result.limitations.some((l) => l.includes("replaces the missing or invalid")));
  }
  const other: Dataset = { ...fuel, id: "query_2", metadata: { requestedInterval: { from: 0, to: 1 } } };
  const specific = buildAnswer(randomUUID(), question, { ...plan, views: [], diagram: false }, [fuel, other], 10);
  assert.equal(specific.charts.length, 1);
  assert.match(specific.charts[0].datasetId, /^query_1_view_/);
  const ambiguous = buildAnswer(randomUUID(), question, { ...plan, views: [], diagram: false }, [{ ...fuel, metadata: {} }, { ...other, metadata: {} }], 10);
  assert.equal(ambiguous.charts.length, 0);
  assert.ok(ambiguous.limitations.some((l) => l.includes("No supported measured chart")));
});
test("retrieval automatically combines every native MCP page without changing interval filters", async () => {
  const offsets: number[] = [];
  const tool = { name: "paged_fixture", description: "Generation in MW", inputSchema: { type: "object" as const, properties: { _offset: { type: "integer" }, _limit: { type: "integer" } } } };
  const client = { callTool: async (request: { arguments: Record<string, unknown> }) => {
    const offset = Number(request.arguments._offset);
    offsets.push(offset);
    assert.equal(request.arguments.from, "2025-01-15T06:00:00Z");
    assert.equal(request.arguments.to, "2025-01-15T18:00:00Z");
    const rows = Array.from({ length: Math.min(500, 1100 - offset) }, (_, i) => ({ quantity: offset + i, unit: "MW", fuelType: "WIND" }));
    return { content: [], structuredContent: { tool: tool.name, sourceUrl: dataset.sourceUrl, fetchedAt: dataset.fetchedAt, data: rows, totalCount: 1100, truncated: offset + rows.length < 1100, nextOffset: offset + rows.length < 1100 ? offset + rows.length : null } };
  } } as unknown as Parameters<typeof retrieveDataset>[0];
  const result = await retrieveDataset(client, tool, { from: "2025-01-15T06:00:00Z", to: "2025-01-15T18:00:00Z", _limit: 100 }, "all_pages", AbortSignal.timeout(5000), () => {});
  assert.deepEqual(offsets, [0, 500, 1000]);
  assert.equal(result.rows.length, 1100);
  assert.equal(result.rows[1099].quantity, 1099);
  assert.equal(result.totalCount, 1100);
  assert.equal(result.truncated, false);
  assert.equal(result.nextOffset, null);
});
test("nonadvancing pagination returns explicitly incomplete data instead of looping", async () => {
  const tool = { name: "stalled_fixture", inputSchema: { type: "object" as const, properties: { offset: { type: "integer" }, limit: { type: "integer" } } } };
  const client = { callTool: async () => ({ content: [], structuredContent: { tool: tool.name, sourceUrl: dataset.sourceUrl, fetchedAt: dataset.fetchedAt, data: [{ quantity: 2, unit: "MW" }], totalCount: 2, truncated: true, nextOffset: 0 } }) } as unknown as Parameters<typeof retrieveDataset>[0];
  const result = await retrieveDataset(client, tool, {}, "stalled", AbortSignal.timeout(5000), () => {});
  assert.equal(result.rows.length, 1);
  assert.equal(result.truncated, true);
  assert.match(result.note, /usable advancing page/);
});
test("month ranges resolve to London boundaries including leap years and daylight saving", () => {
  const now = new Date("2026-11-19T12:00:00Z");
  assert.deepEqual(questionInterval("generation fuel mix last month", now), { from: Date.parse("2026-09-30T23:00:00Z"), to: Date.parse("2026-11-01T00:00:00Z") });
  assert.deepEqual(questionInterval("generation by fuel during March 2025", now), { from: Date.parse("2025-03-01T00:00:00Z"), to: Date.parse("2025-03-31T23:00:00Z") });
  assert.deepEqual(questionInterval("fuel mix for 2024-02", now), { from: Date.parse("2024-02-01T00:00:00Z"), to: Date.parse("2024-03-01T00:00:00Z") });
  assert.equal(questionInterval("generation for 2025-01-15", now), undefined);
  assert.equal(questionInterval("a month-long view", now), undefined);
  assert.deepEqual(questionInterval("generation between 2025-01-01 and 2025-01-31", now), { from: Date.parse("2025-01-01T00:00:00Z"), to: Date.parse("2025-02-01T00:00:00Z") });
});
test("a full fuel month is retrieved in daily windows with every page and requested-period filtering", async () => {
  const calls: Record<string, unknown>[] = [];
  const tool = { name: "elexon_get_datasets_fuelhh", description: "Generation MW", inputSchema: { type: "object" as const, properties: { _offset: { type: "integer" }, _limit: { type: "integer" } } } };
  const client = { callTool: async (request: { arguments: Record<string, unknown> }) => {
    const args = request.arguments;
    calls.push(args);
    assert.equal(args.settlementDateFrom, args.settlementDateTo);
    const offset = Number(args._offset);
    const day = String(args.settlementDateFrom);
    return { content: [], structuredContent: { tool: tool.name, sourceUrl: `${dataset.sourceUrl}&day=${day}`, fetchedAt: dataset.fetchedAt,
      totalCount: 2, truncated: offset === 0, nextOffset: offset === 0 ? 1 : null,
      data: [{ startTime: `${day}T${offset ? "12" : "00"}:00:00Z`, fuelType: offset ? "INTELEC" : "WIND", generation: offset ? -50 : 100, unit: "MW" }] } };
  } } as unknown as Parameters<typeof retrieveDataset>[0];
  const result = await retrieveDataset(client, tool, { settlementDateFrom: "2026-11-19", settlementDateTo: "2026-11-19" }, "month", AbortSignal.timeout(5000), () => {}, "Chart generation by fuel for January 2025");
  assert.equal(calls.length, 62);
  assert.equal(result.rows.length, 62);
  assert.equal(result.rows[0].startTime, "2025-01-01T00:00:00Z");
  assert.equal(result.rows.at(-1)?.startTime, "2025-01-31T12:00:00Z");
  assert.equal(result.truncated, false);
  assert.equal((result.metadata?.windows as unknown[]).length, 31);
  assert.ok(result.rows.some((row) => row.generation === -50));
  const charted = buildAnswer(randomUUID(), "Chart generation by fuel for January 2025", {
    ...plan, views: [{ datasetId: "month", title: "Fuel mix", kind: "bar", xKey: "fuelType", yKey: "generation", aggregation: "mean" }],
  }, [result], 10);
  assert.equal(charted.charts.length, 1);
  assert.ok(charted.datasets.some((d) => d.id.includes("_view_") && d.rows.some((r) => Object.values(r).includes(-50))));
});
test("a failed historical window preserves other dates but explicitly marks the month incomplete", async () => {
  const tool = { name: "elexon_get_datasets_fuelhh", description: "Generation MW", inputSchema: { type: "object" as const, properties: { _offset: { type: "integer" } } } };
  const client = { callTool: async (request: { arguments: Record<string, unknown> }) => {
    const day = String(request.arguments.settlementDateFrom);
    if (day === "2025-01-02") throw new Error("upstream unavailable");
    return { content: [], structuredContent: { tool: tool.name, sourceUrl: dataset.sourceUrl, fetchedAt: dataset.fetchedAt,
      totalCount: 1, truncated: false, data: [{ startTime: `${day}T00:00:00Z`, generation: 10, unit: "MW" }] } };
  } } as unknown as Parameters<typeof retrieveDataset>[0];
  const result = await retrieveDataset(client, tool, { settlementDateFrom: "2025-01-01", settlementDateTo: "2025-01-03" }, "partial", AbortSignal.timeout(5000), () => {});
  assert.equal(result.rows.length, 2);
  assert.equal(result.truncated, true);
  assert.match(result.note, /Window 2.*could not retrieve data/);
  assert.match(result.note, /do not claim full interval/);
});
test("convenience interval requests are split into non-overlapping maximum-24-hour windows", async () => {
  const intervals: [string, string][] = [];
  const tool = { name: "get_generation_by_fuel", description: "Generation MW", inputSchema: { type: "object" as const, properties: { offset: { type: "integer" }, limit: { type: "integer" } } } };
  const client = { callTool: async (request: { arguments: Record<string, unknown> }) => {
    const from = String(request.arguments.from), to = String(request.arguments.to);
    assert.ok(Date.parse(to) - Date.parse(from) <= 86400000);
    intervals.push([from, to]);
    return { content: [], structuredContent: { tool: tool.name, sourceUrl: dataset.sourceUrl, fetchedAt: dataset.fetchedAt, totalCount: 1, truncated: false,
      data: [{ startTime: from, quantity: 2, unit: "MW" }] } };
  } } as unknown as Parameters<typeof retrieveDataset>[0];
  const result = await retrieveDataset(client, tool, { from: "2025-10-25T23:00:00Z", to: "2025-10-27T00:00:00Z" }, "autumn", AbortSignal.timeout(5000), () => {});
  assert.deepEqual(intervals, [["2025-10-25T23:00:00.000Z", "2025-10-26T23:00:00.000Z"], ["2025-10-26T23:00:00.000Z", "2025-10-27T00:00:00.000Z"]]);
  assert.equal(result.rows.length, 2);
  assert.equal(result.truncated, false);
});
test("historical fuel queries use settlement days and filter actual measurement times, not publication times", async () => {
  const tool = { name: "elexon_get_datasets_fuelhh", description: "Generation MW", inputSchema: { type: "object" as const, properties: { _offset: { type: "integer" }, _limit: { type: "integer" } } } };
  const question = "Show generation between 2025-01-15T06:00Z and 2025-01-15T18:00Z as composition";
  const query = measurementQuery(tool, { publishDateTimeFrom: "2025-01-15T06:00:00Z", publishDateTimeTo: "2025-01-15T18:00:00Z" }, question);
  assert.deepEqual(query.args, { settlementDateFrom: "2025-01-15", settlementDateTo: "2025-01-15" });
  const client = { callTool: async (request: { arguments: Record<string, unknown> }) => {
    assert.equal(request.arguments.publishDateTimeFrom, undefined);
    assert.equal(request.arguments.settlementDateFrom, "2025-01-15");
    return { content: [], structuredContent: { tool: tool.name, sourceUrl: dataset.sourceUrl, fetchedAt: dataset.fetchedAt, totalCount: 4, truncated: false,
      data: ["05:30", "06:00", "17:30", "18:00"].map((time) => ({ startTime: `2025-01-15T${time}:00Z`, generation: 2, fuelType: "WIND", unit: "MW" })) } };
  } } as unknown as Parameters<typeof retrieveDataset>[0];
  const result = await retrieveDataset(client, tool, {}, "measured", AbortSignal.timeout(5000), () => {}, question);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].startTime, "2025-01-15T06:00:00Z");
  assert.equal(result.rows[1].startTime, "2025-01-15T17:30:00Z");
  assert.equal(result.truncated, false);
});
test("signed generation over multiple periods renders a mean-output bar chart instead of dropping composition", () => {
  const source = { ...dataset, rows: [
    { startTime: "2025-01-15T06:00:00Z", fuelType: "WIND", quantity: 100 },
    { startTime: "2025-01-15T06:30:00Z", fuelType: "WIND", quantity: 120 },
    { startTime: "2025-01-15T06:00:00Z", fuelType: "INTERCONNECTOR", quantity: -10 },
    { startTime: "2025-01-15T06:30:00Z", fuelType: "INTERCONNECTOR", quantity: -20 },
  ], count: 4, totalCount: 4, truncated: false };
  const result = buildAnswer(id, "Show generation as a composition", { ...plan, views: [{ datasetId: "fuel_mix_alias", title: "Fuel mix", kind: "composition", xKey: "fuelType", yKey: "quantity", aggregation: "none" }] }, [source], 100);
  assert.equal(result.charts[0].kind, "bar");
  const rows = result.datasets.find((d) => d.id === result.charts[0].datasetId)!.rows;
  assert.equal(rows.find((r) => r.fuelType === "WIND")?.[result.charts[0].yKeys[0]], 110);
  assert.equal(rows.find((r) => r.fuelType === "INTERCONNECTOR")?.[result.charts[0].yKeys[0]], -15);
  assert.ok(result.limitations.some((s) => s.includes("Negative flows are retained")));
});
test("London relative calendar ranges handle spring, autumn and local date differences", () => {
  const spring = relativeDates(new Date("2026-03-30T10:00:00Z")).yesterday;
  assert.equal(spring.from, "2026-03-29T00:00:00.000Z");
  assert.equal(spring.to, "2026-03-29T23:00:00.000Z");
  const autumn = relativeDates(new Date("2026-10-26T10:00:00Z")).yesterday;
  assert.equal(autumn.from, "2026-10-24T23:00:00.000Z");
  assert.equal(autumn.to, "2026-10-26T00:00:00.000Z");
  const summerMidnight = relativeDates(new Date("2026-07-01T23:30:00Z")).today;
  assert.equal(summerMidnight.settlementDate, "2026-07-02");
  assert.equal(summerMidnight.from, "2026-07-01T23:00:00.000Z");
});
test("official MCP SDK discovers full catalog, searches beyond shortcuts and validates actual tool calls", async () => {
  const connection = await connectMcp();
  try {
    const { tools } = await connection.client.listTools();
    assert.equal(tools.length, 330);
    assert.ok(searchCatalog(tools, "REMIT").every((t) => t.name.startsWith("elexon_get_")));
    assert.ok(searchCatalog(tools, "frequency").some((t) => t.name === "elexon_get_system_frequency"));
    const bad = await connection.client.callTool({ name: "get_system_prices", arguments: { settlement_date: "2026-02-30" } });
    assert.equal(bad.isError, true);
  } finally { await connection.close(); }
});
test("bounded engine discovers and invokes native MCP tools; only the model is replaced in this fixture", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new globalThis.Response(JSON.stringify({ data: [{ startTime: "2026-05-04T00:00:00Z", frequency: 50.02 }, { startTime: "2026-05-04T00:00:15Z", frequency: 49.98 }] }), { headers: { "content-type": "application/json" } });
  let calls = 0;
  const progress: string[] = [];
  const fake: Model = async (input) => {
    calls++;
    assert.ok(Buffer.byteLength(JSON.stringify(input)) < LIMITS.inputBytes);
    const call = (name: string, args: unknown) => ({ role: "assistant", content: null, tool_calls: [{ type: "function", id: `call_${calls}`, function: { name, arguments: JSON.stringify(args) } }] });
    const message = calls === 1 ? call("discover_tools", { query: "frequency" }) : calls === 2 ? call("elexon_get_system_frequency", { from: "2026-05-04T00:00:00Z", to: "2026-05-04T00:01:00Z", _limit: 10 })
      : { role: "assistant", content: JSON.stringify({ ...plan, title: "Frequency", diagram: false, views: [{ ...plan.views[0], yKey: "frequency" }] }) };
    return { id: "fixture", choices: [{ index: 0, message, finish_reason: "stop" }], usage: { total_tokens: 90 } } as Awaited<ReturnType<Model>>;
  };
  try {
    const result = await runAnalysis({ id: randomUUID(), question: "Graph measured system frequency", signal: AbortSignal.timeout(15000), progress: (s) => progress.push(s), model: fake });
    assert.equal(calls, 3);
    assert.equal(result.datasets[0].tool, "elexon_get_system_frequency");
    assert.match(result.datasets[0].sourceUrl, /system\/frequency/);
    assert.equal(result.datasets[0].rows[0].frequency, 50.02);
    assert.equal(result.metrics[0].value, 50);
    assert.equal(result.charts[0].unit, "Hz");
    assert.ok(progress.some((s) => s.includes("330")));
  } finally { globalThis.fetch = original; }
});
test("a month question prefetches its whole interval before the model and retains a chart even if the model omits views", async () => {
  const original = globalThis.fetch;
  const days: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const day = url.searchParams.get("settlementDateFrom")!;
    assert.equal(url.searchParams.get("settlementDateTo"), day);
    assert.match(day, /^2023-04-\d{2}$/);
    days.push(day);
    return new globalThis.Response(JSON.stringify({ data: [{ startTime: `${day}T00:00:00Z`, fuelType: "WIND", generation: 100 }, { startTime: `${day}T00:00:00Z`, fuelType: "INTELEC", generation: -50 }] }), { headers: { "content-type": "application/json" } });
  };
  const fake: Model = async (input) => {
    assert.equal(days.length, 30);
    const evidence = input.messages.find((m) => m.role === "system" && String(m.content).startsWith("The backend retrieved historical fuel evidence"));
    assert.ok(evidence);
    assert.match(String(evidence.content), /2023-04-01/);
    assert.match(String(evidence.content), /2023-04-30/);
    return { id: "fixture", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ ...plan, views: [], diagram: false }) }, finish_reason: "stop" }], usage: { total_tokens: 90 } } as Awaited<ReturnType<Model>>;
  };
  try {
    const result = await runAnalysis({ id: randomUUID(), question: "Chart generation by fuel for April 2023", signal: AbortSignal.timeout(15000), progress: () => {}, model: fake });
    assert.equal(result.datasets[0].rows.length, 60);
    assert.equal(result.datasets[0].truncated, false);
    assert.equal(result.charts.length, 1);
    assert.equal(result.charts[0].kind, "bar");
  } finally { globalThis.fetch = original; }
});
test("engine cancellation stops paid calls but questions above the old context cap proceed", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  await assert.rejects(runAnalysis({ id, question: "Test", signal: controller.signal, progress: () => {}, model: async () => { called = true; throw new Error("must not run"); } }));
  assert.equal(called, false);
  await assert.rejects(runAnalysis({ id, question: "x".repeat(30000), signal: AbortSignal.timeout(5000), progress: () => {}, model: async () => { called = true; throw new Error("model reached"); } }), /model reached/);
  assert.equal(called, true);
});
test("analysis can continue past the former four-model/eight-tool quotas", async () => {
  let calls = 0;
  const fake: Model = async () => {
    calls++;
    const message = calls <= 5
      ? { role: "assistant", content: null, tool_calls: [0, 1].map((i) => ({ type: "function", id: `discovery_${calls}_${i}`, function: { name: "discover_tools", arguments: JSON.stringify({ query: "frequency" }) } })) }
      : { role: "assistant", content: JSON.stringify({ ...plan, views: [], diagram: false }) };
    return { id: "fixture", choices: [{ index: 0, message, finish_reason: "stop" }], usage: { total_tokens: 200000 } } as Awaited<ReturnType<Model>>;
  };
  const result = await runAnalysis({ id: randomUUID(), question: "Explain the available frequency evidence", signal: AbortSignal.timeout(15000), progress: () => {}, model: fake });
  assert.equal(calls, 6);
  assert.equal(result.tokens, 1200000);
});
test("follow-ups enable the verified prior source and retain its exact interval without ambiguous rediscovery", async () => {
  const original = globalThis.fetch;
  const args = { from: "2026-06-13T00:00:00Z", to: "2026-06-13T01:00:00Z", limit: 100 };
  const prior = buildAnswer(randomUUID(), "Graph generation in this interval", plan, [{ ...dataset, tool: "get_generation_by_fuel", arguments: args }], 100);
  globalThis.fetch = async () => new globalThis.Response(JSON.stringify({ data: [{ startTime: args.from, data: [{ psrType: "Biomass", quantity: 600 }, { psrType: "Wind Onshore", quantity: 1200 }] }] }), { headers: { "content-type": "application/json" } });
  let calls = 0;
  const fake: Model = async (input) => {
    calls++;
    if (calls === 1) {
      assert.ok(input.tools?.some((tool) => tool.type === "function" && tool.function.name === prior.datasets[0].tool));
      assert.ok(String(input.messages[0].content).includes(args.from));
      assert.ok(String(input.messages[0].content).includes(args.to));
      assert.match(String(input.messages[0].content), /Do not silently switch datasets/);
    }
    const message = calls === 1
      ? { role: "assistant", content: null, tool_calls: [{ id: "prior_source", type: "function", function: { name: prior.datasets[0].tool, arguments: JSON.stringify(args) } }] }
      : { role: "assistant", content: JSON.stringify({ ...plan, views: [{ datasetId: "query_1", title: "Mean power by fuel", kind: "bar", xKey: "psrType", yKey: "quantity", aggregation: "mean" }] }) };
    return { id: "fixture", choices: [{ index: 0, message, finish_reason: "stop" }], usage: { total_tokens: 100 } } as Awaited<ReturnType<Model>>;
  };
  try {
    const result = await runAnalysis({ id: randomUUID(), question: "Show a bar graph for the same source and interval", previous: [prior], signal: AbortSignal.timeout(15000), progress: () => {}, model: fake });
    assert.equal(calls, 2);
    assert.equal(result.datasets[0].tool, "get_generation_by_fuel");
    assert.deepEqual(result.datasets[0].arguments, args);
    assert.equal(result.charts[0].kind, "bar");
  } finally { globalThis.fetch = original; }
});
test("a multi-query dashboard does not duplicate discovered schemas into the bounded model context", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const generation = String(url).includes("/generation/actual/per-type");
    const data = generation
      ? [{ startTime: "2026-06-12T00:00:00Z", data: [{ psrType: "Wind Onshore", quantity: 1200 }, { psrType: "Biomass", quantity: 600 }] }]
      : Array.from({ length: 48 }, (_, i) => ({
        settlementDate: "2026-06-12", settlementPeriod: i + 1, startTime: `2026-06-12T${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}:00Z`,
        systemBuyPrice: 70 + i / 10, systemSellPrice: 70 + i / 10, netImbalanceVolume: 8 + i,
        reserveScarcityPrice: 0, sellPriceAdjustment: 0.01, buyPriceAdjustment: 0.02,
        replacementPrice: 70.5, replacementPriceReferenceVolume: 17.5,
        totalAcceptedOfferVolume: 150.5, totalAcceptedBidVolume: 162.5,
        totalAdjustmentSellVolume: 10.1, totalAdjustmentBuyVolume: 12.1,
        totalSystemTaggedAcceptedOfferVolume: 24.6, totalSystemTaggedAcceptedBidVolume: 32.7,
        totalSystemTaggedAdjustmentSellVolume: 6.5, totalSystemTaggedAdjustmentBuyVolume: 1.5,
        priceCategory: "Final system price", status: "Published", settlementRun: "Initial",
      }));
    return new globalThis.Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } });
  };
  let calls = 0;
  const fake: Model = async (input) => {
    calls++;
    assert.ok(Buffer.byteLength(JSON.stringify(input)) <= LIMITS.inputBytes);
    if (calls > 1) {
      const discovered = input.messages.find((m) => m.role === "tool")!;
      const output = JSON.parse(String(discovered.content));
      assert.ok(output.every((tool: Record<string, unknown>) => !("inputSchema" in tool)));
    }
    if (calls === 3) {
      const names = input.tools?.filter((tool) => tool.type === "function").map((tool) => tool.function.name);
      assert.ok(!names?.includes("get_system_prices"));
      assert.ok(!names?.includes("get_generation_by_fuel"));
    }
    const tool = (name: string, args: unknown) => ({ type: "function", id: `call_${calls}_${name}`, function: { name, arguments: JSON.stringify(args) } });
    const message = calls === 1
      ? { role: "assistant", content: null, tool_calls: [tool("discover_tools", { query: "system prices generation fuel" })] }
      : calls === 2 ? { role: "assistant", content: null, tool_calls: [
        tool("get_generation_by_fuel", { from: "2026-06-12T00:00:00Z", to: "2026-06-12T00:30:00Z", limit: 100 }),
        tool("get_system_prices", { settlement_date: "2026-06-12", limit: 100 }),
      ] }
      : { role: "assistant", content: JSON.stringify({
        title: "Generation and price dashboard", narrative: "These are returned observations, not forecasts.", limitations: [], diagram: true,
        metrics: [{ datasetId: "query_2", key: "systemBuyPrice", calculation: "max" }],
        views: [
          { datasetId: "query_1", title: "Generation by fuel", kind: "area", xKey: "startTime", yKey: "quantity", groupKey: "psrType", aggregation: "mean" },
          { datasetId: "query_1", title: "Fuel composition", kind: "composition", xKey: "psrType", yKey: "quantity", aggregation: "mean" },
          { datasetId: "query_2", title: "System buy prices", kind: "bar", xKey: "settlementPeriod", yKey: "systemBuyPrice", aggregation: "none" },
        ],
      }) };
    return { id: "fixture", choices: [{ index: 0, message, finish_reason: "stop" }], usage: { total_tokens: 150 } } as Awaited<ReturnType<Model>>;
  };
  try {
    const result = await runAnalysis({ id: randomUUID(), question: "Build a generation and price dashboard with a provenance diagram", signal: AbortSignal.timeout(15000), progress: () => {}, model: fake });
    assert.equal(calls, 3);
    assert.equal(result.charts.length, 3);
    assert.ok(result.diagram.nodes.length > 0);
    assert.equal(result.metrics[0].value, 74.7);
  } finally { globalThis.fetch = original; }
});
test("exports are real Excel, Word and multipage Unicode PDF with images, sources and bounded-data notices", async () => {
  assert.equal(spreadsheetValue(" \t=HYPERLINK(\"bad\")"), "' \t=HYPERLINK(\"bad\")");
  assert.equal(spreadsheetValue(-2), -2);
  const xlsx = await generateExport(answer, "xlsx");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(xlsx as unknown as ExcelJS.Buffer);
  assert.ok(workbook.getWorksheet("Analysis and sources")!.getRow(1).getCell(1).value);
  const cells = workbook.getWorksheet("Data 1")!.getSheetValues().flat(2).map(String).join("\n");
  assert.match(cells, /'=SUM/);
  assert.match(cells, /Électricité/);
  assert.match(cells, /Wind \(WIND\)/);
  assert.match(cells, /Fuel type \(fuelType\)/);
  assert.equal(workbook.getWorksheet("Visual snapshots")!.getImages().length, 2);
  const directory = await mkdtemp(join(tmpdir(), "ask-report-"));
  try {
    const docx = await generateExport(answer, "docx");
    const docPath = join(directory, "report.docx");
    await writeFile(docPath, docx);
    const xml = execFileSync("unzip", ["-p", docPath, "word/document.xml"], { maxBuffer: 5_000_000 }).toString();
    assert.match(xml, /Électricité/);
    assert.match(xml, /Wind \(WIND\)/);
    assert.match(xml, /Fuel type \(fuelType\)/);
    assert.match(xml, /data.elexon.co.uk/);
    assert.match(xml, /TABLE|Readable report preview/);
    assert.match(execFileSync("unzip", ["-l", docPath]).toString(), /word\/media\/.*png/);
    const pdf = await generateExport(answer, "pdf");
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    const pdfPath = join(directory, "report.pdf");
    await writeFile(pdfPath, pdf);
    const info = execFileSync("pdfinfo", [pdfPath]).toString();
    assert.ok(Number(/Pages:\s+(\d+)/.exec(info)?.[1]) >= 3);
    const extracted = execFileSync("pdftotext", [pdfPath, "-"]).toString();
    assert.match(extracted, /Wind \(WIND\)/);
    assert.match(extracted, /Fuel type\s+\(fuelType\)/);
    assert.match(extracted, /Électricité/);
    assert.match(extracted, /data.elexon.co.uk/);
    assert.match(extracted, /TABLE PREVIEW/);
    const empty = buildAnswer(randomUUID(), "No data", { ...plan, views: [], diagram: false }, [], 5);
    assert.ok((await generateExport(empty, "xlsx")).length > 1000);
    assert.ok((await generateExport(empty, "docx")).length > 1000);
    assert.ok((await generateExport(empty, "pdf")).length > 1000);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("SVG snapshots escape labels and never execute supplied markup", () => {
  const svg = chartSvg({ ...answer.charts[0], title: "<script>bad()</script>" }, answer.datasets[1]);
  assert.match(svg, /&lt;script&gt;/);
  assert.doesNotMatch(svg, /<script>/);
  assert.doesNotMatch(diagramSvg({ ...answer.diagram, title: '<image href="https://bad">' }), /<image/);
});
test("private history and actual export HTTP endpoints stay isolated between browser cookies", async () => {
  const tokenA = "a".repeat(64), tokenB = "b".repeat(64);
  const responseStub = { cookie: () => {} } as unknown as Response;
  const session = sessionFor({ headers: { cookie: `ask_session=${tokenA}` }, ip: "127.0.0.1" } as Request, responseStub).session;
  await pool.query("INSERT INTO ask_runs(id,session,client_hash,question,status,result,expires_at) VALUES($1,$2,'test',$3,'complete',$4,now()+interval '1 hour')", [answer.id, session, answer.question, JSON.stringify(answer)]);
  try {
    const historyA = await request(app).get("/api/ask/history").set("Cookie", `ask_session=${tokenA}`).expect(200);
    assert.ok(historyA.body.answers.some((a: { id: string }) => a.id === id));
    const summary = historyA.body.answers.find((a: { id: string }) => a.id === id);
    assert.deepEqual(Object.keys(summary).sort(), ["createdAt", "id", "timezone", "title"]);
    assert.match(historyA.headers["cache-control"], /private, no-store/);
    const historyB = await request(app).get("/api/ask/history").set("Cookie", `ask_session=${tokenB}`).expect(200);
    assert.equal(historyB.body.answers.some((a: { id: string }) => a.id === id), false);
    await request(app).get(`/api/ask/answers/${id}`).set("Cookie", `ask_session=${tokenB}`).expect(404);
    const detail = await request(app).get(`/api/ask/answers/${id}`).set("Cookie", `ask_session=${tokenA}`).set("Accept-Encoding", "gzip").expect(200);
    assert.equal(detail.headers["content-encoding"], "gzip");
    assert.equal(detail.body.question, answer.question);
    assert.deepEqual(detail.body.datasets, answer.datasets);
    await request(app).get("/api/ask/answers/not-a-uuid").set("Cookie", `ask_session=${tokenA}`).expect(400);
    await request(app).get(`/api/ask/answers/${id}/export/xlsx`).set("Cookie", `ask_session=${tokenB}`).expect(404);
    for (const format of ["xlsx", "docx", "pdf"]) {
      const output = await request(app).get(`/api/ask/answers/${id}/export/${format}`).set("Cookie", `ask_session=${tokenA}`).expect(200);
      assert.match(output.headers["content-disposition"], new RegExp(`\\.${format}`));
    }
    await request(app).get(`/api/ask/answers/${id}/export/../../etc/passwd`).expect(404);
    await request(app).get("/api/ask/history").set("Origin", "https://attacker.example").expect(403);
    await request(app).post("/api/ask/questions").send({ question: "Run a question" }).expect(403);
    await request(app).post("/api/ask/questions").set("Origin", "http://127.0.0.1").set("Host", "127.0.0.1").send({ question: "x".repeat(32001) }).expect(400);
    await request(app).post("/api/ask/questions").set("Origin", "http://127.0.0.1").set("Host", "127.0.0.1").send({ question: "valid question", script: "bad" }).expect(400);
    await request(app).get("/api/server").expect(200).expect((res) => assert.equal(res.body.toolCount, 330));
    // Embedded previews may block all cookies. Adopt an existing valid session,
    // then use only its persistent browser credential for every subsequent call.
    const headerToken = "c".repeat(64);
    await request(app).get("/api/ask/history").set("Cookie", `ask_session=${tokenA}`).set("X-Ask-Session", headerToken).expect(200);
    const cookieless = await request(app).get("/api/ask/history").set("X-Ask-Session", headerToken).expect(200);
    assert.ok(cookieless.body.answers.some((a: { id: string }) => a.id === id));
    const cookielessDetail = await request(app).get(`/api/ask/answers/${id}`).set("X-Ask-Session", headerToken).expect(200);
    assert.equal(cookielessDetail.body.id, id);
    for (const format of ["xlsx", "docx", "pdf"]) {
      await request(app).get(`/api/ask/answers/${id}/export/${format}`).set("X-Ask-Session", headerToken).expect(200);
    }
    const foreign = await request(app).get("/api/ask/history").set("X-Ask-Session", "d".repeat(64)).expect(200);
    assert.equal(foreign.body.answers.some((a: { id: string }) => a.id === id), false);
    await request(app).get(`/api/ask/answers/${id}`).set("X-Ask-Session", "d".repeat(64)).expect(404);
    await request(app).get(`/api/ask/answers/${id}/export/pdf`).set("X-Ask-Session", "d".repeat(64)).expect(404);
    await request(app).get("/api/ask/history").set("X-Ask-Session", "bad").expect(400);
  } finally { await pool.query("DELETE FROM ask_runs WHERE id=$1", [id]); }
});
test("large saved analyses keep history small and load full data only on selection", async () => {
  const token = randomUUID().replaceAll("-", "").repeat(2);
  const session = sessionFor({ headers: { "x-ask-session": token }, ip: "127.0.0.1" } as unknown as Request, { cookie: () => {} } as unknown as Response).session;
  const largeId = randomUUID();
  const rows = Array.from({ length: 5500 }, (_, index) => ({ index, evidence: "x".repeat(6500) }));
  const large = { ...answer, id: largeId, datasets: [{ ...dataset, rows, count: rows.length, totalCount: rows.length, columns: [{ key: "index", unit: "index / count" }, { key: "evidence", unit: "text" }] }], charts: [] };
  const json = JSON.stringify(large);
  assert.ok(Buffer.byteLength(json) > 35000000);
  await pool.query("INSERT INTO ask_runs(id,session,client_hash,question,status,result,expires_at) VALUES($1,$2,'test',$3,'complete',$4,now()+interval '1 hour')", [largeId, session, large.question, json]);
  try {
    const listing = await request(app).get("/api/ask/history").set("X-Ask-Session", token).expect(200);
    assert.ok(Buffer.byteLength(JSON.stringify(listing.body)) < 5000);
    assert.equal(listing.body.answers[0].id, largeId);
    assert.equal(listing.body.answers[0].datasets, undefined);
    const detail = await request(app).get(`/api/ask/answers/${largeId}`).set("X-Ask-Session", token).set("Accept-Encoding", "gzip").expect(200);
    assert.equal(detail.headers["content-encoding"], "gzip");
    assert.ok(Number(detail.headers["content-length"]) < 1000000);
    assert.equal(detail.body.datasets[0].rows.length, 5500);
    assert.equal(detail.body.datasets[0].rows.at(-1).index, 5499);
    assert.equal(detail.body.datasets[0].rows.at(-1).evidence.length, 6500);
  } finally { await pool.query("DELETE FROM ask_runs WHERE id=$1", [largeId]); }
});
test("deleting a saved analysis requires its browser owner and removes only that completed result", async () => {
  const token = randomUUID().replaceAll("-", "").repeat(2);
  const otherToken = randomUUID().replaceAll("-", "").repeat(2);
  const session = sessionFor({ headers: { "x-ask-session": token }, ip: "127.0.0.1" } as unknown as Request, { cookie: () => {} } as unknown as Response).session;
  const saved = { ...answer, id: randomUUID() };
  const keep = { ...answer, id: randomUUID() };
  const activeId = randomUUID();
  const deletion = (target: string, owner = token) => request(app).delete(`/api/ask/answers/${target}`)
    .set("Host", "example.com").set("Origin", "https://example.com").set("X-Ask-Session", owner).send({});
  try {
    for (const a of [saved, keep]) await pool.query("INSERT INTO ask_runs(id,session,client_hash,question,status,result,expires_at) VALUES($1,$2,'test',$3,'complete',$4,now()+interval '1 hour')", [a.id, session, a.question, JSON.stringify(a)]);
    await pool.query("INSERT INTO ask_runs(id,session,client_hash,question,status,expires_at) VALUES($1,$2,'test','Running test','running',now()+interval '1 hour')", [activeId, session]);
    await request(app).delete(`/api/ask/answers/${saved.id}`).set("X-Ask-Session", token).send({}).expect(403);
    await request(app).delete(`/api/ask/answers/${saved.id}`).set("Origin", "https://attacker.example").set("X-Ask-Session", token).send({}).expect(403);
    await request(app).delete(`/api/ask/answers/${saved.id}`).set("Host", "example.com").set("Origin", "https://example.com").set("Sec-Fetch-Site", "cross-site").set("X-Ask-Session", token).send({}).expect(403);
    await deletion("not-a-uuid").expect(400);
    await deletion(saved.id, otherToken).expect(404);
    await deletion(activeId).expect(404);
    await request(app).get(`/api/ask/answers/${saved.id}`).set("X-Ask-Session", token).expect(200);
    await deletion(saved.id).expect(204);
    await request(app).get(`/api/ask/answers/${saved.id}`).set("X-Ask-Session", token).expect(404);
    await request(app).get(`/api/ask/answers/${saved.id}/export/pdf`).set("X-Ask-Session", token).expect(404);
    const listing = await request(app).get("/api/ask/history").set("X-Ask-Session", token).expect(200);
    assert.equal(listing.body.answers.some((a: { id: string }) => a.id === saved.id), false);
    assert.equal(listing.body.answers.some((a: { id: string }) => a.id === keep.id), true);
    await deletion(saved.id).expect(404);
    assert.equal(Number((await pool.query("SELECT count(*) AS n FROM ask_runs WHERE id=ANY($1)", [[keep.id, activeId]])).rows[0].n), 2);
    // Cookie-only sessions retain the same ownership protection as iframe headers.
    await request(app).delete(`/api/ask/answers/${keep.id}`).set("Host", "example.com").set("Origin", "https://example.com")
      .set("Cookie", `ask_session=${token}`).send({}).expect(204);
  } finally { await pool.query("DELETE FROM ask_runs WHERE id=ANY($1)", [[saved.id, keep.id, activeId]]); }
});
test("exports include only the selected analysis even when the browser owns other saved analyses", async () => {
  const selected = { ...answer, id: randomUUID(), title: "SELECTED_ANALYSIS_ONLY" };
  const other = { ...answer, id: randomUUID(), title: "UNSELECTED_SAVED_ANALYSIS", narrative: "UNSELECTED_NARRATIVE_MUST_NOT_APPEAR" };
  const token = "e".repeat(64);
  const session = sessionFor({ headers: { "x-ask-session": token }, ip: "127.0.0.1" } as unknown as Request, { cookie: () => {} } as unknown as Response).session;
  const directory = await mkdtemp(join(tmpdir(), "selected-export-"));
  try {
    for (const a of [selected, other]) await pool.query("INSERT INTO ask_runs(id,session,client_hash,question,status,result,expires_at) VALUES($1,$2,'test',$3,'complete',$4,now()+interval '1 hour')", [a.id, session, a.question, JSON.stringify(a)]);
    for (const format of ["xlsx", "docx", "pdf"]) {
      const output = await request(app).get(`/api/ask/answers/${selected.id}/export/${format}`)
        .set("X-Ask-Session", token).set("X-Forwarded-For", "192.0.2.25").buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
          response.on("end", () => callback(null, Buffer.concat(chunks)));
          response.on("error", callback);
        }).expect(200);
      const bytes = output.body as Buffer;
      const path = join(directory, `selected.${format}`);
      await writeFile(path, bytes);
      const content = format === "xlsx"
        ? execFileSync("unzip", ["-p", path, "xl/sharedStrings.xml"]).toString()
        : format === "docx" ? execFileSync("unzip", ["-p", path, "word/document.xml"]).toString()
        : execFileSync("pdftotext", [path, "-"]).toString();
      assert.match(content, /SELECTED_ANALYSIS_ONLY/);
      assert.doesNotMatch(content, /UNSELECTED_SAVED_ANALYSIS|UNSELECTED_NARRATIVE_MUST_NOT_APPEAR/);
      assert.match(content, /quantity/);
      if (format !== "pdf") assert.match(execFileSync("unzip", ["-l", path]).toString(), /media\/.*png/);
      else assert.match(execFileSync("pdfimages", ["-list", path]).toString(), /\bimage\b/);
    }
  } finally {
    await pool.query("DELETE FROM ask_runs WHERE id=ANY($1)", [[selected.id, other.id]]);
    await rm(directory, { recursive: true, force: true });
  }
});
test("analysis registration does not gate requests on historical usage or concurrent sessions", async () => {
  const client = await pool.connect();
  const original = pool.connect;
  await client.query("BEGIN");
  // Run production reservation SQL inside a rollback-only outer transaction. Tests never
  // consume the owner's real allowance or erase anyone else's usage counters.
  pool.connect = (async () => ({
    query: (text: string, values?: unknown[]) => client.query(text === "BEGIN" ? "SAVEPOINT reserve_test" : text === "COMMIT" ? "RELEASE SAVEPOINT reserve_test" : text === "ROLLBACK" ? "ROLLBACK TO SAVEPOINT reserve_test" : text, values),
    release: () => {},
  })) as typeof pool.connect;
  const unique = randomUUID();
  try {
    await client.query("SELECT pg_advisory_xact_lock(37284501)");
    // Temporarily make counters permissive inside this isolated transaction only.
    await client.query("UPDATE ask_usage SET requests=0,tokens=0");
    const run = await reserve(unique, unique, "Budget test");
    const parallel = await reserve(unique, unique, "Parallel test");
    assert.ok(parallel);
    const row = await client.query("SELECT status FROM ask_runs WHERE id=$1", [run]);
    assert.equal(row.rows[0].status, "running");
    await client.query("UPDATE ask_runs SET status='complete' WHERE id=$1", [run]);
    const another = await reserve(`${unique}a`, `${unique}a`, "Second allowed client");
    const third = await reserve(`${unique}b`, `${unique}b`, "Third allowed client");
    assert.ok(await reserve(`${unique}c`, `${unique}c`, "Additional concurrent client"));
    await client.query("UPDATE ask_runs SET status='complete' WHERE id=ANY($1)", [[another, third]]);
    await client.query("INSERT INTO ask_usage(key,requests,tokens) VALUES('lifetime',2147483647,2147483647) ON CONFLICT(key) DO UPDATE SET requests=2147483647,tokens=2147483647");
    assert.ok(await reserve(unique, unique, "Historical quotas no longer block questions"));
  } finally {
    pool.connect = original;
    await client.query("ROLLBACK");
    client.release();
  }
});
