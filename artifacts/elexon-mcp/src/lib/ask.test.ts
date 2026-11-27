import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createServer } from "vite";
import { streamQuestion } from "./ask";

test("complete and error events release the busy state without waiting for the stream to close", async () => {
  const original = globalThis.fetch;
  try {
    for (const type of ["complete", "error"] as const) {
      let cancelled = false;
      globalThis.fetch = async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, message: "Finished", ...(type === "complete" ? { answer: { id: "fixture" } } : {}) })}\n\n`));
          // Deliberately never close: a proxy may keep this body open.
        },
        cancel() {
          cancelled = true;
          // Transport cleanup can also lag behind the terminal event.
          return new Promise<void>(() => {});
        },
      }), { headers: { "Content-Type": "text/event-stream" } });
      const events: string[] = [];
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          streamQuestion({ question: "A test question" }, AbortSignal.timeout(1000), (event) => events.push(event.type)),
          new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Terminal event did not release the stream")), 1000); }),
        ]);
      } finally { clearTimeout(timeout); }
      assert.deepEqual(events, [type]);
      assert.equal(cancelled, true);
    }
  } finally { globalThis.fetch = original; }
});

test("a truncated stream still reports an error rather than silently claiming completion", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("data: {\"type\":\"progress\",\"message\":\"Working\"}\n\n");
    await assert.rejects(streamQuestion({ question: "A test question" }, AbortSignal.timeout(1000), () => {}), /closed before an answer/);
  } finally { globalThis.fetch = original; }
});

test("Ask starts as a new editable question with saved history, and evidence tables render only one page", async () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const vite = await createServer({
    configFile: false, root, appType: "custom",
    server: { middlewareMode: true, hmr: false },
    resolve: { alias: { "@": `${root}/src` }, dedupe: ["react", "react-dom", "@tanstack/react-query"] },
    esbuild: { jsx: "automatic" },
  });
  const qc = new QueryClient();
  try {
    const { getGetAskHistoryQueryKey } = await import("@workspace/api-client-react");
    qc.setQueryData(getGetAskHistoryQueryKey(), {
      answers: [{ id: "saved-analysis", title: "Saved fuel analysis", createdAt: "2026-11-19T12:00:00Z", timezone: "UTC" }],
      available: false, notice: "Test notice", limits: "",
    });
    const { default: Ask } = await vite.ssrLoadModule("/src/pages/ask.tsx");
    const page = renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(Ask)));
    assert.match(page, /New question/);
    assert.match(page, /Saved fuel analysis/);
    assert.match(page, /data-testid="button-delete-saved-analysis"/);
    assert.match(page, /aria-label="Delete Saved fuel analysis"/);
    assert.doesNotMatch(page, /data-testid="answer-saved-analysis"/);
    assert.doesNotMatch(page.match(/<textarea[^>]*>/)?.[0] ?? "", /\sdisabled(?:=|\s|>)/);
    assert.match(page, /Start from a representative question/);
    const { DataTable, ChartPanel } = await vite.ssrLoadModule("/src/components/ask/visuals.tsx");
    const categoryFixture = {
      id: "chart-fixture", tool: "fixture", sourceUrl: "", fetchedAt: "2026-11-19T12:00:00Z",
      arguments: {}, metadata: {}, count: 20, totalCount: 20, truncated: false, nextOffset: null,
      columns: [{ key: "fuelType", unit: "category" }, { key: "energyMWh", unit: "MWh" }],
      rows: Array.from({ length: 20 }, (_, i) => ({ fuelType: i === 0 ? "CCGT" : `Category ${i}`, energyMWh: 20 - i })),
      coverage: "Synthetic fixture only", note: "Fixture",
    };
    for (const kind of ["pie", "donut", "horizontalBar"] as const) {
      const markup = renderToStaticMarkup(createElement(ChartPanel, { index: 0, dataset: categoryFixture,
        chart: { title: "Requested chart", kind, datasetId: categoryFixture.id, xKey: "fuelType", yKeys: ["energyMWh"], unit: "MWh" } }));
      const selected = markup.match(new RegExp(`<button[^>]*data-testid="button-chart-0-${kind === "horizontalBar" ? "hbar" : kind}"[^>]*>`))?.[0];
      assert.match(selected ?? "", /aria-pressed="true"/, `${kind} must remain the requested type with twenty categories`);
      assert.match(markup, /Gas \(combined cycle\)/);
      assert.match(markup, /9\.52%/);
      assert.doesNotMatch(markup, /categories at one moment/);
    }
    const table = renderToStaticMarkup(createElement(DataTable, { dataset: {
      id: "large", tool: "fixture", count: 30000, totalCount: 30000,
      columns: [{ key: "generation", unit: "MW" }],
      rows: Array.from({ length: 30000 }, (_, generation) => ({ generation })),
    } }));
    assert.equal((table.match(/<tbody>[\s\S]*?<\/tbody>/)?.[0].match(/<tr\b/g) ?? []).length, 50);
    assert.match(table, /Page 1 of 600/);
    assert.match(table, /Next/);
    const { AnswerView } = await vite.ssrLoadModule("/src/components/ask/answer-view.tsx");
    const saved = renderToStaticMarkup(createElement(AnswerView, {
      answer: {
        id: "saved-analysis", title: "Saved fuel analysis", question: "Plot generation by fuel",
        createdAt: "2026-11-19T12:00:00Z", timezone: "UTC", narrative: "Saved findings.",
        datasets: [], charts: [], metrics: [], limitations: [], tokens: 0,
        diagram: { title: "", description: "", nodes: [], edges: [] },
      },
      onFollowUp: () => {},
    }));
    for (const id of ["button-follow-up", "button-export-xlsx", "button-export-docx", "button-export-pdf"]) {
      const button = saved.match(new RegExp(`<button[^>]*data-testid="${id}"[^>]*>`))?.[0];
      assert.ok(button, `${id} should be available on a saved analysis`);
      assert.doesNotMatch(button, /\sdisabled(?:=|\s|>)/);
    }
    const { getGetApiMonitoringQueryKey } = await import("@workspace/api-client-react");
    const { default: Health } = await vite.ssrLoadModule("/src/pages/health.tsx");
    const { buildRows } = await vite.ssrLoadModule("/src/components/health-charts.tsx");
    const target = {
      id: "elexon", name: "Elexon Insights API", url: "https://data.elexon.co.uk",
      status: "unknown", lastCheckedAt: null, lastResponseMs: null, uptimePercent: null,
      coveragePercent: 0, checks: 0, successfulChecks: 0, failedChecks: 0, degradedChecks: 0,
      expectedChecks: 288, unknownChecks: 288, meanResponseMs: null, p95ResponseMs: null,
    };
    const monitoring = {
      generatedAt: "2026-11-19T12:00:00Z", from: "2026-10-20T12:00:00Z", to: "2026-11-19T12:00:00Z",
      days: 30, intervalSeconds: 300, retentionDays: 400, bucketSeconds: 86400,
      firstCheckAt: null, lastRunnerAt: null, runnerState: "waiting", targets: [target],
      series: [], incidents: [], recentChecks: [], incidentsTruncated: false,
      notifications: { mode: "disabled", watchdogLastAt: null, pending: 0, failed: 0 },
      setup: { schedule: "*/5 * * * *", command: "node monitor-worker.mjs", targetUrl: null, instructions: "Publish a separate checker." },
    };
    qc.setQueryData(getGetApiMonitoringQueryKey({ days: 30 }), monitoring);
    const waiting = renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(Health)));
    assert.match(waiting, /Ready for your first manual check/);
    assert.match(waiting, /No manual checks in this range/);
    assert.match(waiting, /data-testid="button-run-check"/);
    assert.match(waiting, /not continuous uptime/);
    assert.doesNotMatch(waiting, /Checker setup|Check coverage|Email notifications|expected checks/);
    assert.match(waiting, /400d/);
    assert.doesNotMatch(waiting, /100%/);
    const series = [
      { target: "elexon", at: "2026-11-19T10:00:00Z", checks: 1, uptimePercent: 100, coveragePercent: 100, meanResponseMs: 50, p95ResponseMs: 50 },
      { target: "elexon", at: "2026-11-19T10:15:00Z", checks: 1, uptimePercent: 0, coveragePercent: 100, meanResponseMs: null, p95ResponseMs: null },
    ];
    const chartRows = buildRows(series, [target], 300, "uptimePercent");
    assert.equal(chartRows.length, 3);
    assert.equal(chartRows[1].elexon, null);
    qc.setQueryData(getGetApiMonitoringQueryKey({ days: 30 }), { ...monitoring, series });
    const withCharts = renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(Health)));
    for (const chart of ["success", "mean", "p95"]) assert.match(withCharts, new RegExp(`data-testid="chart-${chart}"`));
  } finally { qc.clear(); await vite.close(); }
});
