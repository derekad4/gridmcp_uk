import { Router, type IRouter } from "express";
import { GetApiMonitoringQueryParams, GetApiMonitoringResponse } from "@workspace/api-zod";
import rateLimit from "express-rate-limit";
import { monitoringSummary } from "../lib/monitoring/summary";
import { runManualCheck } from "../lib/monitoring/manual";

const router: IRouter = Router();
const reads = rateLimit({ windowMs: 60000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false });
router.get("/monitoring", reads, async (req, res): Promise<void> => {
  // Numeric enum query parameters arrive as strings. The generated schema
  // correctly validates numbers, but intentionally does not coerce literals.
  const days = req.query.days;
  const parsed = GetApiMonitoringQueryParams.safeParse({
    ...req.query, ...(typeof days === "string" && /^(1|7|30|90|365|400)$/.test(days) ? { days: Number(days) } : {}),
  });
  if (!parsed.success) { res.status(400).json({ error: "Choose 1, 7, 30, 90, 365 or 400 days." }); return; }
  try {
    const data = GetApiMonitoringResponse.parse(await monitoringSummary(parsed.data.days ?? 7, new Date(), undefined, "manual"));
    res.set("Cache-Control", "no-store").json(data);
  } catch {
    req.log.warn("Monitoring history could not be read. Verify the monitoring schema is published and PostgreSQL is reachable.");
    res.status(503).json({ error: "Monitoring storage is unavailable. Publish the monitoring schema and verify database access; no missing period has been counted as uptime." });
  }
});
const writes = rateLimit({ windowMs: 60000, limit: 6, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Too many checks. Please wait a minute." } });
router.post("/monitoring/check", writes, async (req, res): Promise<void> => {
  res.set("Cache-Control", "no-store");
  const origin = req.get("origin");
  let sameOrigin = false;
  try { sameOrigin = !!origin && new URL(origin).host === req.get("host"); } catch { /* Reject malformed origins. */ }
  if (!sameOrigin || req.get("sec-fetch-site") === "cross-site" || !req.is("application/json")) {
    res.status(403).json({ error: "Run checks from this site's Health page using a same-origin JSON request." }); return;
  }
  const days = req.query.days;
  const parsed = GetApiMonitoringQueryParams.safeParse({ ...req.query, ...(typeof days === "string" && /^(1|7|30|90|365|400)$/.test(days) ? { days: Number(days) } : {}) });
  if (!parsed.success) { res.status(400).json({ error: "Choose 1, 7, 30, 90, 365 or 400 days." }); return; }
  try {
    const result = await runManualCheck();
    res.json({ ...result, monitoring: GetApiMonitoringResponse.parse(await monitoringSummary(parsed.data.days ?? 30, new Date(), undefined, "manual")) });
  } catch {
    req.log.warn("Manual API check failed; verify monitoring storage and the configured production URL.");
    res.status(503).json({ error: "Could not run or save the check. Verify database access and the production target configuration, then try again." });
  }
});
export default router;
