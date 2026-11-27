import { z } from "zod";
import { PublicObservationCache } from "./public-observations";

const BASE = "https://data.elexon.co.uk/bmrs/api/v1";
export const CACHE_TTL_SECONDS = 30;

export class ToolError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code?: "upstream_http" | "rate_limit" | "size_limit" | "invalid_json" | "transport",
    public upstreamStatus?: number,
  ) {
    super(message);
  }
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(
  (s) => Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s,
  "Use a valid calendar date, YYYY-MM-DD",
);
const timestamp = z.string().datetime({ offset: true }).describe("ISO 8601 timestamp with Z or explicit UTC offset.");
const pagination = {
  limit: z.number().int().min(1).max(500).default(100).describe("Maximum rows to return, 1–500."),
  offset: z.number().int().min(0).max(10000).default(0).describe("Rows to skip; use for pagination."),
};
const rangeShape = {
  from: timestamp.describe("Inclusive start timestamp. Maximum range 24 hours."),
  to: timestamp.describe("Exclusive end timestamp, after from; maximum range 24 hours."),
  ...pagination,
};
const priceShape = {
  settlement_date: date.describe("Great Britain settlement date in Europe/London, YYYY-MM-DD."),
  settlement_period: z.number().int().min(1).max(50).optional().describe("Optional settlement period. Normally 1–48; DST days have 46 or 50."),
  ...pagination,
};

type ToolDefinition = {
  name: string;
  title: string;
  category: string;
  description: string;
  inputShape: z.ZodRawShape;
  path: string;
  note: string;
};

export const tools: ToolDefinition[] = [
  {
    name: "get_system_prices", title: "System prices", category: "Prices",
    description: "Get Great Britain settlement system buy and sell prices for one Europe/London settlement date, optionally one period. Latest available settlement run; not retail tariffs. Prices GBP/MWh, volumes MWh. Data may be revised.",
    inputShape: priceShape, path: "/balancing/settlement/system-prices",
    note: "Prices in GBP/MWh, balancing volumes in MWh. Latest available settlement run, subject to revision. Settlement dates are Europe/London; DST days may have 46 or 50 periods.",
  },
  {
    name: "get_generation_by_fuel", title: "Generation by fuel", category: "Generation",
    description: "Get actual aggregated electricity generation by production/fuel type in MW (AGPT). ISO timestamps with offsets, maximum 24 hours, [from,to). Each row is a fuel type and settlement period. Data may be revised.",
    inputShape: rangeShape, path: "/generation/actual/per-type",
    note: "Generation quantity in MW (power, not MWh). Fuel categories preserved from Elexon. UTC timestamps; interval is [from,to).",
  },
  {
    name: "get_demand_outturn", title: "Demand outturn", category: "Demand",
    description: "Get initial national demand and transmission system demand outturn in MW (INDO/ITSDO). ISO timestamps with offsets, maximum 24 hours, [from,to). Initial figures may be revised.",
    inputShape: rangeShape, path: "/demand/outturn",
    note: "Initial demand and transmission system demand in MW, subject to revision. UTC timestamps; interval is [from,to).",
  },
  {
    name: "get_wind_forecast", title: "Wind forecast", category: "Forecasts",
    description: "Get latest available wind generation forecasts in MW for a time window (WINDFOR). ISO timestamps with offsets, maximum 24 hours, [from,to). Latest forecasts can have been published after the target period; not a historical as-of view.",
    inputShape: rangeShape, path: "/forecast/generation/wind/latest",
    note: "Wind forecast generation in MW. Latest available forecast, not necessarily one published before delivery. UTC timestamps; interval is [from,to).",
  },
];

function londonDate(instant: number): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(instant));
  const value = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function toolCatalog() {
  const yesterday = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  return tools.map(({ inputShape, path: _path, note: _note, ...tool }) => ({
    ...tool,
    parameters: Object.entries(inputShape).map(([name, schema]) => ({
      name, type: ["limit", "offset", "settlement_period"].includes(name) ? "integer" : "string",
      required: !schema.isOptional(), description: schema.description ?? "",
    })),
    example: tool.name === "get_system_prices"
      ? { settlement_date: yesterday }
      : { from: `${yesterday}T00:00:00Z`, to: `${yesterday}T06:00:00Z`, limit: 100 },
  }));
}

type Row = Record<string, unknown>;
type CacheEntry = { expires: number; fetchedAt: string; rows: Row[]; metadata: Row; bytes: number };
const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<CacheEntry>>();
const historicalObservations = new PublicObservationCache();
let activeFetches = 0;
let upstreamCooldownUntil = 0;

async function readBounded(response: globalThis.Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new ToolError("Elexon response too large. Narrow the upstream filters or use a smaller time window. Local pagination cannot reduce the upstream download.", 502, "size_limit");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function fetchRows(url: string): Promise<CacheEntry> {
  if (Date.now() < upstreamCooldownUntil) throw new ToolError("Elexon rate limit reached. Please retry in one minute.", 429, "rate_limit");
  if (activeFetches >= 8) throw new ToolError("Server is busy. Please retry shortly.", 429);
  activeFetches++;
  try {
    let response: globalThis.Response | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "Elexon-MCP/1.0" },
        signal: AbortSignal.timeout(15000),
        redirect: "manual",
      });
      if (response.status === 429) {
        await response.body?.cancel();
        upstreamCooldownUntil = Date.now() + 60000;
        throw new ToolError("Elexon rate limit reached. Please retry in one minute.", 429, "rate_limit", 429);
      }
      if (response.status < 500 || attempt === 1) break;
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    if (!response?.ok) {
      let detail = "";
      try { detail = (await readBounded(response!, 8192)).slice(0, 2000); } catch { /* Status is still reported if the error body is oversized. */ }
      throw new ToolError(`Elexon returned HTTP ${response?.status ?? "error"}${detail ? `: ${detail}` : "."}${response?.status && response.status >= 300 && response.status < 400 ? " This legacy endpoint redirects; use its current replacement from the catalog." : ""}`, 502, "upstream_http", response?.status);
    }
    const body = await readBounded(response, 4_000_000);
    const contentType = response.headers.get("content-type") ?? "";
    let json: unknown;
    if (contentType.includes("json") || /^[\s]*[\[{]/.test(body)) {
      try {
        json = body ? JSON.parse(body) : [];
      } catch {
        throw new ToolError("Elexon returned invalid JSON.", 502, "invalid_json", response.status);
      }
    } else {
      json = body ? { text: body, contentType } : [];
    }
    const object = json && typeof json === "object" && !Array.isArray(json) ? json as Row : undefined;
    const raw = object && Array.isArray(object.data) ? object.data : Array.isArray(json) ? json : [json];
    const metadata = object && Array.isArray(object.data)
      ? Object.fromEntries(Object.entries(object).filter(([key]) => key !== "data")) : {};
    const rows = raw.map((row: unknown) => row && typeof row === "object" && !Array.isArray(row) ? row as Row : { value: row });
    return { rows, metadata, bytes: Buffer.byteLength(body), fetchedAt: new Date(Date.now()).toISOString(), expires: Date.now() + CACHE_TTL_SECONDS * 1000 };
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError("Unable to retrieve Elexon data. The upstream service timed out or returned invalid data. Please retry.", 502, "transport");
  } finally {
    activeFetches--;
  }
}

export async function loadUpstream(key: string) {
  const historical = historicalObservations.get(key);
  if (historical) return { ...historical, cached: true };
  let entry = cache.get(key);
  const cached = !!entry && entry.expires > Date.now();
  if (!cached) {
    let promise = pending.get(key);
    if (!promise) {
      promise = fetchRows(key).then((result) => {
        historicalObservations.set(key, result);
        for (const [cacheKey, value] of cache) if (value.expires <= Date.now()) cache.delete(cacheKey);
        while (cache.size >= 50 || [...cache.values()].reduce((sum, value) => sum + value.bytes, 0) + result.bytes > 24_000_000) {
          const oldest = cache.keys().next().value;
          if (!oldest) break;
          cache.delete(oldest);
        }
        cache.set(key, result);
        return result;
      }).finally(() => pending.delete(key));
      pending.set(key, promise);
    }
    entry = await promise;
  }
  // Never lend cached objects to a caller that could mutate retained evidence.
  return { ...structuredClone(entry!), cached };
}

export async function runTool(name: string, input: unknown) {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new ToolError("Unknown tool. Use the tool catalog to select a supported tool.");
  const parsed = z.object(tool.inputShape).strict().safeParse(input);
  if (!parsed.success) throw new ToolError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const args = parsed.data;
  let from = 0;
  let to = 0;
  const url = new URL(BASE + tool.path);
  url.searchParams.set("format", "json");
  if (name === "get_system_prices") {
    url.pathname += `/${args.settlement_date}`;
    if (args.settlement_period !== undefined) url.pathname += `/${args.settlement_period}`;
  } else {
    from = Date.parse(args.from);
    to = Date.parse(args.to);
    if (!(to > from) || to - from > 86400000) throw new ToolError("to must be after from, with a maximum time range of 24 hours.");
    if (name === "get_demand_outturn") {
      url.searchParams.set("settlementDateFrom", londonDate(from));
      url.searchParams.set("settlementDateTo", londonDate(to - 1));
    } else {
      url.searchParams.set("from", new Date(from).toISOString());
      url.searchParams.set("to", new Date(to).toISOString());
    }
  }
  const key = url.toString();
  const entry = await loadUpstream(key);
  const { cached } = entry;
  let rows = entry.rows;
  if (name !== "get_system_prices") {
    rows = rows.filter((row) => {
      const time = Date.parse(String(row.startTime));
      return time >= from && time < to;
    });
  }
  if (name === "get_generation_by_fuel") {
    rows = rows.flatMap(({ data, ...period }) => {
      if (!Array.isArray(data)) throw new ToolError("Elexon returned an unexpected generation format.", 502);
      return data.map((fuel: Row) => ({ ...period, ...fuel }));
    });
  }
  const offset = args.offset as number;
  const limit = args.limit as number;
  const data = rows.slice(offset, offset + limit);
  return {
    tool: name, source: "Elexon Insights", sourceUrl: key, fetchedAt: entry!.fetchedAt,
    cached, count: data.length, totalCount: rows.length,
    truncated: offset + data.length < rows.length, data,
    note: `${tool.note} Source: Elexon Insights. ${offset + data.length < rows.length ? `More rows available: retry with offset ${offset + data.length}.` : ""}${rows.length === 0 ? " No data available for this interval; this is not a zero value." : ""}`,
  };
}
