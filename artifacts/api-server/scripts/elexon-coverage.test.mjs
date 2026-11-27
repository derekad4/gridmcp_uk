import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { generateCatalog } from "./generate-elexon-catalog.mjs";
import { compareCatalogs, formatReport } from "./verify-elexon-coverage.mjs";

const spec = {
  info: { version: "1" },
  paths: {
    "/example": { get: { summary: "Example", parameters: [
      { name: "date", in: "query", schema: { type: "string", format: "date" } },
    ] } },
  },
};
const catalog = (input = spec) => generateCatalog(input, JSON.stringify(input));

test("identical catalogs pass with both source hashes and counts", () => {
  const diff = compareCatalogs(catalog(), catalog());
  assert.equal(diff.drift, false);
  assert.match(formatReport(diff), /Coverage verified/);
  assert.match(formatReport(diff), /GET operations: 1 pinned \/ 1 fetched/);
  assert.ok(formatReport(diff).includes(`Fetched SHA-256: ${catalog().specSha256}`));
});

test("source-only drift fails without claiming operation changes", () => {
  const current = generateCatalog(spec, JSON.stringify(spec, null, 2));
  const diff = compareCatalogs(catalog(), current);
  assert.equal(diff.drift, true);
  assert.equal(diff.changed.length, 0);
  assert.match(formatReport(diff), /source-only changes still require deliberate acceptance/);
});

test("added and removed operations are named even when totals match", () => {
  const changed = structuredClone(spec);
  changed.paths["/replacement"] = changed.paths["/example"];
  delete changed.paths["/example"];
  const diff = compareCatalogs(catalog(), catalog(changed));
  assert.deepEqual(diff.added, ["GET /replacement"]);
  assert.deepEqual(diff.removed, ["GET /example"]);
  assert.match(formatReport(diff), /1 added, 1 removed/);
});

test("reports parameter additions, removals, required flags and schema changes", () => {
  const old = catalog();
  old.endpoints[0].parameters.push({ name: "obsolete", in: "query", schema: { type: "string" } });
  const current = catalog();
  const date = current.endpoints[0].parameters[0];
  date.required = true;
  date.schema = { type: "string", format: "date-time", enum: ["a", "b"] };
  current.endpoints[0].parameters.push({ name: "id", in: "path", required: true, schema: { type: "integer" } });
  const diff = compareCatalogs(old, current);
  const params = diff.changed[0].parameters;
  assert.deepEqual(params.map((p) => [p.name, p.kind]), [
    ["path:id", "added"], ["query:date", "changed"], ["query:obsolete", "removed"],
  ]);
  assert.deepEqual(params[1].fields.map((f) => f.field), ["required", "schema"]);
  const report = formatReport(diff);
  assert.match(report, /required: false → true/);
  assert.match(report, /date-time/);
  assert.match(report, /enum/);
});

test("operation metadata and ordering changes remain reviewable", () => {
  const current = catalog();
  current.endpoints[0].deprecated = true;
  current.endpoints[0].category = "New category";
  current.endpoints[0].description = "New description";
  const diff = compareCatalogs(catalog(), current);
  assert.deepEqual(diff.changed[0].fields.map((f) => f.field), ["category", "deprecated", "description"]);
  const pair = catalog();
  pair.endpoints.push({ ...structuredClone(pair.endpoints[0]), path: "/other" });
  pair.endpointCount = 2;
  const reversed = structuredClone(pair);
  reversed.endpoints.reverse();
  assert.equal(compareCatalogs(pair, reversed).operationOrderChanged, true);
  assert.equal(compareCatalogs(pair, reversed).drift, true);
});

test("upstream text cannot inject HTML into the report", () => {
  const current = catalog();
  current.endpoints[0].description = "<script>alert(1)</script>";
  const report = formatReport(compareCatalogs(catalog(), current));
  assert.ok(!report.includes("<script>"));
  assert.ok(report.includes("&#60;script&#62;"));
});

test("CLI reports drift without writing the pin; explicit snapshot generation accepts it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "elexon-coverage-"));
  try {
    await mkdir(join(dir, "scripts"));
    await mkdir(join(dir, "src/catalog"), { recursive: true });
    for (const script of ["generate-elexon-catalog.mjs", "verify-elexon-coverage.mjs"]) {
      await copyFile(new URL(script, import.meta.url), join(dir, "scripts", script));
    }
    const pin = join(dir, "src/catalog/elexon-v1.json");
    const original = JSON.stringify(catalog());
    await writeFile(pin, original);
    const input = join(dir, "input.json");
    const fetched = JSON.stringify(spec, null, 2);
    await writeFile(input, fetched);
    const report = join(dir, "output/report.md");
    const snapshot = join(dir, "output/swagger.json");
    const verify = (...args) => spawnSync(process.execPath, [
      join(dir, "scripts/verify-elexon-coverage.mjs"), ...args,
    ], { encoding: "utf8" });
    const drift = verify("--spec", input, "--report", report, "--snapshot", snapshot);
    assert.equal(drift.status, 1, drift.stderr);
    assert.match(await readFile(report, "utf8"), /DRIFT DETECTED/);
    assert.equal(await readFile(snapshot, "utf8"), fetched);
    assert.equal(await readFile(pin, "utf8"), original);
    const generate = spawnSync(process.execPath, [
      join(dir, "scripts/generate-elexon-catalog.mjs"), "--spec", snapshot,
    ], { encoding: "utf8" });
    assert.equal(generate.status, 0, generate.stderr);
    const clean = verify("--spec", snapshot, "--report", report);
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(await readFile(report, "utf8"), /Coverage verified/);
    await writeFile(input, "{broken");
    const invalid = verify("--spec", input, "--report", report);
    assert.equal(invalid.status, 2, invalid.stderr);
    assert.match(await readFile(report, "utf8"), /CHECK FAILED/);
    await writeFile(input, JSON.stringify({ ...spec, paths: { "/bad": { get: {
      parameters: [{ name: "bad", in: "query", schema: { type: "object" } }],
    } } } }));
    const unsupported = verify("--spec", input, "--report", report, "--snapshot", snapshot);
    assert.equal(unsupported.status, 2, unsupported.stderr);
    assert.match(await readFile(report, "utf8"), /Unsupported parameter type/);
    assert.match(await readFile(report, "utf8"), /Fetched SHA-256: [a-f0-9]{64}/);
    const missing = verify("--spec", join(dir, "missing.json"), "--report", report);
    assert.equal(missing.status, 2, missing.stderr);
    assert.match(await readFile(report, "utf8"), /not a clean comparison/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
