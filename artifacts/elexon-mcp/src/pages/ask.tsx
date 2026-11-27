import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUp, CircleSlash, CornerDownRight, LineChart, Network, LayoutDashboard, RotateCcw, X, History, Receipt, Trash2 } from "lucide-react";
import { useGetAskHistory, useGetAskAnswer, getGetAskHistoryQueryKey, getGetAskAnswerQueryKey, deleteAskAnswer, type AnalysisAnswer, type AnalysisSummary, type AskHistory } from "@workspace/api-client-react";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { AnswerView } from "@/components/ask/answer-view";
import { MAX_QUESTION, streamQuestion, fmtStamp, askSessionHeaders } from "@/lib/ask";

const EXAMPLES = [
  { kind: "Graph", icon: LineChart, q: "Chart GB system sell price for every settlement period on 2025-01-15 and identify the most expensive period." },
  { kind: "Graph", icon: LineChart, q: "Plot GB demand outturn against the day-ahead wind forecast for 2025-02-03 and quantify the largest gap." },
  { kind: "Composition", icon: LineChart, q: "Show the generation mix by fuel type between 2025-01-15T06:00Z and 2025-01-15T18:00Z as a composition." },
  { kind: "Diagram", icon: Network, q: "Draw how a BM unit's physical notification, bid-offer acceptances and imbalance settlement relate, then pull one day of system prices as evidence." },
  { kind: "Dashboard", icon: LayoutDashboard, q: "Build a dashboard for 2025-01-08: system prices, demand outturn, generation by fuel and key metrics for peak and average price." },
  { kind: "Dashboard", icon: LayoutDashboard, q: "Compare the last Sunday of March 2025 (46 periods) with the Sunday before: prices, demand and wind output side by side." },
];

const TITLE = "Ask Grid MCP — evidence-first GB electricity research desk";
const DESC = "Ask questions about the GB electricity market and get charts, tables and diagrams traceable to real Elexon BMRS queries, with exports to Excel, Word and PDF.";

function useMeta() {
  useEffect(() => {
    const prevTitle = document.title;
    let meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const created = !meta;
    if (!meta) { meta = document.createElement("meta"); meta.name = "description"; document.head.appendChild(meta); }
    const prevDesc = meta.content;
    document.title = TITLE;
    meta.content = DESC;
    return () => { document.title = prevTitle; if (created) meta?.remove(); else if (meta) meta.content = prevDesc; };
  }, []);
}

type Run = { question: string; parentId?: string; steps: string[]; error?: string; cancelled?: boolean };

export default function Ask() {
  useMeta();
  const qc = useQueryClient();
  const history = useGetAskHistory({ query: { queryKey: getGetAskHistoryQueryKey(), retry: 1, refetchOnWindowFocus: false }, request: { headers: askSessionHeaders() } });
  const answers = history.data?.answers ?? [];
  const available = history.data?.available ?? true;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [completedAnswer, setCompletedAnswer] = useState<AnalysisAnswer | null>(null);
  const [text, setText] = useState("");
  const [followUp, setFollowUp] = useState<AnalysisAnswer | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [running, setRunning] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AnalysisSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [deleteNotice, setDeleteNotice] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const detail = useGetAskAnswer(selectedId ?? "", {
    query: { enabled: Boolean(selectedId && !run && completedAnswer?.id !== selectedId), retry: 1, refetchOnWindowFocus: false, staleTime: 60000 },
    request: { headers: askSessionHeaders() },
  });

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
    return () => abortRef.current?.abort();
  }, []);
  const selected = run ? null : completedAnswer?.id === selectedId ? completedAnswer
    : selectedId ? detail.data ?? null : null;
  useEffect(() => {
    if (selected?.id) resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [selected?.id]);

  const submit = async (question: string, parentId?: string) => {
    const q = question.trim();
    if (q.length < 3 || q.length > MAX_QUESTION || running || abortRef.current) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setRunning(true);
    setRun({ question: q, parentId, steps: ["Sending question to the research desk"] });
    try {
      await streamQuestion({ question: q, ...(parentId ? { parentId } : {}) }, ctrl.signal, (ev) => {
        if (ev.type === "progress") setRun((r) => (r ? { ...r, steps: [...r.steps, ev.message] } : r));
        else if (ev.type === "error") setRun((r) => (r ? { ...r, error: ev.message || "The analysis failed." } : r));
        else if (ev.type === "complete" && ev.answer) {
          const a = ev.answer;
          // Render the streamed result immediately, even if the initial history
          // request failed or a history refetch is still in flight.
          setCompletedAnswer(a);
          qc.setQueryData<AskHistory>(getGetAskHistoryQueryKey(), (old) => (
            { answers: [{ id: a.id, title: a.title, createdAt: a.createdAt, timezone: a.timezone }, ...(old?.answers ?? []).filter((x) => x.id !== a.id)].slice(0, 20),
              available: old?.available ?? true, notice: old?.notice ?? "", limits: old?.limits ?? "" }));
          setSelectedId(a.id);
          setRun(null);
          setText("");
          setFollowUp(null);
          void qc.invalidateQueries({ queryKey: getGetAskHistoryQueryKey() });
        }
      });
    } catch (e) {
      if (ctrl.signal.aborted) setRun((r) => (r ? { ...r, cancelled: true } : r));
      else setRun((r) => (r ? { ...r, error: e instanceof Error ? e.message : "Network error. Check your connection and retry." } : r));
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const startFollowUp = (a: AnalysisAnswer) => {
    setFollowUp(a);
    setTimeout(() => { inputRef.current?.focus(); inputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }); }, 0);
  };
  const removeAnalysis = async () => {
    if (!deleteTarget || deleting || running) return;
    const id = deleteTarget.id;
    setDeleting(true); setDeleteError("");
    try {
      try {
        await deleteAskAnswer(id, { headers: { ...askSessionHeaders(), "Content-Type": "application/json" }, body: "{}" });
      } catch (error) {
        // A second tab may already have deleted it. Clear stale local state too.
        if ((error as { status?: number }).status !== 404) throw error;
      }
      if (selectedId === id) setSelectedId(null);
      setCompletedAnswer(a => a?.id === id ? null : a);
      setFollowUp(a => a?.id === id ? null : a);
      await qc.cancelQueries({ queryKey: getGetAskAnswerQueryKey(id) });
      qc.removeQueries({ queryKey: getGetAskAnswerQueryKey(id) });
      await qc.cancelQueries({ queryKey: getGetAskHistoryQueryKey() });
      qc.setQueryData<AskHistory>(getGetAskHistoryQueryKey(), old => old ? { ...old, answers: old.answers.filter(a => a.id !== id) } : old);
      setDeleteTarget(null); setDeleteNotice("Analysis deleted.");
      void qc.invalidateQueries({ queryKey: getGetAskHistoryQueryKey() });
      requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    } catch (error) {
      setDeleteError((error as { data?: { error?: string } }).data?.error ?? "Could not confirm deletion. Please retry; only this analysis will be affected.");
    } finally { setDeleting(false); }
  };

  const len = text.length;
  const canSend = !running && available && text.trim().length >= 3 && len <= MAX_QUESTION;

  return (
    <div className="mx-auto max-w-6xl px-5 py-10 sm:py-12">
      <div className="mb-8 max-w-3xl">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">Ask Grid MCP</p>
        <h1 className="mt-2 font-display text-4xl font-extrabold leading-[1.05] sm:text-5xl">An evidence desk for the GB market.</h1>
        <p className="mt-3 text-lg text-muted-foreground">Ask a question. Every number in the answer comes from a real Elexon BMRS query you can inspect, filter by filter, row by row.</p>
      </div>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="min-w-0 space-y-8">
          <form data-testid="form-ask" onSubmit={(e) => { e.preventDefault(); void submit(text, followUp?.id); }}
            className="rounded-xl border bg-card shadow-[0_1px_0_hsl(var(--border))] focus-within:border-primary transition-colors">
            {followUp && (
              <div className="flex items-center gap-2 border-b bg-muted/50 px-4 py-2 text-xs">
                <CornerDownRight className="h-3.5 w-3.5 text-primary" />
                <span className="truncate">Following up on <strong>{followUp.title}</strong></span>
                <button type="button" data-testid="button-clear-follow-up" onClick={() => setFollowUp(null)} aria-label="Ask a new question instead" className="ml-auto rounded p-0.5 hover:bg-muted"><X className="h-3.5 w-3.5" /></button>
              </div>
            )}
            <label htmlFor="ask-input" className="block px-4 pt-3 text-sm font-semibold">{followUp ? "Follow-up question" : "New question"}</label>
            <textarea id="ask-input" ref={inputRef} data-testid="input-question" value={text} maxLength={MAX_QUESTION} rows={3}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (canSend) void submit(text, followUp?.id); } }}
              placeholder={followUp ? "What would you like to know next about this finding?" : "e.g. Which settlement period had the highest system price on 2025-01-15, and what was demand then?"}
              className="block w-full resize-y bg-transparent px-4 py-3 text-[15px] outline-none placeholder:text-muted-foreground/70 disabled:opacity-60" />
            <div className="flex items-center gap-3 border-t px-4 py-2">
              <span data-testid="text-char-count" className={`font-mono text-[11px] ${len > MAX_QUESTION * 0.9 ? "text-destructive" : "text-muted-foreground"}`}>{len}/{MAX_QUESTION}</span>
              <span className="hidden font-mono text-[11px] text-muted-foreground sm:inline">Ctrl+Enter to send</span>
              {running ? (
                <button type="button" data-testid="button-cancel" onClick={() => abortRef.current?.abort()}
                  className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-destructive/50 px-3 py-1.5 text-sm font-medium text-destructive transition-transform active:scale-95">
                  <CircleSlash className="h-4 w-4" /> Cancel
                </button>
              ) : (
                <button type="submit" data-testid="button-submit" disabled={!canSend}
                  className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-foreground transition-all active:scale-95 disabled:opacity-40">
                  {followUp ? "Ask follow-up" : "Ask"} <ArrowUp className="h-4 w-4" />
                </button>
              )}
            </div>
          </form>

          {run && (
            <section data-testid="status-run" aria-live="polite" className="rise rounded-xl border bg-card p-5">
              <p className="mb-3 text-sm font-medium">{run.question}</p>
              <ol className="space-y-1.5 font-mono text-xs">
                {run.steps.map((s, i) => {
                  const last = i === run.steps.length - 1 && running;
                  return (
                    <li key={i} className={`flex items-start gap-2 ${last ? "text-foreground" : "text-muted-foreground"}`}>
                      <span className="relative mt-1 flex h-2 w-2 shrink-0">
                        {last && <span className="pulse-ring absolute inset-0 rounded-full bg-primary" />}
                        <span className={`relative h-2 w-2 rounded-full ${last ? "bg-primary" : "bg-border"}`} />
                      </span>
                      {s}
                    </li>
                  );
                })}
              </ol>
              {running && <div className="mt-4 space-y-2"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-40 w-full" /></div>}
              {(run.error || run.cancelled) && (
                <div role="alert" className={`mt-4 flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 text-sm ${run.error ? "border-destructive/40 bg-destructive/5 text-destructive" : "bg-muted/60"}`}>
                  <span data-testid="text-run-error">{run.error ?? "Cancelled. The server stopped the analysis; nothing was saved."}</span>
                  <button data-testid="button-retry" onClick={() => void submit(run.question, run.parentId)}
                    className="ml-auto inline-flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1 text-xs font-medium text-foreground hover:border-primary">
                    <RotateCcw className="h-3.5 w-3.5" /> Retry
                  </button>
                  <button data-testid="button-dismiss" onClick={() => setRun(null)} className="text-xs text-muted-foreground hover:text-foreground">Dismiss</button>
                </div>
              )}
            </section>
          )}

          {selected && !run ? (
            <div ref={resultRef} className="scroll-mt-20 space-y-4">
              <p role="status" data-testid="status-complete" className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm font-medium text-primary">
                Analysis complete — {selected.charts.length} {selected.charts.length === 1 ? "chart" : "charts"}. Results and Excel, Word and PDF exports are below.
              </p>
              <AnswerView key={selected.id} answer={selected} onFollowUp={() => startFollowUp(selected)} />
            </div>
          ) : selectedId && !run && detail.isPending ? (
            <div role="status" className="space-y-3"><p className="text-sm text-muted-foreground">Loading the selected analysis…</p><Skeleton className="h-64 w-full" /></div>
          ) : selectedId && !run && detail.isError ? (
            <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/5 p-5 text-sm">
              <p className="font-medium text-destructive">Could not load this analysis. Your saved data has not been deleted.</p>
              <button onClick={() => detail.refetch()} className="mt-3 inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-xs font-medium"><RotateCcw className="h-3.5 w-3.5" /> Try again</button>
            </div>
          ) : history.isLoading ? (
            <div className="space-y-3"><Skeleton className="h-8 w-1/2" /><Skeleton className="h-24 w-full" /><Skeleton className="h-64 w-full" /></div>
          ) : history.isError ? (
            <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/5 p-5 text-sm">
              <p className="font-medium text-destructive">Could not load your saved analyses. You can still ask a new question.</p>
              <button data-testid="button-retry-history" onClick={() => history.refetch()} className="mt-3 inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-xs font-medium"><RotateCcw className="h-3.5 w-3.5" /> Try again</button>
            </div>
          ) : !run ? (
            <section aria-labelledby="examples-h">
              <div className="mb-4 flex items-end justify-between gap-4">
                <h2 id="examples-h" className="font-display text-xl font-semibold">Start from a representative question</h2>
                <span className="font-mono text-[11px] text-muted-foreground">Choose an example, then press Ask above</span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {EXAMPLES.map((ex, i) => (
                  <button key={i} data-testid={`button-example-${i}`}
                    onClick={() => { setText(ex.q); setFollowUp(null); inputRef.current?.focus(); inputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }); }}
                    className={`group rounded-xl border bg-card p-4 text-left transition-all hover:-translate-y-0.5 hover:border-primary disabled:opacity-50 ${i === 4 ? "sm:col-span-2" : ""}`}>
                    <span className="mb-2 inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-primary"><ex.icon className="h-3.5 w-3.5" />{ex.kind}</span>
                    <span className="block text-sm leading-snug">{ex.q}</span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
        </div>

        <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          <div className="rounded-xl border bg-secondary p-4 text-secondary-foreground">
            <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold"><Receipt className="h-4 w-4 text-[hsl(153_57%_55%)]" /> Usage and billing</h2>
            {history.isLoading ? <Skeleton className="h-16 w-full bg-white/10" /> : (
              <div className="space-y-2 text-xs leading-relaxed text-secondary-foreground/80">
                <p data-testid="text-notice">{history.data?.notice || "Each question runs an AI model billed to the app owner's Replit credits. Questions only run when you press Ask."}</p>
                {!available && <p data-testid="status-unavailable" className="rounded bg-destructive/30 px-2 py-1 text-secondary-foreground">New questions are switched off because the managed OpenAI integration (Replit AI Integrations, billed to Replit credits) is not enabled for this app. The app owner needs to enable it; saved analyses stay readable and exportable meanwhile.</p>}
              </div>
            )}
          </div>
          <div className="rounded-xl border bg-card">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold"><History className="h-4 w-4 text-primary" /> Your analyses</h2>
              <button data-testid="button-new-question" onClick={() => { setSelectedId(null); setCompletedAnswer(null); setFollowUp(null); setRun(null); setText(""); inputRef.current?.focus(); inputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }); }}
                disabled={running} className="text-xs font-medium text-primary hover:underline disabled:opacity-40">New</button>
            </div>
            {deleteNotice && <p role="status" className="px-4 pt-3 text-xs text-primary">{deleteNotice}</p>}
            {history.isLoading ? <div className="space-y-2 p-4"><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
              : history.isError && answers.length === 0 ? <p className="p-4 text-xs text-destructive">Saved analyses could not be loaded. This does not mean they have been deleted.</p>
              : answers.length === 0 ? <p className="p-4 text-xs text-muted-foreground">Nothing yet. Completed analyses are kept for this browser for 7 days (last 20).</p>
              : (
                <ul className="max-h-[50vh] overflow-y-auto p-1.5">
                  {answers.map((a) => {
                    const active = selectedId === a.id && !run;
                    return (
                      <li key={a.id} className="flex items-center gap-1">
                        <button data-testid={`button-history-${a.id}`} disabled={running} onClick={() => { setSelectedId(a.id); setRun(null); setFollowUp(null); }}
                          aria-current={active}
                          className={`min-w-0 flex-1 rounded-lg px-3 py-2 text-left transition-colors disabled:opacity-50 ${active ? "bg-muted" : "hover:bg-muted/60"}`}>
                          <span className={`block truncate text-sm ${active ? "font-semibold" : ""}`}>{a.title}</span>
                          <span className="block font-mono text-[10px] text-muted-foreground">{fmtStamp(a.createdAt, a.timezone)}</span>
                        </button>
                        <button type="button" data-testid={`button-delete-${a.id}`} aria-label={`Delete ${a.title}`} title={`Delete ${a.title}`}
                          disabled={running || deleting} onClick={() => { setDeleteTarget(a); setDeleteError(""); setDeleteNotice(""); }}
                          className="mr-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
          </div>
        </aside>
      </div>
      <AlertDialog open={!!deleteTarget} onOpenChange={open => { if (!open && !deleting) { setDeleteTarget(null); setDeleteError(""); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this analysis?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong className="font-medium text-foreground">{deleteTarget?.title}</strong>
              <span className="mt-2 block">This permanently deletes this saved question and its results. You will no longer be able to reopen or export it. Other saved analyses and files you have already downloaded are not affected.</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && <p role="alert" className="text-sm text-destructive">{deleteError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction data-testid="button-confirm-delete" disabled={deleting} onClick={event => { event.preventDefault(); void removeAnalysis(); }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {deleting ? "Deleting…" : "Delete analysis"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
