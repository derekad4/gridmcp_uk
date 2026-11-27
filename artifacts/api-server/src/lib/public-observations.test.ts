import assert from "node:assert/strict";
import { test } from "node:test";
import { PublicObservationCache, HISTORICAL_TTL_MS } from "./public-observations";
import { runEndpointTool } from "./endpoint-tools";
import { runTool } from "./elexon";
import { retrieveDataset } from "./ask/retrieve";
import { calculateDataset } from "./ask/calculations";

const BASE = "https://data.elexon.co.uk/bmrs/api/v1";
const historical = `${BASE}/datasets/FUELHH?settlementDateFrom=2020-01-01&settlementDateTo=2020-01-01`;
const snapshot = (now: number) => ({
  rows: [{ startTime: "2020-01-01T00:00:00Z", generation: 100, nested: { unit: "MW" } }],
  metadata: { revision: 1 }, fetchedAt: new Date(now).toISOString(),
});

test("historical cache expires at original download time and never lends mutable objects", () => {
  let now = Date.parse("2026-11-19T12:00:00Z");
  const cache = new PublicObservationCache(100000, 10, () => now);
  const input = snapshot(now);
  cache.set(historical, input);
  input.rows[0].nested.unit = "wrong";
  const hit = cache.get(historical)!;
  assert.equal((hit.rows[0].nested as { unit: string }).unit, "MW");
  hit.rows[0].generation = 999;
  hit.metadata.revision = 9;
  assert.equal(cache.get(historical)!.rows[0].generation, 100);
  assert.equal(cache.get(historical)!.metadata.revision, 1);
  now += HISTORICAL_TTL_MS - 1;
  assert.ok(cache.get(historical));
  now++;
  assert.equal(cache.get(historical), undefined, "hits must not extend revision freshness");
  cache.set(historical, input);
  assert.equal(cache.get(historical), undefined, "old source timestamps cannot reset expiry");
});

test("cache keys retain every filter, canonicalize parameter order and exclude nonhistorical sources", () => {
  const now = Date.parse("2026-11-19T12:00:00Z");
  const cache = new PublicObservationCache(100000, 20, () => now);
  cache.set(`${historical}&fuelType=WIND&fuelType=CCGT&settlementPeriod=1`, snapshot(now));
  assert.ok(cache.get(`${BASE}/datasets/FUELHH?fuelType=WIND&fuelType=CCGT&settlementPeriod=1&settlementDateTo=2020-01-01&settlementDateFrom=2020-01-01`));
  for (const source of [
    `${historical}&fuelType=WIND&settlementPeriod=1`,
    `${historical}&fuelType=WIND&fuelType=CCGT&settlementPeriod=2`,
    historical.replace("FUELHH", "FUELINST"),
    historical.replace("data.elexon.co.uk", "example.org"),
    historical.replace("https://", "https://user:credential@"),
    `${BASE}/ask/answers/private-id`,
    `${BASE}/forecast/generation/wind/latest?from=2020-01-01T00:00:00Z&to=2020-01-02T00:00:00Z`,
    `${BASE}/datasets/FUELHH?settlementDateFrom=2026-11-18&settlementDateTo=2026-11-19`,
    `${BASE}/datasets/FUELHH?settlementDateFrom=2030-01-01&settlementDateTo=2030-01-01`,
    `${BASE}/datasets/FUELHH?settlementDateFrom=2020-02-30&settlementDateTo=2020-02-30`,
    `${BASE}/datasets/FUELHH`,
  ]) assert.equal(cache.get(source), undefined, source);
  for (const source of [
    `${BASE}/ask/answers/private-id`,
    `${BASE}/datasets/FUELHH`,
    `${BASE}/datasets/FUELHH?settlementDateFrom=2026-11-19&settlementDateTo=2026-11-19`,
  ]) {
    cache.set(source, snapshot(now));
    assert.equal(cache.get(source), undefined);
  }
  for (const source of [
    `${BASE}/demand/outturn?settlementDateFrom=2020-01-01&settlementDateTo=2020-01-01`,
    `${BASE}/generation/actual/per-type?from=2020-01-01T00:00:00Z&to=2020-01-02T00:00:00Z`,
    `${BASE}/balancing/settlement/system-prices/2020-01-01/1`,
  ]) {
    cache.set(source, snapshot(now));
    assert.ok(cache.get(source));
  }
});

test("empty and upstream-incomplete responses are not retained as historical successes", () => {
  const now = Date.now();
  const cache = new PublicObservationCache();
  for (const metadata of [{ incomplete: true }, { metadata: { truncated: true } }, { nextOffset: 10 }, { totalCount: 2 }, { hasMore: true }]) {
    cache.set(historical, { ...snapshot(now), metadata });
    assert.equal(cache.get(historical), undefined);
  }
  cache.set(historical, { ...snapshot(now), rows: [] });
  assert.equal(cache.get(historical), undefined);
});

test("entry and byte limits evict least-recently-used observations without evicting on oversize input", () => {
  const now = Date.now(), value = snapshot(now);
  const a = `${historical}&fuelType=WIND`, b = `${historical}&fuelType=CCGT`, c = `${historical}&fuelType=COAL`;
  const cache = new PublicObservationCache(100000, 2);
  cache.set(a, value); cache.set(b, value); cache.get(a); cache.set(c, value);
  assert.ok(cache.get(a)); assert.ok(cache.get(c)); assert.equal(cache.get(b), undefined);
  const size = Buffer.byteLength(JSON.stringify(value));
  const byteCache = new PublicObservationCache(size * 2, 100);
  byteCache.set(a, value); byteCache.set(b, value); byteCache.get(a); byteCache.set(c, value);
  assert.ok(byteCache.get(a)); assert.ok(byteCache.get(c)); assert.equal(byteCache.get(b), undefined);
  byteCache.set(b, { ...value, metadata: { huge: "x".repeat(size * 3) } });
  assert.ok(byteCache.get(a)); assert.ok(byteCache.get(c));
});

const fuelTool = {
  name: "elexon_get_datasets_fuelhh", description: "Generation in MW",
  inputSchema: { type: "object" as const, properties: { _offset: { type: "integer" }, _limit: { type: "integer" } } },
};
const client = {
  callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => ({
    content: [], structuredContent: await runEndpointTool(name, args),
  }),
} as unknown as Parameters<typeof retrieveDataset>[0];

test("two browser-owned long analyses reuse 60 public days beyond short-cache expiry with identical energy totals", async (t) => {
  let now = Date.now(), downloads = 0;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async (source: string) => {
    downloads++;
    const day = new URL(source).searchParams.get("settlementDateFrom")!;
    const data = Array.from({ length: 48 }, (_, period) => {
      const startTime = new Date(Date.parse(day) + period * 1800000).toISOString();
      return [{ startTime, settlementPeriod: period + 1, fuelType: "WIND", generation: 100 },
        { startTime, settlementPeriod: period + 1, fuelType: "INTELEC", generation: -20 }];
    }).flat();
    return Response.json({ data });
  });
  const args = { settlementDateFrom: "2020-01-01", settlementDateTo: "2020-02-29" };
  const first = await retrieveDataset(client, fuelTool, args, "browser_a_analysis", AbortSignal.timeout(10000), () => {});
  assert.equal(downloads, 60);
  const spec = { datasetId: first.id, groupBy: ["fuelType"], measures: [{ key: "generation", name: "energy", operation: "energy" }] };
  const totals = calculateDataset(first, spec, "totals_a").rows;
  assert.equal(totals.find((r) => r.fuelType === "WIND")?.energy, 144000);
  assert.equal(totals.find((r) => r.fuelType === "INTELEC")?.energy, -28800);
  now += 31000;
  const second = await retrieveDataset(client, fuelTool, args, "browser_b_analysis", AbortSignal.timeout(10000), () => {});
  assert.equal(downloads, 60, "all 60 days must hit historical cache, not the 50-entry short cache");
  assert.deepEqual(second.rows, first.rows);
  assert.deepEqual(calculateDataset(second, { ...spec, datasetId: second.id }, "totals_b").rows, totals);
  assert.equal(second.id, "browser_b_analysis");
  assert.equal(second.truncated, false);
  assert.deepEqual(second.metadata?.windows, first.metadata?.windows);
  second.rows[0].generation = 999;
  const fresh = await runEndpointTool(fuelTool.name, { ...args, settlementDateTo: "2020-01-01" });
  assert.equal(fresh.cached, true);
  assert.equal(fresh.data[0].generation, 100);
  assert.ok(!JSON.stringify(fresh).includes("browser_"), "public cache must contain no private analysis identity");
});

test("historical pages share a download; changed filters and expired revisions download again", async (t) => {
  let now = Date.now(), calls = 0, revision = 1;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ data: Array.from({ length: 501 }, (_, index) => ({ startTime: "2019-01-01T00:00:00Z", generation: revision, index })), revision });
  });
  const args = { settlementDateFrom: "2019-01-01", settlementDateTo: "2019-01-01", fuelType: ["WIND"] };
  const first = await retrieveDataset(client, fuelTool, args, "first", AbortSignal.timeout(5000), () => {});
  assert.equal(first.rows.length, 501); assert.equal(calls, 1);
  now += 31000;
  await retrieveDataset(client, fuelTool, args, "again", AbortSignal.timeout(5000), () => {});
  assert.equal(calls, 1);
  await retrieveDataset(client, fuelTool, { ...args, fuelType: ["CCGT"] }, "filtered", AbortSignal.timeout(5000), () => {});
  assert.equal(calls, 2);
  revision = 2; now += HISTORICAL_TTL_MS;
  const updated = await retrieveDataset(client, fuelTool, args, "updated", AbortSignal.timeout(5000), () => {});
  assert.equal(calls, 3); assert.equal(updated.rows[0].generation, 2);
  assert.notEqual(updated.fetchedAt, first.fetchedAt);
});

test("cached successful days do not conceal failed or empty historical windows, which can recover", async (t) => {
  let now = Date.now(), calls = 0, recovered = false;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async (source: string) => {
    calls++;
    const day = new URL(source).searchParams.get("settlementDateFrom")!;
    if (!recovered && day === "2018-01-02") throw new Error("upstream unavailable");
    return Response.json({ data: !recovered && day === "2018-01-03" ? [] : [{ startTime: `${day}T00:00:00Z`, generation: 100 }] });
  });
  const args = { settlementDateFrom: "2018-01-01", settlementDateTo: "2018-01-03" };
  const partial = await retrieveDataset(client, fuelTool, args, "partial", AbortSignal.timeout(5000), () => {});
  assert.equal(partial.truncated, true);
  assert.match(partial.note, /Window 2.*could not retrieve|Window 2.*Unable to retrieve/);
  assert.match(partial.note, /Window 3 returned no observations/);
  assert.equal((partial.metadata?.windows as { incomplete: boolean }[])[2].incomplete, true);
  recovered = true; now += 31000;
  const full = await retrieveDataset(client, fuelTool, args, "full", AbortSignal.timeout(5000), () => {});
  assert.equal(calls, 5, "only failed and empty days should download again");
  assert.equal(full.truncated, false); assert.equal(full.rows.length, 3);
});

test("refresh during pagination is explicitly incomplete even when row counts do not change", async () => {
  let page = 0;
  const changingClient = { callTool: async () => ({
    content: [], structuredContent: { tool: fuelTool.name, sourceUrl: historical,
      fetchedAt: `2026-11-19T12:00:0${page}Z`, data: [{ generation: ++page }], totalCount: 2,
      truncated: page === 1, nextOffset: 1 },
  }) } as unknown as Parameters<typeof retrieveDataset>[0];
  const result = await retrieveDataset(changingClient, fuelTool, {}, "changed", AbortSignal.timeout(5000), () => {});
  assert.equal(result.truncated, true);
  assert.match(result.note, /refreshed during pagination/);
  assert.equal(result.rows.length, 1);
});

test("convenience observations also reuse history but latest forecasts retain their short freshness", async (t) => {
  let now = Date.now(), calls = 0;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ data: [{ startTime: "2017-01-01T00:00:00Z", quantity: calls }] });
  });
  const args = { from: "2017-01-01T00:00:00Z", to: "2017-01-02T00:00:00Z" };
  await runTool("get_demand_outturn", args);
  await runTool("get_wind_forecast", args);
  now += 31000;
  assert.equal((await runTool("get_demand_outturn", args)).cached, true);
  assert.equal((await runTool("get_wind_forecast", args)).cached, false);
  assert.equal(calls, 3);
});
