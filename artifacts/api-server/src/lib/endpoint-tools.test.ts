import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { endpointCatalog, endpointTools, endpointToolCatalog, endpointInputShape, buildEndpointUrl, runEndpointTool, type Endpoint } from "./endpoint-tools";
import { tools, runTool } from "./elexon";

const endpoint = (path: string): Endpoint => {
  const match = endpointCatalog.endpoints.find((entry) => entry.path === path);
  assert.ok(match, `Missing endpoint ${path}`);
  return match;
};
const name = (path: string) => endpoint(path).name;
const originalFetch = globalThis.fetch;
function mockJson(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

test("all pinned GET operations have unique, valid MCP names and schemas; shortcuts stay intact", () => {
  assert.equal(endpointTools.length, 326);
  assert.equal(endpointTools.length, endpointCatalog.endpointCount);
  assert.equal(new Set(endpointTools.map((tool) => tool.name)).size, 326);
  assert.equal(new Set(endpointTools.map((tool) => tool.path)).size, 326);
  assert.deepEqual(tools.map((tool) => tool.name), ["get_system_prices", "get_generation_by_fuel", "get_demand_outturn", "get_wind_forecast"]);
  assert.equal(endpointTools.length + tools.length, 330);
  for (const tool of endpointTools) {
    assert.match(tool.name, /^[a-z0-9_]{1,64}$/);
    for (const placeholder of tool.path.matchAll(/\{([^}]+)\}/g)) {
      assert.ok(tool.parameters.some((param) => param.name === placeholder[1] && param.in === "path" && param.required));
    }
    assert.ok(tool.inputShape._limit && tool.inputShape._offset);
    assert.ok(tool.category && tool.title);
  }
});

test("every generated example validates against its endpoint schema", () => {
  for (const tool of endpointToolCatalog()) {
    const result = z.object(endpointInputShape(endpoint(tool.path))).strict().safeParse(tool.example);
    assert.ok(result.success, `${tool.path}: ${result.success ? "" : result.error.message}`);
  }
});

test("validates required parameters, dates, date-times, enums, arrays, integer bounds and booleans", () => {
  const prices = z.object(endpointInputShape(endpoint("/balancing/settlement/system-prices/{settlementDate}"))).strict();
  assert.equal(prices.safeParse({}).success, false);
  assert.equal(prices.safeParse({ settlementDate: "2026-02-30" }).success, false);
  assert.equal(prices.safeParse({ settlementDate: "2026-02-28" }).success, true);
  assert.equal(prices.safeParse({ settlementDate: "2026-02-28", unknown: true }).success, false);
  assert.equal(prices.safeParse({ settlementDate: "2026-02-28", _limit: 501 }).success, false);
  assert.equal(prices.safeParse({ settlementDate: "2026-02-28", _offset: -1 }).success, false);
  for (const entry of endpointCatalog.endpoints) {
    for (const parameter of entry.parameters) {
      const schema = z.object(endpointInputShape(entry)).shape[parameter.name];
      if (parameter.schema.type === "boolean") assert.equal(schema.safeParse("true").success, false);
      if (parameter.schema.type === "integer") {
        assert.equal(schema.safeParse(1.5).success, false);
        if (parameter.schema.format === "int32") assert.equal(schema.safeParse(2147483648).success, false);
      }
      if (parameter.schema.format === "date-time") assert.equal(schema.safeParse("not-a-time").success, false);
      if (parameter.schema.enum) assert.equal(schema.safeParse("not-a-valid-enum-value").success, false);
      if (parameter.schema.type === "array") assert.equal(schema.safeParse("one,two").success, false);
    }
  }
});

test("builds fixed-origin URLs, encodes query injection and serializes repeated array filters", () => {
  const fuel = endpoint("/datasets/FUELHH");
  const url = buildEndpointUrl(fuel, { fuelType: ["GAS&format=xml", "WIND"], _limit: 2 });
  assert.equal(url.origin, "https://data.elexon.co.uk");
  assert.deepEqual(url.searchParams.getAll("fuelType"), ["GAS&format=xml", "WIND"]);
  assert.equal(url.searchParams.get("format"), "json");
  assert.equal(url.searchParams.has("_limit"), false);
  const reference = endpointCatalog.endpoints.find((entry) => entry.parameters.some((p) => p.in === "path" && p.schema.type === "string"))!;
  const parameter = reference.parameters.find((p) => p.in === "path")!;
  for (const bad of ["..", ".", "../health", "%2e%2e", "//evil.example", "x?format=xml", "x\\y", "x#fragment"]) {
    assert.throws(() => buildEndpointUrl(reference, { [parameter.name]: bad }));
  }
  const custom = { ...fuel, parameters: [{ name: "list", in: "query", required: false, description: "", schema: { type: "array", items: { type: "string" } }, explode: false }] };
  assert.equal(buildEndpointUrl(custom, { list: ["a", "b"] }).searchParams.get("list"), "a,b");
});

test("rejects reversed ranges before fetching upstream", async () => {
  await assert.rejects(runEndpointTool(name("/forecast/generation/wind/latest"), { from: "2026-11-10T01:00:00Z", to: "2026-11-10T00:00:00Z" }), /must not precede/);
});

test("preserves nested records and metadata, paginates and reuses the same cached response", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return mockJson({ metadata: { dataset: "TEST", upstreamTotal: 3 }, data: [{ id: 1, nested: { quantity: 5 } }, { id: 2 }, { id: 3 }] });
  };
  try {
    const tool = name("/reference/bmunits/all");
    const first = await runEndpointTool(tool, { _limit: 2 });
    assert.equal(first.count, 2); assert.equal(first.totalCount, 3);
    assert.equal(first.nextOffset, 2); assert.equal(first.truncated, true);
    assert.deepEqual(first.metadata, { metadata: { dataset: "TEST", upstreamTotal: 3 } });
    assert.deepEqual(first.data[0], { id: 1, nested: { quantity: 5 } });
    const second = await runEndpointTool(tool, { _limit: 2, _offset: 2 });
    assert.equal(second.cached, true); assert.equal(second.nextOffset, null);
    assert.deepEqual(second.data, [{ id: 3 }]); assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("supports scalar arrays, plain objects, and text-only health or legacy responses", async () => {
  globalThis.fetch = async () => mockJson([1, "two"]);
  try {
    const result = await runEndpointTool(name("/reference/fueltypes/all"), {});
    assert.deepEqual(result.data, [{ value: 1 }, { value: "two" }]);
    globalThis.fetch = async () => new Response("Healthy", { headers: { "content-type": "text/plain" } });
    const health = await runEndpointTool(name("/health"), {});
    assert.deepEqual(health.data, [{ text: "Healthy", contentType: "text/plain" }]);
    globalThis.fetch = async () => mockJson({ status: "ready" });
    const status = await runEndpointTool(name("/datasets/metadata/latest"), {});
    assert.deepEqual(status.data, [{ status: "ready" }]);
  } finally { globalThis.fetch = originalFetch; }
});

test("caps large result pages by bytes as well as rows", async () => {
  globalThis.fetch = async () => mockJson(Array.from({ length: 10 }, (_, id) => ({ id, text: "x".repeat(20000) })));
  try {
    const result = await runEndpointTool(name("/reference/bmunits"), { partyIds: ["byte-budget-test"], _limit: 10 });
    assert.ok(result.count > 0 && result.count < 10);
    assert.equal(result.nextOffset, result.count);
    assert.ok(Buffer.byteLength(JSON.stringify(result.data)) <= 120000);
  } finally { globalThis.fetch = originalFetch; }
});

test("retains original convenience tool argument handling and MW generation normalization", async () => {
  globalThis.fetch = async () => mockJson({ data: [{ startTime: "2026-10-01T00:00:00Z", settlementPeriod: 1, data: [{ psrType: "Wind", quantity: 42 }] }] });
  try {
    const result = await runTool("get_generation_by_fuel", { from: "2026-10-01T00:00:00Z", to: "2026-10-01T01:00:00Z" });
    assert.equal(result.data[0].quantity, 42);
    assert.equal(result.data[0].psrType, "Wind");
    await assert.rejects(runTool("get_generation_by_fuel", { from: "2026-10-01T00:00:00Z", to: "2026-10-03T00:00:00Z" }), /maximum time range/);
  } finally { globalThis.fetch = originalFetch; }
});

test("reports upstream HTTP errors and oversized downloads explicitly", async () => {
  globalThis.fetch = async () => mockJson({ error: "Unknown identifier" }, 400);
  try {
    await assert.rejects(runEndpointTool(name("/reference/bmunits"), { partyIds: ["upstream-error-test"] }), /HTTP 400.*Unknown identifier/);
    globalThis.fetch = async () => mockJson([{ text: "x".repeat(4_000_001) }]);
    await assert.rejects(runEndpointTool(name("/reference/bmunits"), { partyIds: ["oversize-test"] }), /response too large/);
    globalThis.fetch = async () => mockJson([{ text: "x".repeat(125000) }]);
    await assert.rejects(runEndpointTool(name("/reference/bmunits"), { partyIds: ["oversize-row-test"] }), /single upstream record/);
    globalThis.fetch = async () => new Response("rate limited", { status: 429 });
    await assert.rejects(runEndpointTool(name("/reference/bmunits"), { partyIds: ["rate-limit-test"] }), /rate limit reached/);
  } finally { globalThis.fetch = originalFetch; }
});
