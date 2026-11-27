import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ToolError } from "../elexon";
import { normalizeResult, unitFor, type Dataset } from "./validation";
import { londonDate, questionInterval } from "./dates";

const pageSchema = z.object({
  data: z.array(z.record(z.unknown())),
  truncated: z.boolean(),
  totalCount: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable().optional(),
}).passthrough();

export function measurementQuery(tool: Tool, args: Record<string, unknown>, question: string) {
  if (/\bpublication\b|\bpublished\b|\bpublish time\b/i.test(question)) return { args };
  const interval = questionInterval(question);
  if (!interval) return { args };
  const { from, to } = interval;
  if (tool.name === "get_generation_by_fuel") return { args: { ...args, from: new Date(from).toISOString(), to: new Date(to).toISOString() }, interval };
  // FUEL datasets expose publication-time filters, which are not observation
  // filters. Retrieve settlement days, then apply the requested measurement range.
  if (!/^elexon_get_datasets_fuel(?:hh|inst)$/.test(tool.name)) return { args };
  const filters = { ...args };
  delete filters.publishDateTimeFrom;
  delete filters.publishDateTimeTo;
  delete filters.settlementPeriod;
  filters.settlementDateFrom = londonDate(new Date(from));
  filters.settlementDateTo = londonDate(new Date(to - 1));
  return { args: filters, interval: { from, to } };
}

// Local MCP pagination is deterministic backend work, not a task to leave to the
// model. Keep filters unchanged and merge the evidence before charting/statistics.
export async function retrieveDataset(
  client: Client, tool: Tool, args: Record<string, unknown>, id: string,
  signal: AbortSignal, progress: (message: string) => void, question = "",
): Promise<Dataset> {
  const measurement = measurementQuery(tool, args, question);
  const filters = measurement.args;
  const windows: Record<string, unknown>[] = [];
  if (/^elexon_get_datasets_fuel(?:hh|inst)$/.test(tool.name) && typeof filters.settlementDateFrom === "string" && typeof filters.settlementDateTo === "string") {
    const from = Date.parse(filters.settlementDateFrom), to = Date.parse(filters.settlementDateTo);
    if (![filters.settlementDateFrom, filters.settlementDateTo].every((day) => Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day)) {
      throw new ToolError("Historical fuel windows require valid YYYY-MM-DD settlement dates.");
    }
    for (let time = from; Number.isFinite(time) && time <= to; time += 86400000) {
      const day = new Date(time).toISOString().slice(0, 10);
      windows.push({ ...filters, settlementDateFrom: day, settlementDateTo: day, _offset: 0 });
    }
  } else if (["get_generation_by_fuel", "get_demand_outturn", "get_wind_forecast"].includes(tool.name)) {
    const from = Date.parse(String(filters.from)), to = Date.parse(String(filters.to));
    for (let time = from; Number.isFinite(time) && time < to; time += 86400000) {
      windows.push({ ...filters, from: new Date(time).toISOString(), to: new Date(Math.min(to, time + 86400000)).toISOString(), offset: 0 });
    }
  }
  if (windows.length <= 1) return retrievePages(client, tool, measurement.args, id, signal, progress, question);
  let merged: Dataset | undefined;
  const sources: { arguments: Record<string, unknown>; sourceUrl?: string; fetchedAt?: string; count: number; incomplete: boolean }[] = [];
  const failures: string[] = [];
  let allComplete = true;
  for (const [index, window] of windows.entries()) {
    signal.throwIfAborted();
    progress(`Retrieving date window ${index + 1} of ${windows.length}…`);
    try {
      // Do not reapply the full question to each window: that would undo splitting.
      const part = await retrievePages(client, tool, window, id, signal, progress);
      sources.push({ arguments: window, sourceUrl: part.sourceUrl, fetchedAt: part.fetchedAt, count: part.count, incomplete: part.truncated || !part.rows.length });
      allComplete &&= !part.truncated;
      if (!merged) merged = part;
      else merged.rows.push(...part.rows);
      if (!part.rows.length) { allComplete = false; failures.push(`Window ${index + 1} returned no observations (not zero generation).`); }
      if (part.truncated) failures.push(`Window ${index + 1}: ${part.note}`);
    } catch (error) {
      signal.throwIfAborted();
      allComplete = false;
      failures.push(`Window ${index + 1}: ${error instanceof ToolError ? error.message : "could not retrieve data"}`);
      sources.push({ arguments: window, count: 0, incomplete: true });
    }
  }
  if (!merged) throw new ToolError(`No date windows could be retrieved. ${failures.join(" ")}`, 502);
  if (measurement.interval) {
    const { from, to } = measurement.interval;
    if (merged.rows.every((row) => typeof row.startTime === "string" && Number.isFinite(Date.parse(row.startTime)))) {
      merged.rows = merged.rows.filter((row) => { const time = Date.parse(String(row.startTime)); return time >= from && time < to; });
    } else { allComplete = false; failures.push("Measurement timestamps are missing or invalid; requested coverage cannot be verified."); }
  }
  merged.count = merged.rows.length;
  merged.totalCount = merged.count;
  merged.truncated = !allComplete;
  merged.nextOffset = null;
  merged.arguments = { ...filters };
  merged.columns = [...new Set(merged.rows.flatMap(Object.keys))].map((key) => ({ key, unit: unitFor(key, merged.rows, tool.description ?? "") }));
  const times = merged.rows.map((row) => row.startTime).filter((time): time is string => typeof time === "string").sort();
  merged.coverage = times.length ? `${times[0]} through ${times.at(-1)} (observed measurement times across requested date windows)` : "No measurement timestamps available";
  merged.metadata = { ...merged.metadata, windows: sources, requestedInterval: measurement.interval ?? null, incomplete: !allComplete };
  merged.note = `Combined ${sources.length} non-overlapping date windows, fully paginating each window. ${allComplete ? "All filtered responses were retrieved; this does not prove every expected observation was published." : "Retrieval is incomplete; do not claim full interval coverage."} ${failures.join(" ")}`;
  return merged;
}

async function retrievePages(
  client: Client, tool: Tool, args: Record<string, unknown>, id: string,
  signal: AbortSignal, progress: (message: string) => void, question = "",
): Promise<Dataset> {
  const measurement = measurementQuery(tool, args, question);
  args = measurement.args;
  const properties = tool.inputSchema.properties ?? {};
  const offsetKey = "_offset" in properties ? "_offset" : "offset" in properties ? "offset" : undefined;
  const limitKey = "_limit" in properties ? "_limit" : "limit" in properties ? "limit" : undefined;
  let offset = Number(offsetKey ? args[offsetKey] ?? 0 : 0);
  const pageArgs = { ...args, ...(limitKey ? { [limitKey]: 500 } : {}) };
  let combined: Dataset | undefined;
  let expected: number | undefined;
  let pages = 0;
  let clipped = false;
  for (;;) {
    signal.throwIfAborted();
    try {
      const filters = { ...pageArgs, ...(offsetKey ? { [offsetKey]: offset } : {}) };
      const result = await client.callTool({ name: tool.name, arguments: filters }, undefined, { signal, timeout: 22000 });
      const text = (result.content as { type: string; text?: string }[]).find((c) => c.type === "text")?.text;
      if (result.isError) throw new ToolError((text ?? "Elexon data unavailable.").replace(/[\u0000-\u001f]/g, " ").slice(0, 600), 502);
      const raw = result.structuredContent ?? JSON.parse(text ?? "{}");
      const page = pageSchema.parse(raw);
      if (expected !== undefined && expected !== page.totalCount) throw new ToolError("The upstream result changed during pagination. Retry to retrieve a consistent interval.", 502);
      if (combined && raw && typeof raw === "object" && "fetchedAt" in raw && raw.fetchedAt !== combined.fetchedAt) {
        throw new ToolError("The source was refreshed during pagination. Retry to retrieve a consistent revision.", 502);
      }
      expected = page.totalCount;
      const normalized = normalizeResult(raw, filters, id, tool.description ?? "");
      clipped ||= normalized.note.includes("Additional cell content") || normalized.metadata?.incomplete === true;
      pages++;
      if (!combined) combined = normalized;
      else combined.rows.push(...normalized.rows);
      combined.count = combined.rows.length;
      progress(`Retrieved page ${pages}: ${combined.count} observations collected for the same filters…`);
      if (!page.truncated) {
        combined.truncated = clipped;
        combined.nextOffset = null;
        break;
      }
      const next = page.nextOffset ?? offset + page.data.length;
      if (!offsetKey || !page.data.length || next <= offset || !Number.isSafeInteger(next)) {
        throw new ToolError("The source reported more data but did not provide a usable advancing page. The retained result is incomplete.", 502);
      }
      offset = next;
    } catch (error) {
      signal.throwIfAborted();
      if (!combined) throw error;
      combined.truncated = true;
      combined.nextOffset = offset;
      combined.note += ` Pagination stopped: ${error instanceof ToolError ? error.message : "An additional page could not be retrieved."}`;
      break;
    }
  }
  if (!combined) throw new ToolError("No Elexon response was returned.", 502);
  if (measurement.interval) {
    const { from, to } = measurement.interval;
    const received = combined.rows.length;
    const hasTimes = combined.rows.every((row) => typeof row.startTime === "string" && Number.isFinite(Date.parse(row.startTime)));
    if (hasTimes) {
      combined.rows = combined.rows.filter((row) => { const time = Date.parse(String(row.startTime)); return time >= from && time < to; });
      combined.count = combined.rows.length;
      combined.metadata = { ...combined.metadata, requestedInterval: { from, to }, measurementFilter: { from: new Date(from).toISOString(), toExclusive: new Date(to).toISOString(), excludedOutsideInterval: received - combined.count } };
      combined.note += ` Settlement-day records were filtered by measurement startTime to [${new Date(from).toISOString()}, ${new Date(to).toISOString()}); publication timestamps were not substituted for measurements.`;
    } else {
      combined.truncated = true;
      combined.note += " Measurement timestamps were missing or invalid, so requested interval coverage could not be verified.";
    }
  }
  combined.arguments = { ...args };
  const keys = [...new Set(combined.rows.flatMap(Object.keys))];
  combined.columns = keys.map((key) => ({ key, unit: unitFor(key, combined.rows, tool.description ?? "") }));
  combined.totalCount = combined.truncated ? Math.max(combined.count, expected ?? 0) : combined.count;
  const hasMeasurementTime = combined.rows.some((row) => typeof row.startTime === "string");
  const dates = combined.rows.flatMap((row) => Object.entries(row)
    .filter(([key, value]) => (hasMeasurementTime ? /^startTime$/i : /^(settlementDate|measurementTime|date|time)$/i).test(key) && typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value))
    .map(([, value]) => String(value))).sort();
  if (dates.length) combined.coverage = `${dates[0]} through ${dates.at(-1)} (observed measurement/settlement fields; exact query filters below)`;
  combined.note = combined.note.replace(/Continue with _offset=\d+ and the same filters\.\s*/g, "")
    .replace(/More rows available: retry with offset \d+\.\s*/g, "");
  combined.note += ` Retrieved ${pages} MCP page(s), up to 500 source records per page, with unchanged upstream filters. ${combined.truncated ? "Retrieval is incomplete; do not claim full interval coverage." : "All pages of the filtered upstream response were retrieved; this is not a claim of entire-archive coverage."}`;
  return combined;
}
