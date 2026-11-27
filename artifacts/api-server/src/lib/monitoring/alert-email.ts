import { ReplitConnectors, type ProxyOptions } from "@replit/connectors-sdk";
import type { AlertTransition } from "./alert-policy";

export type EmailPayload = { from: string; to: string[]; subject: string; text: string };
export function alertEmail(event: AlertTransition, from: string, to: string): EmailPayload {
  const name = { elexon: "Elexon Insights API", mcp: "MCP application API", checker: "Independent API checker" }[event.subject];
  const status = event.kind === "recovery" ? "recovered" : event.subject === "checker" ? "stale" : "down";
  return {
    from, to: [to], subject: `[Grid MCP] ${name}: ${status}`,
    text: `${name}: ${status}\nObserved at ${new Date(event.at).toISOString()}.\n\n` +
      (event.subject === "checker"
        ? "Checker coverage is stale after ten minutes without a complete set of checks. Recovery requires two complete consecutive slots. Missing observations are unknown, not API downtime."
        : "This transition requires two consecutive five-minute observations. Slow but valid responses count as successful. Observations do not establish the exact time an outage began or ended.") +
      "\n\nReview the Health page and independent checker logs. To stop these emails, set MONITOR_EMAIL_ENABLED=false in the checker and watchdog environments.",
  };
}

type Proxy = (path: string, options: ProxyOptions) => Promise<Response>;
export async function deliverAlert(id: string, payload: EmailPayload, proxy: Proxy =
  (path, options) => new ReplitConnectors().proxy("resend", path, options)) {
  const response = await proxy("/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": id },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  // Do not log provider response bodies: they may include addresses or secrets.
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Email provider returned HTTP ${response.status}`);
  }
  const body = await response.json() as { id?: unknown };
  if (typeof body.id !== "string") throw new Error("Email provider did not acknowledge delivery");
}
