import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { generateCatalog, loadSpecification, SPEC_URL } from "./generate-elexon-catalog.mjs";

const operationKey = (endpoint) => `${endpoint.method} ${endpoint.path}`;
const parameterKey = (parameter) => `${parameter.in}:${parameter.name}`;

function changedFields(before, after, excluded = []) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    .filter((field) => !excluded.includes(field) && !isDeepStrictEqual(before[field], after[field]))
    .map((field) => ({ field, before: before[field], after: after[field] }));
}

export function compareCatalogs(pinned, current) {
  const before = new Map(pinned.endpoints.map((endpoint) => [operationKey(endpoint), endpoint]));
  const after = new Map(current.endpoints.map((endpoint) => [operationKey(endpoint), endpoint]));
  const added = [...after.keys()].filter((key) => !before.has(key)).sort();
  const removed = [...before.keys()].filter((key) => !after.has(key)).sort();
  const changed = [];
  for (const key of [...before.keys()].sort()) {
    if (!after.has(key)) continue;
    const oldEndpoint = before.get(key);
    const newEndpoint = after.get(key);
    const oldParams = new Map(oldEndpoint.parameters.map((p) => [parameterKey(p), p]));
    const newParams = new Map(newEndpoint.parameters.map((p) => [parameterKey(p), p]));
    const parameters = [];
    for (const name of [...new Set([...oldParams.keys(), ...newParams.keys()])].sort()) {
      const oldParam = oldParams.get(name);
      const newParam = newParams.get(name);
      if (!isDeepStrictEqual(oldParam, newParam)) {
        parameters.push({ name, kind: !oldParam ? "added" : !newParam ? "removed" : "changed",
          fields: changedFields(oldParam ?? {}, newParam ?? {}) });
      }
    }
    const fields = changedFields(oldEndpoint, newEndpoint, ["parameters"]);
    const parameterOrderChanged = !isDeepStrictEqual([...oldParams.keys()], [...newParams.keys()]);
    if (fields.length || parameters.length || parameterOrderChanged) {
      changed.push({ operation: key, fields, parameters, parameterOrderChanged });
    }
  }
  return {
    drift: !isDeepStrictEqual(pinned, current),
    pinnedHash: pinned.specSha256, currentHash: current.specSha256,
    pinnedCount: pinned.endpointCount, currentCount: current.endpointCount,
    metadata: changedFields(pinned, current, ["endpoints"]),
    operationOrderChanged: !isDeepStrictEqual([...before.keys()], [...after.keys()]),
    added, removed, changed,
  };
}

// Upstream descriptions are untrusted Markdown; render all values as escaped text.
const escape = (value) => String(value).replace(/[&<>`*_{}[\]()!|#\\~]/g,
  (character) => `&#${character.charCodeAt(0)};`);
const display = (value) => escape(value === undefined ? "(absent)" : JSON.stringify(value));
const fieldLines = (fields) => fields.map(({ field, before, after }) =>
  `  - ${escape(field)}: ${display(before)} → ${display(after)}`);

export function formatReport(diff) {
  const lines = [
    "# Elexon catalog coverage",
    "",
    diff.drift ? "**DRIFT DETECTED — review required; the pinned catalog was not changed.**" : "**Coverage verified — no drift.**",
    "",
    `Source: ${SPEC_URL}`,
    `Pinned SHA-256: ${diff.pinnedHash}`,
    `Fetched SHA-256: ${diff.currentHash}`,
    `GET operations: ${diff.pinnedCount} pinned / ${diff.currentCount} fetched`,
    `Changes: ${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} modified operations`,
    "",
    "## Catalog metadata",
    ...fieldLines(diff.metadata),
    "",
    "## Added operations",
    ...diff.added.map((key) => `- ${escape(key)}`),
    "",
    "## Removed operations",
    ...diff.removed.map((key) => `- ${escape(key)}`),
    "",
    "## Modified operations",
  ];
  for (const change of diff.changed) {
    lines.push(`### ${escape(change.operation)}`, ...fieldLines(change.fields));
    for (const param of change.parameters) {
      lines.push(`- Parameter ${escape(param.name)} (${param.kind})`, ...fieldLines(param.fields));
    }
    if (change.parameterOrderChanged) lines.push("- Parameter order/list changed.");
  }
  if (diff.operationOrderChanged) lines.push("", "Operation order/list changed.");
  if (diff.drift && !diff.added.length && !diff.removed.length && !diff.changed.length) {
    lines.push("", "No operation or parameter definition changes. Review source-hash, metadata and ordering changes; source-only changes still require deliberate acceptance.");
  }
  lines.push("", "See README.md → Elexon specification drift checks for review and acceptance instructions.", "");
  return lines.join("\n");
}

async function save(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

async function main() {
  const { values } = parseArgs({ options: {
    spec: { type: "string" }, report: { type: "string" }, snapshot: { type: "string" },
  } });
  let report;
  let pinned;
  let sourceHash;
  try {
    pinned = JSON.parse(await readFile(new URL("../src/catalog/elexon-v1.json", import.meta.url), "utf8"));
    const text = await loadSpecification(values.spec);
    sourceHash = createHash("sha256").update(text).digest("hex");
    // Save the exact fetched bytes even when a new schema cannot yet be generated.
    if (values.snapshot) await save(values.snapshot, text);
    const diff = compareCatalogs(pinned, generateCatalog(JSON.parse(text), text));
    report = formatReport(diff);
    process.exitCode = diff.drift ? 1 : 0;
  } catch (error) {
    report = [
      "# Elexon catalog coverage",
      "",
      "**CHECK FAILED — coverage could not be verified. This is not a clean comparison.**",
      `Source: ${SPEC_URL}`,
      `Pinned SHA-256: ${pinned?.specSha256 ?? "(unavailable)"}`,
      `Fetched SHA-256: ${sourceHash ?? "(unavailable)"}`,
      `Error: ${escape(error.message)}`,
      "",
      "The pinned catalog was not changed. Retry download failures; investigate invalid or unsupported specifications before accepting any update.",
      "",
    ].join("\n");
    process.exitCode = 2;
  }
  console.log(report);
  if (values.report) await save(values.report, report);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
