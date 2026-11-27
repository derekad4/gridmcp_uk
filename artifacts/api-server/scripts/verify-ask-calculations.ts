// Explicit development verification. Uses real MCP data and the managed model,
// but does not save an analysis into any browser's private history.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { runAnalysis } from "../src/lib/ask/engine";

if (process.env.NODE_ENV === "production") throw new Error("Development-only verification.");
const question = process.argv.slice(2).join(" ") || "what category is the biggest producer of energy across the uk in the past 6 months";
try {
  const answer = await runAnalysis({
    id: randomUUID(), question, signal: AbortSignal.timeout(600000),
    progress: (message) => { if (!message.startsWith("Retrieved page")) process.stdout.write(`${message}\n`); },
  });
  const rankings = answer.datasets.filter((d) => d.metadata?.automaticFuelRanking && !d.id.includes("_view_"));
  if (!rankings.length || !answer.charts.some((c) => c.unit === "MWh") || !answer.metrics.some((m) => m.unit === "MWh")) throw new Error("The energy ranking was not rendered as calculated metrics and a chart.");
  if (/cannot be stated.*(?:calculation|summary query)/i.test(answer.narrative)) throw new Error("The answer still refused available calculations.");
  const result = {
    question, narrative: answer.narrative, charts: answer.charts, metrics: answer.metrics,
    limitations: answer.limitations, tokens: answer.tokens,
    sources: answer.datasets.filter((d) => !d.metadata?.calculation && !d.id.includes("_view_")).map((d) => ({ id: d.id, tool: d.tool, arguments: d.arguments, rows: d.rows.length, truncated: d.truncated, coverage: d.coverage })),
    rankings: rankings.map((d) => ({ id: d.id, rows: d.rows, metadata: d.metadata })),
  };
  const dir = resolve(import.meta.dirname, "../../../generated-artifacts/ask-calculations");
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, "live-result.json"), JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} finally { await pool.end(); }
