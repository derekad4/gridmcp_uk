import { useEffect, useMemo, useState } from "react";
import { useSearch } from "wouter";
import { Play, RotateCcw, ExternalLink, AlertCircle, Database } from "lucide-react";
import { useListTools, getListToolsQueryKey, useExecuteTool, type ToolInfo } from "@workspace/api-client-react";
import { CodeBlock } from "@/components/shell";
import { Skeleton } from "@/components/ui/skeleton";

export default function Tools() {
  const tools = useListTools({ query: { queryKey: getListToolsQueryKey() } });
  const search = useSearch();
  const initial = new URLSearchParams(search).get("tool");
  const [selected, setSelected] = useState<string | null>(initial);
  const [filter, setFilter] = useState("");
  const [category, setCategory] = useState("all");
  const [kind, setKind] = useState("all");

  const list = tools.data ?? [];
  const categories = useMemo(() => [...new Set(list.map((t) => t.category))].sort(), [list]);
  const filtered = useMemo(() => list.filter((tool) =>
    (category === "all" || tool.category === category) &&
    (kind === "all" || tool.kind === kind) &&
    `${tool.name} ${tool.title} ${tool.path ?? ""} ${tool.category} ${tool.description}`.toLowerCase().includes(filter.toLowerCase().trim()),
  ), [list, category, kind, filter]);
  const active = useMemo(() => filtered.find((t) => t.name === selected) ?? filtered[0], [filtered, selected]);

  return (
    <div className="mx-auto max-w-6xl px-5 py-12">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">Tools</p>
      <h1 className="mt-2 font-display text-4xl font-extrabold md:text-5xl">Catalog and executor</h1>
      <p className="mt-3 max-w-2xl text-muted-foreground">The same tools your MCP client sees. Edit the JSON arguments and run them against the live Elexon API.</p>
      <div className="mt-6 flex flex-wrap items-end gap-3 rounded-xl border bg-card p-4">
        <label className="min-w-48 flex-1 text-sm">
          <span className="mb-1 block font-medium">Search endpoints</span>
          <input data-testid="input-tool-search" type="search" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="REMIT, settlement prices, /datasets/…" className="w-full rounded-md border bg-background px-3 py-2" />
        </label>
        <label className="min-w-48 text-sm">
          <span className="mb-1 block font-medium">Category</span>
          <select data-testid="select-tool-category" value={category} onChange={(event) => setCategory(event.target.value)} className="w-full max-w-80 rounded-md border bg-background px-3 py-2">
            <option value="all">All categories</option>
            {categories.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium">Tool type</span>
          <select value={kind} onChange={(event) => setKind(event.target.value)} className="rounded-md border bg-background px-3 py-2">
            <option value="all">All tools</option><option value="endpoint">Native API endpoints</option><option value="convenience">Convenience tools</option>
          </select>
        </label>
        <p aria-live="polite" className="py-2 font-mono text-xs text-muted-foreground">{filtered.length} / {list.length} tools</p>
      </div>
      <p className="mt-3 text-sm text-muted-foreground">Native tools use Elexon’s exact parameter names and interval rules. <code>_limit</code>/<code>_offset</code> page the returned rows; use upstream date and identifier filters to keep downloads small. Example identifiers marked EXAMPLE must be replaced.</p>

      {tools.isLoading ? (
        <div className="mt-10 grid gap-6 md:grid-cols-[260px_1fr]">
          <div className="space-y-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16" />)}</div>
          <Skeleton className="h-96" />
        </div>
      ) : tools.isError ? (
        <div className="mt-10 rounded-xl border border-destructive/40 bg-card p-6">
          <p className="font-medium text-destructive">Could not load the tool catalog.</p>
          <p className="mt-1 text-sm text-muted-foreground">{tools.error?.message}</p>
          <button data-testid="button-retry-tools" onClick={() => tools.refetch()} className="mt-4 rounded-md border px-3 py-1.5 text-sm hover:border-primary">Retry</button>
        </div>
      ) : !active ? (
        <div className="mt-10 rounded-xl border border-dashed p-10 text-center text-muted-foreground">
          <Database className="mx-auto mb-3 h-6 w-6" /> {list.length ? "No tools match these filters." : "No tools are registered on this server."}
          {!!list.length && <button onClick={() => { setFilter(""); setCategory("all"); setKind("all"); }} className="mt-3 block w-full text-primary underline">Clear filters</button>}
        </div>
      ) : (
        <div className="mt-10 grid gap-6 md:grid-cols-[260px_1fr]">
          <nav aria-label="Available tools" className="flex max-h-[680px] gap-2 overflow-auto md:flex-col">
            {filtered.map((t) => {
              const on = t.name === active.name;
              return (
                <button
                  key={t.name}
                  data-testid={`button-select-${t.name}`}
                  onClick={() => setSelected(t.name)}
                  className={`shrink-0 rounded-lg border px-4 py-3 text-left transition-all ${on ? "border-primary bg-card shadow-[inset_3px_0_0_hsl(var(--primary))]" : "border-transparent hover:bg-muted"}`}
                >
                  <span className="block max-w-64 whitespace-normal text-sm font-semibold">{t.title}</span>
                  <span className="block font-mono text-[11px] text-muted-foreground">{t.category}</span>
                  {t.path && <span className="mt-1 block max-w-64 break-all font-mono text-[10px] text-muted-foreground">{t.method} {t.path}</span>}
                </button>
              );
            })}
          </nav>
          <Executor key={active.name} tool={active} />
        </div>
      )}
    </div>
  );
}

function Executor({ tool }: { tool: ToolInfo }) {
  const example = JSON.stringify(tool.example ?? {}, null, 2);
  const [text, setText] = useState(example);
  const [parseError, setParseError] = useState<string | null>(null);
  const [lastArgs, setLastArgs] = useState<Record<string, unknown> | null>(null);
  const exec = useExecuteTool();

  useEffect(() => {
    setText(example);
  }, [example]);

  const run = () => {
    let args: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Arguments must be a JSON object.");
      args = parsed;
    } catch (e) {
      setParseError(e instanceof Error ? e.message : "Invalid JSON");
      return;
    }
    setParseError(null);
    setLastArgs(args);
    exec.mutate({ data: { name: tool.name, arguments: args } });
  };

  const r = exec.data;
  const errMsg = exec.error ? describeError(exec.error) : null;

  return (
    <div className="min-w-0 space-y-6">
      <div className="rounded-xl border bg-card p-5">
        <code className="break-all font-mono text-sm text-primary">{tool.name}</code>
        {tool.path && <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{tool.method} {tool.path}</p>}
        {tool.deprecated && <p className="mt-2 text-sm font-medium text-destructive">Deprecated by Elexon. Prefer a current replacement where available.</p>}
        <p className="mt-2 whitespace-pre-line text-sm">{tool.description}</p>
        <div className="overflow-x-auto"><table className="mt-4 w-full text-left text-sm">
          <thead>
            <tr className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              <th className="pb-2 pr-4 font-normal">param</th><th className="pb-2 pr-4 font-normal">type</th><th className="pb-2 font-normal">notes</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {tool.parameters.map((p) => (
              <tr key={p.name} data-testid={`row-param-${p.name}`}>
                <td className="py-2 pr-4 font-mono">{p.name}{p.required && <span className="text-primary">*</span>}{p.location && <span className="block text-[10px] text-muted-foreground">{p.location}</span>}</td>
                <td className="py-2 pr-4 font-mono text-muted-foreground">{p.type}</td>
                <td className="py-2 text-muted-foreground">{p.description}{p.schema && <details className="mt-1"><summary className="cursor-pointer text-xs text-primary">Schema constraints</summary><pre className="max-w-sm overflow-auto whitespace-pre-wrap break-all text-[11px]">{JSON.stringify(p.schema, null, 2)}</pre></details>}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
        {tool.inputSchema && <details className="mt-4"><summary className="cursor-pointer text-sm text-primary">Full input schema</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">{JSON.stringify(tool.inputSchema, null, 2)}</pre></details>}
      </div>

      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="flex items-center justify-between border-b px-4 py-2">
          <span className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">arguments.json</span>
          <button data-testid="button-reset-args" onClick={() => { setText(example); setParseError(null); }} className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground">
            <RotateCcw className="h-3 w-3" /> reset to example
          </button>
        </div>
        <textarea
          data-testid="input-arguments"
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          rows={Math.max(5, text.split("\n").length + 1)}
          className="w-full resize-y bg-transparent p-4 font-mono text-[13px] outline-none focus:bg-muted/30"
        />
        <div className="flex items-center justify-between gap-3 border-t px-4 py-3">
          <span className="text-xs text-destructive" data-testid="text-parse-error">{parseError}</span>
          <button
            data-testid="button-execute"
            onClick={run}
            disabled={exec.isPending}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-transform active:scale-[.97] disabled:opacity-60"
          >
            <Play className="h-4 w-4" /> {exec.isPending ? "Running..." : "Execute"}
          </button>
        </div>
      </div>

      {exec.isPending && <Skeleton className="h-64 w-full rounded-xl" />}
      {!exec.isPending && errMsg && (
        <div data-testid="status-exec-error" className="flex gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
          <div>
            <p className="font-medium text-destructive">Tool call failed</p>
            <pre className="mt-1 whitespace-pre-wrap font-mono text-xs">{errMsg}</pre>
            <button data-testid="button-retry-exec" onClick={run} className="mt-2 underline">Retry</button>
          </div>
        </div>
      )}
      {!exec.isPending && !errMsg && !r && (
        <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground grid-paper">
          Results appear here. Nothing has been fetched yet.
        </div>
      )}
      {!exec.isPending && !errMsg && r && (
        <div className="rise space-y-3">
          <div className="flex flex-wrap gap-x-6 gap-y-2 font-mono text-xs" data-testid="text-result-meta">
            <span><span className="text-muted-foreground">rows </span>{r.count} / {r.totalCount}</span>
            <span><span className="text-muted-foreground">cached </span>{String(r.cached)}</span>
            {r.truncated && <span className="text-primary">truncated</span>}
            <span><span className="text-muted-foreground">fetched </span>{r.fetchedAt}</span>
            <a href={r.sourceUrl} target="_blank" rel="noreferrer" data-testid="link-source" className="inline-flex items-center gap-1 text-primary hover:underline">{r.source} <ExternalLink className="h-3 w-3" /></a>
          </div>
          {r.note && <p className="text-sm text-muted-foreground">{r.note}</p>}
          {r.data.length === 0 ? (
            <div className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">Elexon returned no rows for these arguments. Try a different date or range.</div>
          ) : null}
          <CodeBlock code={JSON.stringify(r, null, 2)} testId="result" label="result.json" />
          {r.truncated && lastArgs && <button
            data-testid="button-next-page"
            onClick={() => {
              const native = tool.kind === "endpoint";
              const offsetKey = native ? "_offset" : "offset";
              const args = { ...lastArgs, [offsetKey]: r.nextOffset ?? Number(lastArgs[offsetKey] ?? 0) + r.count };
              setText(JSON.stringify(args, null, 2)); setLastArgs(args); setParseError(null);
              exec.mutate({ data: { name: tool.name, arguments: args } });
            }}
            className="rounded-lg border border-primary px-4 py-2 text-sm font-medium text-primary hover:bg-muted"
          >Load next page</button>}
        </div>
      )}
    </div>
  );
}

function describeError(e: unknown): string {
  if (e && typeof e === "object") {
    const anyE = e as { data?: unknown; message?: string };
    if (anyE.data) return typeof anyE.data === "string" ? anyE.data : JSON.stringify(anyE.data, null, 2);
    if (anyE.message) return anyE.message;
  }
  return "Unknown error";
}
