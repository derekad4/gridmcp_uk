import { z } from "zod";
import { buildEndpointUrl, endpointCatalog, runEndpointTool } from "./endpoint-tools";
import { ToolError } from "./elexon";

// Deliberately small usability contracts, not full OpenAPI response validation.
// Passthrough allows additive fields without hiding missing/renamed core fields.
const fuel = z.object({ fuelType: z.string(), generation: z.number().finite() }).passthrough();
const contracts = {
  prices: z.object({
    settlementDate: z.string(), settlementPeriod: z.number().int(),
    systemBuyPrice: z.number().finite(), systemSellPrice: z.number().finite(),
  }).passthrough(),
  generation: z.object({
    startTime: z.string().datetime({ offset: true }),
    data: z.array(z.object({ psrType: z.string(), quantity: z.number().finite() }).passthrough()).min(1),
  }).passthrough(),
  demand: z.object({
    startTime: z.string().datetime({ offset: true }),
    initialDemandOutturn: z.number().finite(),
    initialTransmissionSystemDemandOutturn: z.number().finite(),
  }).passthrough(),
  fuel: fuel,
};

export function smokeSamples(now = new Date()) {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid smoke-check clock.");
  // Three completed UTC days ago avoids same-day publication lag. Never use
  // catalog examples or scan backwards until a response happens to contain data.
  const day = new Date(now.getTime() - 3 * 86_400_000).toISOString().slice(0, 10);
  const window = { from: `${day}T00:00:00Z`, to: `${day}T00:30:00Z` };
  const fuelArgs = {
    settlementDateFrom: day, settlementDateTo: day, settlementPeriod: [1], fuelType: ["NUCLEAR"],
  };
  return [
    { path: "/balancing/settlement/system-prices/{settlementDate}/{settlementPeriod}",
      args: { settlementDate: day, settlementPeriod: 1 }, contract: contracts.prices },
    { path: "/generation/actual/per-type", args: window, contract: contracts.generation },
    { path: "/demand/outturn", args: {
      settlementDateFrom: day, settlementDateTo: day, settlementPeriod: [1],
    }, contract: contracts.demand },
    { path: "/datasets/FUELHH", args: fuelArgs, contract: contracts.fuel },
    { path: "/datasets/FUELHH/stream", args: fuelArgs, contract: contracts.fuel },
  ];
}

export type SmokeOutcome = "ok" | "empty_valid" | "retired_or_missing" | "redirected"
  | "upstream_unavailable" | "rate_limited" | "schema_failure" | "size_limit"
  | "upstream_rejected" | "check_error";

export function classifySmokeError(error: unknown): SmokeOutcome {
  if (!(error instanceof ToolError)) return "check_error";
  if (error.code === "invalid_json") return "schema_failure";
  if (error.code === "size_limit") return "size_limit";
  if (error.code === "rate_limit" || error.status === 429) return "rate_limited";
  if (error.code === "transport") return "upstream_unavailable";
  if (error.upstreamStatus === 404 || error.upstreamStatus === 410) return "retired_or_missing";
  if (error.upstreamStatus && error.upstreamStatus >= 300 && error.upstreamStatus < 400) return "redirected";
  if (error.upstreamStatus && error.upstreamStatus >= 500) return "upstream_unavailable";
  if (error.code === "upstream_http") return "upstream_rejected";
  return "check_error";
}

export async function runEndpointSmoke(now = new Date()) {
  const results: {
    path: string; tool?: string; args: Record<string, unknown>; sourceUrl?: string;
    outcome: SmokeOutcome; count?: number; totalCount?: number; cached?: boolean;
    upstreamStatus?: number; detail?: string;
  }[] = [];
  // Sequential, one page per sample; no extra retries beyond the native loader.
  for (const sample of smokeSamples(now)) {
    const args = { ...sample.args, _limit: 5, _offset: 0 };
    const endpoint = endpointCatalog.endpoints.find((entry) => entry.path === sample.path);
    const record: (typeof results)[number] = {
      path: sample.path, tool: endpoint?.name, args, outcome: "check_error",
    };
    results.push(record);
    try {
      if (!endpoint) throw new Error("Sample endpoint is no longer advertised in the pinned catalog.");
      // Execution, including strict input validation, stays on the native path.
      const result = await runEndpointTool(endpoint.name, args);
      record.sourceUrl = result.sourceUrl;
      record.count = result.count;
      record.totalCount = result.totalCount;
      record.cached = result.cached;
      const parsed = z.array(sample.contract).safeParse(result.data);
      if (!parsed.success) {
        record.outcome = "schema_failure";
        record.detail = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ").slice(0, 2000);
      } else {
        record.outcome = result.totalCount === 0 ? "empty_valid" : "ok";
      }
    } catch (error) {
      if (endpoint) record.sourceUrl = buildEndpointUrl(endpoint, args).toString();
      record.outcome = classifySmokeError(error);
      record.upstreamStatus = error instanceof ToolError ? error.upstreamStatus : undefined;
      record.detail = error instanceof Error ? error.message.slice(0, 2000) : "Unknown smoke-check failure";
    }
  }
  return {
    checkedAt: now.toISOString(), specSha256: endpointCatalog.specSha256,
    scope: "Five fixed native endpoints; sampled usability contracts, not full API/schema coverage. No AI.",
    results,
    passed: results.every((result) => result.outcome === "ok" || result.outcome === "empty_valid"),
  };
}
