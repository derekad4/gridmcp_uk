// Explicit development-only verification. This never simulates an AI completion or sends paid
// model requests. It validates live MCP data -> safe model -> snapshots -> real file formats.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { pool } from "@workspace/db";
import { connectMcp } from "../src/lib/ask/engine";
import { normalizeResult, buildAnswer, type Dataset, type Plan } from "../src/lib/ask/validation";
import { generateExport } from "../src/lib/ask/exports";
import { sessionFor } from "../src/lib/ask/store";

if (process.env.NODE_ENV === "production") throw new Error("This verification script is development-only.");
const out = resolve(import.meta.dirname, "../../../generated-artifacts/ask-verification");
await mkdir(out, { recursive: true });
const connection = await connectMcp();
const id = randomUUID();
try {
  const catalog = (await connection.client.listTools()).tools;
  if (catalog.length !== 330) throw new Error("Unexpected MCP catalog coverage");
  const datasets: Dataset[] = [];
  const day = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  const queries = [
    { name: "elexon_get_system_frequency", arguments: { from: `${day}T00:00:00Z`, to: `${day}T00:02:00Z`, _limit: 20 } },
    { name: "get_generation_by_fuel", arguments: { from: `${day}T00:00:00Z`, to: `${day}T01:00:00Z`, limit: 100 } },
    { name: "get_system_prices", arguments: { settlement_date: day, limit: 100 } },
  ];
  for (const query of queries) {
    const raw = await connection.client.callTool(query);
    if (raw.isError) throw new Error(`Live MCP query failed: ${query.name}`);
    const dataset = normalizeResult(raw.structuredContent, query.arguments, `query_${datasets.length + 1}`, catalog.find((t) => t.name === query.name)?.description ?? "");
    if (!dataset.rows.length) throw new Error(`No live rows for ${query.name}`);
    datasets.push(dataset);
  }
  const plan: Plan = {
    title: "Live Elexon visual and export verification",
    narrative: "This verification report uses live Elexon observations retrieved through the official MCP SDK. No AI-generated answer was substituted. The views and page statistics are calculated directly from the returned records.",
    limitations: ["Verification report, not a completed natural-language AI journey. Managed OpenAI provisioning is required to verify that path."],
    diagram: true,
    views: [
      { datasetId: "query_1", title: "Measured system frequency", kind: "line", xKey: "measurementTime", yKey: "frequency", aggregation: "none" },
      { datasetId: "query_2", title: "Generation by fuel", kind: "area", xKey: "startTime", yKey: "quantity", groupKey: "psrType", aggregation: "mean" },
      { datasetId: "query_2", title: "Mean generation mix over the queried hour", kind: "composition", xKey: "psrType", yKey: "quantity", aggregation: "mean" },
      { datasetId: "query_3", title: "Settlement system buy price", kind: "bar", xKey: "settlementPeriod", yKey: "systemBuyPrice", aggregation: "none" },
    ],
  };
  // Do not assume fuel field names if the upstream schema changes.
  if (!datasets[1].columns.some((c) => c.key === "psrType")) {
    const key = datasets[1].columns.find((c) => /fuelType|productionType/i.test(c.key))?.key;
    if (!key) throw new Error("Generation fuel category missing");
    plan.views[1].groupKey = key; plan.views[2].xKey = key;
  }
  const answer = buildAnswer(id, "Verify line, area, bar, composition, relationship diagram and dashboard against live MCP data", plan, datasets, 0);
  if (answer.charts.length !== 4) throw new Error(`Some live visual requests could not be validated: ${answer.limitations.join("; ")}`);
  for (const format of ["xlsx", "docx", "pdf"] as const) await writeFile(resolve(out, `live-report.${format}`), await generateExport(answer, format));
  await writeFile(resolve(out, "answer.json"), JSON.stringify(answer, null, 2));
  if (process.argv.includes("--seed-browser-verification")) {
    const token = randomBytes(32).toString("hex");
    const { session } = sessionFor({ headers: { cookie: `ask_session=${token}` }, ip: "verification" } as Request, { cookie: () => {} } as unknown as Response);
    await pool.query("INSERT INTO ask_runs(id,session,client_hash,question,status,result,expires_at) VALUES($1,$2,'verification',$3,'complete',$4,now()+interval '1 hour')", [id, session, answer.question, JSON.stringify(answer)]);
    await writeFile(resolve(out, "browser.json"), JSON.stringify({ id, cookie: { name: "ask_session", value: token, path: "/api/ask", httpOnly: true, sameSite: "Strict" } }));
  }
  process.stdout.write(JSON.stringify({ catalogCount: catalog.length, queries: datasets.map((d) => ({ tool: d.tool, rows: d.count, sourceUrl: d.sourceUrl })), charts: answer.charts.map((c) => c.kind), exports: ["xlsx", "docx", "pdf"], output: "generated-artifacts/ask-verification", aiVerified: false }) + "\n");
} finally { await connection.close(); await pool.end(); }
