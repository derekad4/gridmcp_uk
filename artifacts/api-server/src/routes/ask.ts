import { Router, type IRouter, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { AskQuestionBody, ExportAskAnswerParams, GetAskHistoryResponse } from "@workspace/api-zod";
import { z } from "zod";
import { ToolError } from "../lib/elexon";
import { aiAvailable, runAnalysis } from "../lib/ask/engine";
import { billingNotice, limitsText, browserSessionFor, history, ownedAnswer, deleteOwnedAnswer, reserve, finish, LIMITS } from "../lib/ask/store";
import { exportTypes, generateExport } from "../lib/ask/exports";
import { answerSchema } from "../lib/ask/validation";
import { gzip } from "node:zlib";
import { promisify } from "node:util";

const compress = promisify(gzip);

const router: IRouter = Router();
const exportsLimiter = rateLimit({ windowMs: 60000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Too many exports. Please retry in one minute." } });
const reads = rateLimit({ windowMs: 60000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Too many history requests. Please retry in one minute." } });
const deletes = rateLimit({ windowMs: 60000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Too many deletion requests. Please retry in one minute." } });
let activeExports = 0;
function safeError(req: Request, res: Response, error: unknown) {
  req.log.warn({ category: error instanceof ToolError ? "bounded_request" : "service_unavailable" }, "Ask Grid MCP request failed");
  res.status(error instanceof ToolError ? error.status : 503).json({ error: error instanceof ToolError ? error.message : "Ask Grid MCP is temporarily unavailable. Please retry shortly; existing MCP tools are unaffected." });
}
router.use("/ask", (req, res, next) => {
  res.set({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
  res.vary("Cookie");
  res.vary("X-Ask-Session");
  const origin = req.get("origin");
  if (req.get("sec-fetch-site") === "cross-site" || (origin && (() => { try { return new URL(origin).host !== req.get("host"); } catch { return true; } })())) {
    res.status(403).json({ error: "Ask Grid MCP only accepts same-origin browser requests." });
    return;
  }
  // Every mutation requires explicit same-origin JSON, including deletions.
  if (["POST", "DELETE"].includes(req.method) && (!origin || !req.is("application/json"))) {
    res.status(403).json({ error: "Send changes as same-origin JSON browser requests." });
    return;
  }
  next();
});
router.get("/ask/history", reads, async (req, res): Promise<void> => {
  try {
    const { session } = await browserSessionFor(req, res);
    res.json(GetAskHistoryResponse.parse({ answers: await history(session), notice: billingNotice, limits: limitsText, available: aiAvailable() }));
  } catch (error) { safeError(req, res, error); }
});
router.get("/ask/answers/:id", reads, async (req, res): Promise<void> => {
  try {
    const parsed = z.string().uuid().safeParse(req.params.id);
    if (!parsed.success) throw new ToolError("Invalid analysis identifier.", 400);
    const { session } = await browserSessionFor(req, res);
    const answer = await ownedAnswer(session, parsed.data);
    if (!answer) throw new ToolError("This analysis is unavailable in your browser session or has expired.", 404);
    res.vary("Accept-Encoding");
    // Large historical answers can exceed intermediary response limits even
    // though the database query succeeds. Compress without dropping any rows.
    if (req.acceptsEncodings("gzip")) {
      const bytes = await compress(JSON.stringify(answer), { level: 4 });
      res.set("Content-Encoding", "gzip").type("json").send(bytes);
    } else res.json(answer);
  } catch (error) { safeError(req, res, error); }
});
router.delete("/ask/answers/:id", deletes, async (req, res): Promise<void> => {
  try {
    const parsed = z.string().uuid().safeParse(req.params.id);
    if (!parsed.success) throw new ToolError("Invalid analysis identifier.", 400);
    const { session } = await browserSessionFor(req, res);
    if (!await deleteOwnedAnswer(session, parsed.data)) throw new ToolError("This analysis is unavailable in your browser session or has already been deleted.", 404);
    res.status(204).end();
  } catch (error) { safeError(req, res, error); }
});
router.post("/ask/questions", async (req, res): Promise<void> => {
  const parsed = AskQuestionBody.strict().safeParse(req.body);
  if (!parsed.success || parsed.data.question.trim().length < 3) {
    res.status(400).json({ error: "Enter a question between 3 and 32,000 characters, with an optional valid follow-up answer ID." });
    return;
  }
  let id: string | undefined;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const cancel = () => { if (!res.writableEnded) controller.abort(); };
  try {
    if (!aiAvailable()) throw new ToolError("Managed OpenAI is not connected. The app owner must enable Replit AI Integrations before questions can run. Existing results and exports remain available.", 503);
    const { session, clientHash } = await browserSessionFor(req, res);
    const previous = parsed.data.parentId ? await ownedAnswer(session, parsed.data.parentId) : undefined;
    if (parsed.data.parentId && !previous) throw new ToolError("This follow-up result is unavailable in your browser session or has expired. Start a new question.", 404);
    id = await reserve(session, clientHash, parsed.data.question.trim());
    timer = setTimeout(() => controller.abort(new Error("Analysis timed out")), LIMITS.executionMs);
    res.on("close", cancel);
    res.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "X-Accel-Buffering": "no", "Connection": "keep-alive" });
    res.flushHeaders();
    const send = (event: unknown) => { if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`); };
    heartbeat = setInterval(() => { if (!res.destroyed) res.write(": keepalive\n\n"); }, 10000);
    const answer = await runAnalysis({ id, question: parsed.data.question.trim(), previous: previous ? [previous] : [], signal: controller.signal, progress: (message) => send({ type: "progress", message }) });
    controller.signal.throwIfAborted();
    await finish(id, answer);
    send({ type: "complete", message: "Analysis saved. Your Excel, Word and PDF reports are ready.", answer });
  } catch (error) {
    if (id) { try { await finish(id); } catch { req.log.error("Could not release Ask Grid MCP lease; it will expire automatically"); } }
    if (res.headersSent) {
      const message = controller.signal.aborted ? "The analysis was cancelled or reached the ten-minute technical timeout. No incomplete answer was saved. In-flight AI usage may still be charged." : error instanceof ToolError ? error.message : "The AI or data service could not complete the question. Please retry. No unvalidated output was saved.";
      if (!res.destroyed) res.write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
      req.log.warn({ category: controller.signal.aborted ? "cancelled" : "analysis_failed" }, "Ask Grid MCP analysis stopped");
    } else safeError(req, res, error);
  } finally {
    if (timer) clearTimeout(timer);
    if (heartbeat) clearInterval(heartbeat);
    res.off("close", cancel);
    if (!res.writableEnded) res.end();
  }
});
router.get("/ask/answers/:id/export/:format", exportsLimiter, async (req, res): Promise<void> => {
  const parsed = ExportAskAnswerParams.extend({ id: z.string().uuid() }).safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: "Choose a saved answer and an xlsx, docx or pdf export." }); return; }
  if (activeExports >= 2) { res.status(429).json({ error: "Report generation is busy. Please retry shortly." }); return; }
  activeExports++;
  try {
    const { session } = await browserSessionFor(req, res);
    const saved = await ownedAnswer(session, parsed.data.id);
    if (!saved) throw new ToolError("This analysis is unavailable in your browser session or has expired.", 404);
    const answer = answerSchema.parse(saved);
    const bytes = await generateExport(answer, parsed.data.format);
    const filename = `elexon-analysis-${answer.id.slice(0, 8)}.${parsed.data.format}`;
    res.set({ "Content-Type": exportTypes[parsed.data.format], "Content-Disposition": `attachment; filename="${filename}"`, "Content-Length": String(bytes.length) }).send(bytes);
  } catch (error) { safeError(req, res, error); }
  finally { activeExports--; }
});
export default router;
