export const INTERVAL_SECONDS = 300;
export const RETENTION_DAYS = 400;
export const STALE_MS = 600000;
export const TIMEOUT_MS = 12000;
export const SLOW_MS = 2000;
export type TargetId = "elexon" | "mcp";
export type Probe = {
  target: TargetId; checkedAt: string; status: "up" | "degraded" | "down";
  responseMs: number | null; httpStatus: number | null; reason: string;
};
export function monitorTargets() {
  let app: string | null = null;
  if (process.env.MONITOR_APP_URL) {
    const url = new URL(process.env.MONITOR_APP_URL);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" || url.hostname === "localhost" || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(":")) throw new Error("MONITOR_APP_URL must be the public HTTPS origin of the published app, not a development URL, credential or private address.");
    if (url.hostname.endsWith(".replit.dev")) throw new Error("Monitor the published production URL, not the private development preview.");
    app = `${url.origin}/api/server`;
  }
  return [
    { id: "elexon" as const, name: "Elexon Insights API", url: "https://data.elexon.co.uk/bmrs/api/v1/reference/fueltypes/all?format=json" },
    { id: "mcp" as const, name: "MCP application API", url: app },
  ];
}

export async function probeTarget(target: TargetId, url: string, options: {
  fetcher?: typeof fetch; timeoutMs?: number; clock?: () => number;
} = {}): Promise<Probe> {
  const started = Date.now(), clock = options.clock ?? (() => performance.now()), begin = clock();
  const result: Probe = { target, checkedAt: new Date(started).toISOString(), status: "down", responseMs: null, httpStatus: null, reason: "Network request failed" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS);
  try {
    // Fixed configured endpoints only. No user-supplied URL, no upstream cache
    // and no redirect can turn a health probe into an arbitrary network request.
    const response = await (options.fetcher ?? fetch)(url, {
      signal: controller.signal, redirect: "manual", cache: "no-store",
      headers: { Accept: "application/json", "Cache-Control": "no-cache", "User-Agent": "Elexon-MCP-Independent-Monitor/1.0" },
    });
    result.httpStatus = response.status;
    if (!response.ok) {
      await response.body?.cancel();
      result.responseMs = Math.max(0, Math.round(clock() - begin));
      result.reason = `HTTP ${response.status}`;
      return result;
    }
    const reader = response.body?.getReader();
    let text = "", bytes = 0;
    if (reader) {
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.length;
          if (bytes > 65536) {
            await reader.cancel();
            result.reason = "Unexpectedly large health response";
            result.responseMs = Math.max(0, Math.round(clock() - begin));
            return result;
          }
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally { reader.releaseLock(); }
    }
    result.responseMs = Math.max(0, Math.round(clock() - begin));
    let body: unknown;
    try { body = JSON.parse(text); } catch { result.reason = "Invalid JSON health response"; return result; }
    const valid = target === "elexon"
      ? Array.isArray(body) && body.length > 0 && body.every((value) => typeof value === "string") && body.includes("WIND")
      : body !== null && typeof body === "object" && "status" in body && body.status === "online" && "toolCount" in body && typeof body.toolCount === "number" && body.toolCount > 0;
    if (!valid) { result.reason = "Unexpected health response structure"; return result; }
    result.status = result.responseMs > SLOW_MS ? "degraded" : "up";
    result.reason = result.status === "degraded" ? "Valid response slower than 2 seconds" : "HTTP success and expected response verified";
    return result;
  } catch {
    result.reason = controller.signal.aborted ? "Request timed out" : "Network or TLS request failed";
    return result;
  } finally { clearTimeout(timer); }
}
