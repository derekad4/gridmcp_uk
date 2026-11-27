import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { endpointCatalog, endpointInputShape, runEndpointTool } from "./endpoint-tools";
import { classifySmokeError, runEndpointSmoke, smokeSamples } from "./endpoint-smoke";
import { ToolError } from "./elexon";

const clock = (day: number) => new Date(Date.UTC(2026, 5, day));
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

test("samples are fixed, narrow, current-relative and valid against advertised native schemas", () => {
  for (const now of [new Date("2026-01-01T00:00:00Z"), new Date("2026-03-30T00:00:00Z"), new Date("2026-10-26T00:00:00Z")]) {
    const samples = smokeSamples(now);
    assert.equal(samples.length, 5);
    for (const sample of samples) {
      const endpoint = endpointCatalog.endpoints.find((entry) => entry.path === sample.path)!;
      assert.ok(endpoint);
      assert.ok(z.object(endpointInputShape(endpoint)).strict().safeParse({ ...sample.args, _limit: 5, _offset: 0 }).success);
      const args = sample.args as Record<string, unknown>;
      const day = new Date(now.getTime() - 3 * 86_400_000).toISOString().slice(0, 10);
      assert.equal(args.settlementDate ?? args.settlementDateFrom ?? String(args.from).slice(0, 10), day);
      if (args.to) assert.equal(Date.parse(String(args.to)) - Date.parse(String(args.from)), 1_800_000);
      if (args.settlementDateFrom) assert.equal(args.settlementDateTo, args.settlementDateFrom);
    }
  }
});

test("real native execution validates usable data, accepts empty arrays, and never calls another host", async () => {
  const original = globalThis.fetch;
  const urls: string[] = [];
  let active = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    urls.push(url.toString());
    assert.equal(url.origin, "https://data.elexon.co.uk");
    assert.equal(init?.redirect, "manual");
    assert.ok(init?.signal);
    assert.equal(++active, 1);
    await Promise.resolve();
    active--;
    if (url.pathname.includes("system-prices")) return json({ data: [{
      settlementDate: "2026-06-01", settlementPeriod: 1, systemBuyPrice: 0, systemSellPrice: -1,
    }] });
    if (url.pathname.includes("actual/per-type")) return json({ data: [{
      startTime: "2026-06-01T00:00:00Z", data: [{ psrType: "Nuclear", quantity: 42 }],
    }] });
    if (url.pathname.includes("demand/outturn")) return json({ data: [{
      startTime: "2026-06-01T00:00:00Z", initialDemandOutturn: 42, initialTransmissionSystemDemandOutturn: 50,
    }] });
    return json(url.pathname.endsWith("/stream") ? [] : { metadata: {}, data: [] });
  };
  try {
    const report = await runEndpointSmoke(clock(4));
    assert.equal(report.passed, true);
    assert.deepEqual(report.results.map((r) => r.outcome), ["ok", "ok", "ok", "empty_valid", "empty_valid"]);
    assert.equal(urls.length, 5);
    assert.ok(report.results.every((r) => r.cached === false && r.args._limit === 5 && r.args._offset === 0));
  } finally { globalThis.fetch = original; }
});

test("retirement, redirects, outages, malformed JSON and broken rows fail separately without substitution", async () => {
  const original = globalThis.fetch;
  const counts = new Map<string, number>();
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    counts.set(path, (counts.get(path) ?? 0) + 1);
    if (path.includes("system-prices")) return new Response("Gone", { status: 410 });
    if (path.includes("actual/per-type")) return new Response(null, { status: 302, headers: { location: "https://example.com" } });
    if (path.includes("demand/outturn")) return new Response("Unavailable", { status: 503 });
    if (path.endsWith("/stream")) return json([{ fuelType: "NUCLEAR", generation: "not a number" }]);
    return new Response("{broken", { headers: { "content-type": "application/json" } });
  };
  try {
    const report = await runEndpointSmoke(clock(5));
    assert.equal(report.passed, false);
    assert.deepEqual(report.results.map((r) => r.outcome), [
      "retired_or_missing", "redirected", "upstream_unavailable", "schema_failure", "schema_failure",
    ]);
    assert.deepEqual(report.results.slice(0, 3).map((r) => r.upstreamStatus), [410, 302, 503]);
    assert.equal(counts.size, 5);
    assert.equal([...counts.values()].reduce((a, b) => a + b, 0), 6); // One native 5xx retry.
  } finally { globalThis.fetch = original; }
});

test("HTML, scalar JSON, null, error objects and malformed data envelopes are not valid emptiness", async () => {
  const original = globalThis.fetch;
  const bodies = [new Response("<html>maintenance</html>"), json(7), json(null), json({ error: "bad" }), json({ data: null })];
  globalThis.fetch = async () => bodies.shift()!;
  try {
    const report = await runEndpointSmoke(clock(6));
    assert.equal(report.passed, false);
    assert.ok(report.results.every((r) => r.outcome === "schema_failure"));
  } finally { globalThis.fetch = original; }
});

test("native validation runs before the network and native size limits remain enforced", async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return json({ data: [{ fuelType: "NUCLEAR", generation: 1, padding: "x".repeat(120_001) }] });
  };
  try {
    await assert.rejects(runEndpointTool("elexon_get_generation_actual_per_type", { from: "invalid" }));
    assert.equal(requests, 0);
    const pageReport = await runEndpointSmoke(clock(7));
    assert.ok(pageReport.results.every((r) => r.outcome === "size_limit"));
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(4_000_001)); controller.close(); },
    }));
    const downloadReport = await runEndpointSmoke(clock(8));
    assert.ok(downloadReport.results.every((r) => r.outcome === "size_limit"));
  } finally { globalThis.fetch = original; }
});

test("timeouts, 404, 429 and rejected requests remain distinct and cooldown prevents extra requests", async () => {
  assert.equal(classifySmokeError(new ToolError("missing", 502, "upstream_http", 404)), "retired_or_missing");
  assert.equal(classifySmokeError(new ToolError("bad query", 502, "upstream_http", 400)), "upstream_rejected");
  assert.equal(classifySmokeError(new ToolError("invalid input")), "check_error");
  assert.equal(classifySmokeError(new Error("bug")), "check_error");
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new DOMException("Timed out", "TimeoutError"); };
  try {
    const timeoutReport = await runEndpointSmoke(clock(9));
    assert.ok(timeoutReport.results.every((r) => r.outcome === "upstream_unavailable"));
    assert.equal(requests, 5);
    requests = 0;
    globalThis.fetch = async () => { requests++; return new Response(null, { status: 429 }); };
    const limitedReport = await runEndpointSmoke(clock(10));
    assert.ok(limitedReport.results.every((r) => r.outcome === "rate_limited"));
    assert.equal(requests, 1);
  } finally { globalThis.fetch = original; }
});
