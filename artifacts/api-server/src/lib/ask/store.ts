import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { pool } from "@workspace/db";
import { ToolError } from "../elexon";
import type { Answer } from "./validation";
import { fulfilVisualRequests } from "./visual-requests";
import type { AnalysisSummary } from "@workspace/api-zod";

export const LIMITS = {
  question: 32000, executionMs: 600000,
  inputBytes: 512000,
};
export const limitsText = "No app-imposed daily/lifetime AI allowance, per-question token budget, or tool/model-call quota. Long conversations are compacted automatically. Technical safeguards remain: 32,000 characters/question, a 10-minute execution timeout, provider context/output limits, and Elexon response limits. AI usage is billed to the app owner's Replit credits.";
export const billingNotice = "AI usage is billed to the app owner's Replit credits. No API key is needed. No automatic AI refresh. Completed results are private to this browser session and retained for 7 days. Anyone using this browser profile can see them.";

function digest(value: string) {
  if (!process.env.SESSION_SECRET) throw new ToolError("Ask Grid MCP session security is not configured.", 503);
  return createHmac("sha256", process.env.SESSION_SECRET).update(value).digest("hex");
}
export function sessionFor(req: Request, res: Response) {
  const raw = req.headers.cookie?.split(";").map((v) => v.trim()).find((v) => v.startsWith("ask_session="))?.slice(12);
  const header = req.headers["x-ask-session"];
  if (header !== undefined && (typeof header !== "string" || !/^[a-f0-9]{64}$/.test(header))) throw new ToolError("Invalid browser session. Reload Ask Grid MCP.", 400);
  const token = typeof header === "string" ? header : raw && /^[a-f0-9]{64}$/.test(raw) ? raw : randomBytes(32).toString("hex");
  if (token !== raw) res.cookie("ask_session", token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/api/ask", maxAge: 30 * 86400000 });
  return {
    session: digest(`session:${token}`), clientHash: digest(`ip:${req.ip ?? "unknown"}`),
    legacySession: raw && /^[a-f0-9]{64}$/.test(raw) && raw !== token ? digest(`session:${raw}`) : undefined,
  };
}
export async function browserSessionFor(req: Request, res: Response) {
  const identity = sessionFor(req, res);
  // A valid existing cookie proves ownership: preserve its saved analyses when
  // adopting the explicit browser credential used in cookie-blocking iframes.
  if (identity.legacySession) await pool.query("UPDATE ask_runs SET session=$1 WHERE session=$2", [identity.session, identity.legacySession]);
  return identity;
}
export async function history(session: string): Promise<AnalysisSummary[]> {
  // Project inside PostgreSQL: do not transfer/deserialise every historical raw
  // dataset merely to display twenty titles in the browser.
  const result = await pool.query(`SELECT id::text AS id, result->>'title' AS title,
    result->>'createdAt' AS "createdAt", result->>'timezone' AS timezone
    FROM ask_runs WHERE session=$1 AND status='complete' AND expires_at>now()
    ORDER BY created_at DESC LIMIT 20`, [session]);
  return result.rows;
}
export async function ownedAnswer(session: string, id: string): Promise<Answer | undefined> {
  const result = await pool.query("SELECT result FROM ask_runs WHERE id=$1 AND session=$2 AND status='complete' AND expires_at>now()", [id, session]);
  const saved = result.rows[0]?.result as Answer | undefined;
  return saved ? fulfilVisualRequests(saved) : undefined;
}
export async function deleteOwnedAnswer(session: string, id: string): Promise<boolean> {
  // Delete exactly one completed, owned result; never touch another browser,
  // separately saved follow-ups, or in-flight analysis leases.
  const result = await pool.query("DELETE FROM ask_runs WHERE id=$1 AND session=$2 AND status='complete' AND expires_at>now() RETURNING id", [id, session]);
  return result.rowCount === 1;
}
export async function reserve(session: string, clientHash: string, question: string) {
  const client = await pool.connect();
  const id = randomUUID();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE ask_runs SET status='expired' WHERE status='running' AND expires_at<=now()");
    // Track ownership and cleanup only; historical usage counters no longer gate access.
    await client.query("INSERT INTO ask_runs(id,session,client_hash,question,status,expires_at) VALUES($1,$2,$3,$4,'running',now()+($5 * interval '1 millisecond'))", [id, session, clientHash, question, LIMITS.executionMs + 30000]);
    await client.query("DELETE FROM ask_runs WHERE expires_at < now()");
    await client.query("COMMIT");
    return id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
export async function finish(id: string, result?: Answer) {
  await pool.query("UPDATE ask_runs SET status=$2,result=$3,expires_at=now()+interval '7 days' WHERE id=$1 AND status='running'", [id, result ? "complete" : "failed", result ? JSON.stringify(result) : null]);
}
