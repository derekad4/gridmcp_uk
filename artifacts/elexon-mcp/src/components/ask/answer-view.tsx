import { useState } from "react";
import { Database, Download, ExternalLink, FileSpreadsheet, FileText, CornerDownRight, AlertTriangle, Loader2 } from "lucide-react";
import type { AnalysisAnswer } from "@workspace/api-client-react";
import { downloadExport, fmtStamp } from "@/lib/ask";
import { ChartPanel, DataTable, DiagramView } from "./visuals";
import { metricLabel } from "@workspace/elexon-labels";

type Fmt = "xlsx" | "docx" | "pdf";
const EXPORTS: { f: Fmt; label: string; icon: typeof FileText }[] = [
  { f: "xlsx", label: "Excel", icon: FileSpreadsheet },
  { f: "docx", label: "Word", icon: FileText },
  { f: "pdf", label: "PDF", icon: Download },
];

export function AnswerView({ answer, onFollowUp }: { answer: AnalysisAnswer; onFollowUp: () => void }) {
  const [busy, setBusy] = useState<Fmt | null>(null);
  const [exportErr, setExportErr] = useState<string | null>(null);
  const byId = Object.fromEntries(answer.datasets.map((d) => [d.id, d]));
  const paragraphs = answer.narrative.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  const doExport = async (f: Fmt) => {
    setBusy(f);
    setExportErr(null);
    try {
      await downloadExport(answer.id, f, answer.title);
    } catch (e) {
      setExportErr(e instanceof Error ? e.message : "Export failed.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <article data-testid={`answer-${answer.id}`} className="rise space-y-6">
      <header className="space-y-3 border-b pb-5">
        <section aria-label="Your original question" className="rounded-xl border border-primary/20 bg-primary/5 p-4">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-primary">Your question</h2>
          <p data-testid="text-original-question" className="whitespace-pre-wrap break-words text-base leading-relaxed text-foreground">{answer.question}</p>
        </section>
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-primary">Finding · {fmtStamp(answer.createdAt, answer.timezone)}</p>
        <h2 data-testid="text-answer-title" className="font-display text-2xl font-extrabold leading-tight sm:text-3xl">{answer.title}</h2>
        <p data-testid="text-export-scope" className="text-xs text-muted-foreground">
          Export this analysis only, including its charts and tables.
        </p>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {EXPORTS.map(({ f, label, icon: Icon }) => (
            <button key={f} data-testid={`button-export-${f}`} title={`Export only “${answer.title}” with its charts and tables`} onClick={() => doExport(f)} disabled={busy !== null}
              className="inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-xs font-medium transition-all hover:border-primary hover:text-primary active:scale-95 disabled:opacity-50">
              {busy === f ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}{label}
            </button>
          ))}
          <button data-testid="button-follow-up" onClick={onFollowUp}
            className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground transition-transform active:scale-95">
            <CornerDownRight className="h-3.5 w-3.5" /> Ask a follow-up
          </button>
        </div>
        {exportErr && <p role="alert" data-testid="text-export-error" className="text-sm text-destructive">{exportErr}</p>}
      </header>

      {answer.charts.length > 0 && (
        <div className={`grid gap-4 ${answer.charts.length > 1 ? "xl:grid-cols-2" : ""}`}>
          {answer.charts.map((c, i) => <ChartPanel key={i} chart={c} dataset={byId[c.datasetId]} index={i} />)}
        </div>
      )}

      {answer.metrics.length > 0 && (
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border lg:grid-cols-4">
          {answer.metrics.map((m, i) => (
            <div key={i} data-testid={`metric-${i}`} className="bg-card p-4" title={m.calculation}>
              <dt className="text-xs text-muted-foreground">{metricLabel(m.label)}</dt>
              <dd className="mt-1 font-display text-2xl font-extrabold tabular-nums">{m.value.toLocaleString("en-GB", { maximumFractionDigits: m.unit === "Hz" ? 3 : 2 })}<span className="ml-1 font-mono text-xs font-normal text-muted-foreground">{m.unit}</span></dd>
              <dd className="mt-1 break-words font-mono text-[10px] text-muted-foreground">{m.calculation}</dd>
            </div>
          ))}
        </dl>
      )}

      <div data-testid="text-narrative" className="max-w-3xl space-y-3 text-[15px] leading-relaxed">
        {paragraphs.map((p, i) => <p key={i} className="whitespace-pre-line">{p}</p>)}
      </div>

      {answer.diagram && answer.diagram.nodes.length > 0 && <DiagramView diagram={answer.diagram} />}

      {answer.limitations.length > 0 && (
        <section className="rounded-xl border border-chart-4/40 bg-chart-4/10 p-4">
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><AlertTriangle className="h-4 w-4" /> Limitations</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm">{answer.limitations.map((l, i) => <li key={i}>{l}</li>)}</ul>
        </section>
      )}

      <section className="space-y-3">
        <h3 className="flex items-center gap-2 font-display text-lg font-semibold"><Database className="h-4 w-4 text-primary" /> Evidence ({answer.datasets.length} {answer.datasets.length === 1 ? "query" : "queries"})</h3>
        {answer.datasets.map((d, i) => (
          <details key={d.id} data-testid={`dataset-${d.id}`} open={i === 0 && answer.datasets.length === 1} className="group rounded-xl border bg-card">
            <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 p-4">
              <span className="font-mono text-sm font-medium">{d.tool}</span>
              <span className="font-mono text-xs text-muted-foreground">{d.count} of {d.totalCount} rows{d.truncated ? " · truncated" : ""}</span>
              <span className="ml-auto text-xs text-primary group-open:hidden">Show rows and filters</span>
            </summary>
            <div className="space-y-3 border-t p-4">
              <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-[auto_1fr]">
                <dt className="text-muted-foreground">Coverage</dt><dd>{d.coverage}</dd>
                <dt className="text-muted-foreground">Fetched</dt><dd className="font-mono">{fmtStamp(d.fetchedAt, answer.timezone)}</dd>
                <dt className="text-muted-foreground">Filters</dt>
                <dd className="font-mono break-all">{Object.keys(d.arguments).length ? Object.entries(d.arguments).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join("  ·  ") : "none"}</dd>
                {d.metadata && Object.keys(d.metadata).length > 0 && <><dt className="text-muted-foreground">Upstream metadata</dt><dd className="break-all font-mono">{JSON.stringify(d.metadata)}</dd></>}
                {d.nextOffset != null && <><dt className="text-muted-foreground">Pagination</dt><dd>Next local offset: {d.nextOffset}. This page is not the full archive.</dd></>}
                {d.note && <><dt className="text-muted-foreground">Note</dt><dd>{d.note}</dd></>}
                <dt className="text-muted-foreground">Source</dt>
                <dd><a href={d.sourceUrl} target="_blank" rel="noreferrer" data-testid={`link-source-${d.id}`} className="inline-flex items-center gap-1 break-all font-mono text-primary hover:underline">{d.sourceUrl}<ExternalLink className="h-3 w-3 shrink-0" /></a></dd>
              </dl>
              {d.truncated && <p className="text-xs text-muted-foreground">Rows were capped at {d.count} of {d.totalCount} to keep the analysis bounded. Narrow the period for complete coverage.</p>}
              <DataTable dataset={d} />
            </div>
          </details>
        ))}
      </section>
    </article>
  );
}
