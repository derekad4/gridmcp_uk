import { z } from "zod";
import catalogJson from "../catalog/elexon-v1.json";
import { loadUpstream, ToolError } from "./elexon";

export type ParameterSchema = {
  type: string; format?: string; enum?: (string | number | boolean)[];
  items?: ParameterSchema; default?: unknown; example?: unknown;
  minimum?: number; maximum?: number; minLength?: number; maxLength?: number;
  minItems?: number; maxItems?: number; uniqueItems?: boolean; pattern?: string;
};
export type EndpointParameter = {
  name: string; in: string; description: string; required: boolean;
  schema: ParameterSchema; example?: unknown; style?: string; explode?: boolean;
};
export type Endpoint = {
  name: string; method: string; path: string; title: string; description: string;
  category: string; categories: string[]; deprecated: boolean; parameters: EndpointParameter[];
  responseTypes: string[]; responses: Record<string, string>;
};

export const endpointCatalog = catalogJson as unknown as {
  catalogVersion: number; apiVersion: string; source: string; specSha256: string;
  baseUrl: string; endpointCount: number; endpoints: Endpoint[];
};
const BASE = "https://data.elexon.co.uk/bmrs/api/v1";
const PAGE_LIMIT = z.number().int().min(1).max(500).default(100).describe("Local response rows per page (1–500). Does not limit the upstream request; narrow API filters for large datasets.");
const PAGE_OFFSET = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0).describe("Local row offset. Continue with nextOffset from the previous result; keep the same API filters.");

function schemaToZod(schema: ParameterSchema): z.ZodTypeAny {
  let result: z.ZodTypeAny;
  switch (schema.type) {
    case "string": {
      let value = z.string().max(Math.min(schema.maxLength ?? 2048, 2048));
      if (schema.minLength !== undefined) value = value.min(schema.minLength);
      if (schema.pattern) value = value.regex(new RegExp(schema.pattern));
      if (schema.format === "date-time") value = value.datetime({ offset: true });
      result = schema.format === "date" ? value.regex(/^\d{4}-\d{2}-\d{2}$/).refine(
        (s) => Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s,
        "Expected a valid YYYY-MM-DD calendar date",
      ) : value;
      break;
    }
    case "integer":
    case "number": {
      let value = z.number().finite();
      if (schema.type === "integer") value = value.int();
      if (schema.format === "int32") value = value.min(-2147483648).max(2147483647);
      if (schema.minimum !== undefined) value = value.min(schema.minimum);
      if (schema.maximum !== undefined) value = value.max(schema.maximum);
      result = value;
      break;
    }
    case "boolean": result = z.boolean(); break;
    case "array": {
      if (!schema.items) throw new Error("Array parameter missing item schema");
      let value = z.array(schemaToZod(schema.items)).max(Math.min(schema.maxItems ?? 500, 500));
      if (schema.minItems !== undefined) value = value.min(schema.minItems);
      result = schema.uniqueItems ? value.refine((items) => new Set(items.map((v) => JSON.stringify(v))).size === items.length, "Array items must be unique") : value;
      break;
    }
    default: throw new Error(`Unsupported OpenAPI parameter type: ${schema.type}`);
  }
  if (schema.enum) result = result.refine((value) => schema.enum!.includes(value as string), `Allowed values: ${schema.enum.join(", ")}`);
  return result;
}

export function endpointInputShape(endpoint: Endpoint): z.ZodRawShape {
  const shape: z.ZodRawShape = {};
  for (const parameter of endpoint.parameters) {
    let schema = schemaToZod(parameter.schema);
    if (!parameter.required) schema = schema.optional();
    // Enum constraints also appear in the schema sent to MCP clients.
    if (parameter.schema.type === "string" && parameter.schema.enum?.every((v) => typeof v === "string")) {
      schema = z.enum(parameter.schema.enum as [string, ...string[]]);
      if (!parameter.required) schema = schema.optional();
    }
    shape[parameter.name] = schema.describe(parameter.description || `${parameter.in} parameter: ${parameter.name}`);
  }
  shape._limit = PAGE_LIMIT;
  shape._offset = PAGE_OFFSET;
  return shape;
}

export const endpointTools = endpointCatalog.endpoints.map((endpoint) => ({
  ...endpoint,
  description: `${endpoint.description || endpoint.title}\nGET ${endpoint.path}${endpoint.deprecated ? " (deprecated)" : ""}. Native API parameters; response pagination uses _limit/_offset. Large upstream responses require narrower API filters.`,
  inputShape: endpointInputShape(endpoint),
}));
const byName = new Map(endpointTools.map((endpoint) => [endpoint.name, endpoint]));

function serializedArray(value: unknown[], parameter: EndpointParameter): [string, string][] {
  if (parameter.style === "spaceDelimited") return [[parameter.name, value.join(" ")]];
  if (parameter.style === "pipeDelimited") return [[parameter.name, value.join("|")]];
  if (parameter.explode === false) return [[parameter.name, value.join(",")]];
  return value.map((item) => [parameter.name, String(item)]);
}

export function buildEndpointUrl(endpoint: Endpoint, args: Record<string, unknown>): URL {
  let path = endpoint.path;
  for (const parameter of endpoint.parameters.filter((p) => p.in === "path")) {
    const value = String(args[parameter.name]);
    // Dot segments and slash-like encoded values must never change the fixed route.
    if (!value || /[\\/%?#]/.test(value) || value === "." || value === "..") throw new ToolError(`Unsafe path value for ${parameter.name}.`);
    path = path.replace(`{${parameter.name}}`, encodeURIComponent(value));
  }
  if (/[{}]/.test(path)) throw new ToolError("A required path parameter is missing.");
  const url = new URL(BASE + path);
  if (url.origin !== new URL(BASE).origin || !url.pathname.startsWith("/bmrs/api/v1/")) throw new ToolError("Invalid API path.");
  for (const parameter of endpoint.parameters.filter((p) => p.in === "query")) {
    const value = args[parameter.name];
    if (value === undefined) continue;
    const pairs: [string, string][] = Array.isArray(value)
      ? serializedArray(value, parameter) : [[parameter.name, String(value)]];
    for (const [key, item] of pairs) url.searchParams.append(key, item);
  }
  const format = endpoint.parameters.find((p) => p.name === "format" && p.in === "query");
  if (format && !url.searchParams.has("format") && format.schema.enum?.includes("json")) url.searchParams.set("format", "json");
  if (url.toString().length > 16000) throw new ToolError("Query URL is too long. Use fewer filter values.");
  return url;
}

function validateTimeOrder(endpoint: Endpoint, args: Record<string, unknown>) {
  const pairs = [["from", "to"], ["fromDate", "toDate"], ["startTime", "endTime"], ["startDate", "endDate"], ["eventStart", "eventEnd"], ["snapshotAt", "until"]];
  for (const parameter of endpoint.parameters) {
    if (parameter.name.endsWith("From")) pairs.push([parameter.name, parameter.name.replace(/From$/, "To")]);
  }
  for (const [start, end] of pairs) {
    if (typeof args[start] !== "string" || typeof args[end] !== "string") continue;
    const a = Date.parse(args[start] as string), b = Date.parse(args[end] as string);
    if (Number.isFinite(a) && Number.isFinite(b) && b < a) throw new ToolError(`${end} must not precede ${start}.`);
  }
}

export async function runEndpointTool(name: string, input: unknown) {
  const endpoint = byName.get(name);
  if (!endpoint) throw new ToolError("Unknown Elexon endpoint tool.");
  const parsed = z.object(endpoint.inputShape).strict().safeParse(input);
  if (!parsed.success) throw new ToolError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const args = parsed.data;
  validateTimeOrder(endpoint, args);
  const url = buildEndpointUrl(endpoint, args).toString();
  const result = await loadUpstream(url);
  const offset = args._offset as number, limit = args._limit as number;
  const data: Record<string, unknown>[] = [];
  let bytes = Buffer.byteLength(JSON.stringify(result.metadata));
  if (bytes > 120000) throw new ToolError("Upstream metadata is too large to return. Narrow the API filters.", 502, "size_limit");
  for (const row of result.rows.slice(offset, offset + limit)) {
    const size = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (bytes + size > 120000) {
      if (!data.length) throw new ToolError("A single upstream record exceeds the MCP response limit. Narrow the upstream query or use a more specific endpoint.", 502, "size_limit");
      break;
    }
    data.push(row);
    bytes += size;
  }
  const nextOffset = offset + data.length < result.rows.length ? offset + data.length : null;
  return {
    tool: name, source: "Elexon Insights", sourceUrl: url,
    fetchedAt: result.fetchedAt, cached: result.cached, count: data.length,
    totalCount: result.rows.length, truncated: nextOffset !== null, data, metadata: result.metadata, nextOffset,
    note: `Native GET ${endpoint.path}. Native units, filters and interval semantics apply; nested records are preserved. ${nextOffset === null ? "" : `Continue with _offset=${nextOffset} and the same filters. `}Pagination is over this bounded upstream response, not the entire Elexon archive; upstream metadata is preserved. Data may change between pages after cache expiry. fetchedAt is the original public-source download time, including cache hits.${result.rows.length === 0 ? " No matching data; this is not a zero value." : ""}${endpoint.deprecated ? " Elexon marks this endpoint deprecated." : ""}`,
  };
}

export function endpointToolCatalog() {
  const date = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  return endpointTools.map((endpoint) => {
    const example: Record<string, unknown> = {};
    for (const parameter of endpoint.parameters) {
      const schema = parameter.schema;
      if (parameter.name === "format") { example.format = "json"; continue; }
      if (!parameter.required) continue;
      const value = parameter.example ?? schema.example ?? schema.default ?? schema.enum?.[0];
      const validExample = value !== undefined && schemaToZod(schema).safeParse(value).success;
      example[parameter.name] = validExample ? value : (
        schema.type === "array" ? [schema.items?.enum?.[0] ?? (schema.items?.type === "integer" ? 1 : "EXAMPLE")]
        : schema.type === "boolean" ? false
        : schema.type === "integer" || schema.type === "number" ? schema.minimum ?? 1
        : schema.format === "date" ? date
        : schema.format === "date-time" ? `${date}T${/To$|^to$|^until$|^end/i.test(parameter.name) ? "01" : "00"}:00:00Z`
        : "EXAMPLE"
      );
    }
    // Add a narrow example window to date-filtered datasets rather than requesting the whole archive.
    const datePairs = [["from", "to"], ["publishDateTimeFrom", "publishDateTimeTo"], ["settlementDateFrom", "settlementDateTo"],
      ...endpoint.parameters.filter((p) => p.name.endsWith("From") && ["date", "date-time"].includes(p.schema.format ?? "")).map((p) => [p.name, p.name.replace(/From$/, "To")])];
    for (const [start, end] of datePairs) {
      const a = endpoint.parameters.find((p) => p.name === start), b = endpoint.parameters.find((p) => p.name === end);
      if (a && b) {
        example[start] = a.schema.format === "date" ? date : `${date}T00:00:00Z`;
        example[end] = b.schema.format === "date" ? date : `${date}T01:00:00Z`;
        break;
      }
    }
    example._limit = 100;
    const properties = Object.fromEntries(endpoint.parameters.map((p) => [p.name, { ...p.schema, description: p.description }]));
    properties._limit = { type: "integer", minimum: 1, maximum: 500, default: 100, description: PAGE_LIMIT.description! };
    properties._offset = { type: "integer", minimum: 0, default: 0, description: PAGE_OFFSET.description! };
    return {
      name: endpoint.name, title: endpoint.title, description: endpoint.description, category: endpoint.category,
      path: endpoint.path, method: "GET", kind: "endpoint" as const, deprecated: endpoint.deprecated,
      inputSchema: { type: "object", properties, required: endpoint.parameters.filter((p) => p.required).map((p) => p.name), additionalProperties: false },
      parameters: [
        ...endpoint.parameters.map((p) => ({ name: p.name, type: p.schema.type === "array" ? `${p.schema.items?.type}[]` : p.schema.type, required: p.required, description: p.description || `${p.in} parameter`, location: p.in, schema: p.schema as unknown as Record<string, unknown> })),
        { name: "_limit", type: "integer", required: false, description: PAGE_LIMIT.description!, location: "local", schema: properties._limit },
        { name: "_offset", type: "integer", required: false, description: PAGE_OFFSET.description!, location: "local", schema: properties._offset },
      ],
      example,
    };
  });
}
