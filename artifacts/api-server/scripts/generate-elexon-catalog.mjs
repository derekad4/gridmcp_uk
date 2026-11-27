import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const SPEC_URL = "https://data.elexon.co.uk/swagger/v1/swagger.json";

export async function loadSpecification(path) {
  if (path) return readFile(path, "utf8");
  const response = await fetch(SPEC_URL, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`OpenAPI download failed: HTTP ${response.status}`);
  return response.text();
}

function dereference(schema, spec) {
  if (!schema || typeof schema !== "object") throw new Error("Missing parameter schema");
  if (schema.$ref) {
    if (!schema.$ref.startsWith("#/")) throw new Error("External schema references are not supported");
    const target = schema.$ref.slice(2).split("/").reduce((value, key) => value[key.replace(/~1/g, "/").replace(/~0/g, "~")], spec);
    return dereference(target, spec);
  }
  const result = { ...schema };
  if (result.items) result.items = dereference(result.items, spec);
  if (!["string", "integer", "number", "boolean", "array"].includes(result.type)) {
    throw new Error(`Unsupported parameter type: ${JSON.stringify(result)}`);
  }
  return result;
}

export function generateCatalog(spec, specText) {
  const endpoints = [];
  const names = new Set();
  for (const [path, item] of Object.entries(spec.paths)) {
    if (!item.get) continue;
    const operation = item.get;
    const fullName = `elexon_get_${path.replace(/\{([^}]+)\}/g, "by_$1").replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "").toLowerCase()}`;
    let name = fullName.length <= 64 ? fullName : `${fullName.slice(0, 53)}_${createHash("sha256").update(path).digest("hex").slice(0, 10)}`;
    if (names.has(name)) name = `${name.slice(0, 53)}_${createHash("sha256").update(path).digest("hex").slice(0, 10)}`;
    if (names.has(name)) throw new Error(`Duplicate tool name: ${name}`);
    names.add(name);
    const parameters = [...(item.parameters ?? []), ...(operation.parameters ?? [])].map((param) => {
      if (!["path", "query"].includes(param.in)) throw new Error(`Unsupported parameter location on ${path}`);
      return {
        name: param.name, in: param.in, required: !!param.required || param.in === "path",
        description: param.description ?? "", schema: dereference(param.schema, spec),
        ...(param.example !== undefined ? { example: param.example } : {}),
        ...(param.style ? { style: param.style } : {}),
        ...(param.explode !== undefined ? { explode: param.explode } : {}),
      };
    });
    if (new Set(parameters.map((p) => p.name)).size !== parameters.length) throw new Error(`Ambiguous parameters on ${path}`);
    if (parameters.some((p) => ["_limit", "_offset"].includes(p.name))) throw new Error("Pagination parameter collision");
    endpoints.push({
      name, method: "GET", path,
      title: operation.summary || path,
      description: operation.description ?? operation.summary ?? path,
      category: operation.tags?.[0] ?? "Other",
      categories: operation.tags ?? ["Other"], deprecated: !!operation.deprecated,
      parameters, responseTypes: Object.keys(operation.responses?.["200"]?.content ?? {}),
      responses: Object.fromEntries(Object.entries(operation.responses ?? {}).map(([status, response]) => [status, response.description ?? ""])),
    });
  }
  return {
    catalogVersion: 1, apiVersion: spec.info.version, source: SPEC_URL,
    specSha256: createHash("sha256").update(specText).digest("hex"),
    baseUrl: "https://data.elexon.co.uk/bmrs/api/v1",
    endpointCount: endpoints.length, endpoints,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { spec: { type: "string" } } });
  const text = await loadSpecification(values.spec);
  const catalog = generateCatalog(JSON.parse(text), text);
  await writeFile(new URL("../src/catalog/elexon-v1.json", import.meta.url), JSON.stringify(catalog, null, 2) + "\n");
  console.log(`Generated ${catalog.endpointCount} Elexon GET tools; spec SHA-256 ${catalog.specSha256}`);
}
