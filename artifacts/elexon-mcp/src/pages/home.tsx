import { Link } from "wouter";
import { ArrowRight, RefreshCw } from "lucide-react";
import { useGetServerInfo, getGetServerInfoQueryKey, useListTools, getListToolsQueryKey } from "@workspace/api-client-react";
import { EndpointCard } from "@/components/endpoint-card";
import { Skeleton } from "@/components/ui/skeleton";

const NOTES = [
  { k: "MW vs MWh", v: "MW is instantaneous power; MWh is energy over time. A 30-minute settlement period at an average 1,000 MW delivers 500 MWh. Generation and demand outturn report MW averages per period." },
  { k: "Dates and intervals", v: "Native endpoint tools follow Elexon’s documented filters and interval rules. The three convenience range tools use UTC/offset timestamps, [from,to), and a 24-hour maximum. Use narrow filters for large datasets." },
  { k: "Settlement dates", v: "Settlement dates follow the London calendar. Most days have 48 half-hour periods, but the spring clock change day has 46 and the autumn one has 50." },
  { k: "Data revisions", v: "Elexon publishes initial values that are later revised through settlement runs. The same query can return different figures later; record fetchedAt alongside results." },
];

export default function Home() {
  const info = useGetServerInfo({ query: { queryKey: getGetServerInfoQueryKey() } });
  const tools = useListTools({ query: { queryKey: getListToolsQueryKey() } });

  return (
    <div>
      <section className="relative overflow-hidden border-b grid-paper">
        <svg className="wave pointer-events-none absolute bottom-6 left-0 h-24 w-[200%] opacity-40" viewBox="0 0 800 60" preserveAspectRatio="none" aria-hidden>
          <path d="M0 30 Q25 0 50 30 T100 30 T150 30 T200 30 T250 30 T300 30 T350 30 T400 30 T450 30 T500 30 T550 30 T600 30 T650 30 T700 30 T750 30 T800 30" fill="none" stroke="hsl(var(--primary))" strokeWidth="1.5" />
        </svg>
        <div className="relative mx-auto grid max-w-6xl gap-10 px-5 py-16 md:grid-cols-[1.2fr_1fr] md:py-24">
          <div className="rise">
            <p className="mb-4 font-mono text-xs uppercase tracking-[0.2em] text-primary">Model Context Protocol · GB power market</p>
            <h1 className="font-display text-5xl font-extrabold leading-[0.95] md:text-7xl">
              Britain's grid,<br />on the wire to<br />your <span className="text-primary">agent</span>.
            </h1>
            <p className="mt-6 max-w-lg text-lg text-muted-foreground">
              An independent, read-only MCP server over Elexon’s full documented API: balancing, REMIT, generation, demand, forecasts, settlement and reference data. No Elexon API key required.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/connect" data-testid="link-hero-connect" className="group inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 font-medium text-primary-foreground transition-transform active:scale-[.98]">
                Connect a client <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
              <Link href="/tools" data-testid="link-hero-tools" className="inline-flex items-center gap-2 rounded-lg border bg-card px-5 py-2.5 font-medium hover:border-foreground">
                Try the tools
              </Link>
            </div>
          </div>
          <div className="rise self-center" style={{ animationDelay: "120ms" }}>
            {info.isLoading ? (
              <Skeleton className="h-48 w-full rounded-xl" />
            ) : info.isError || !info.data ? (
              <div className="rounded-xl border border-destructive/40 bg-card p-5 text-sm">
                <p className="font-medium text-destructive">Server info unavailable.</p>
                <p className="mt-1 text-muted-foreground">{info.error?.message}</p>
                <button data-testid="button-retry-info" onClick={() => info.refetch()} className="mt-3 inline-flex items-center gap-1.5 font-mono text-xs hover:text-primary"><RefreshCw className="h-3.5 w-3.5" /> retry</button>
              </div>
            ) : (
              <EndpointCard info={info.data} />
            )}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-14">
        <h2 className="mb-6 font-display text-2xl font-bold">Server spec</h2>
        <dl className="grid grid-cols-2 border-l border-t md:grid-cols-4">
          {(
            [
              ["Name", info.data?.name],
              ["Version", info.data?.version],
              ["Status", info.data?.status],
              ["Transport", info.data?.transport],
              ["Endpoint path", info.data?.endpointPath],
              ["Authentication", info.data?.authentication],
              ["Tools", info.data?.toolCount],
              ["Cache TTL", info.data ? `${info.data.cacheTtlSeconds}s` : undefined],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="border-b border-r bg-card p-4">
              <dt className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">{k}</dt>
              <dd data-testid={`text-spec-${k.toLowerCase().replace(/ /g, "-")}`} className="mt-1 truncate font-mono text-sm font-medium">
                {info.isLoading ? <Skeleton className="h-5 w-20" /> : v ?? "—"}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mx-auto max-w-6xl px-5 pb-14">
        <div className="mb-6 flex items-end justify-between">
          <h2 className="font-display text-2xl font-bold">Full API, plus familiar shortcuts</h2>
          <Link href="/tools" data-testid="link-all-tools" className="text-sm font-medium text-primary hover:underline">Open executor</Link>
        </div>
        <p className="mb-5 text-sm text-muted-foreground">{info.data?.endpointCount ?? "All documented"} GET operations, plus four convenience tools. Search the complete catalog by category, endpoint or dataset in the executor.</p>
        {info.data?.specificationUrl && <p className="mb-5 break-all font-mono text-xs text-muted-foreground">Catalog {info.data.catalogVersion} · <a className="text-primary underline" href={info.data.specificationUrl} target="_blank" rel="noreferrer">OpenAPI source</a><br />SHA-256: {info.data.specificationHash}</p>}
        {tools.isLoading ? (
          <div className="space-y-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
        ) : tools.isError ? (
          <p className="text-sm text-destructive">Could not load tools. <button data-testid="button-retry-tools" className="underline" onClick={() => tools.refetch()}>Retry</button></p>
        ) : !tools.data?.length ? (
          <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">The server reports no tools.</p>
        ) : (
          <ul className="divide-y rounded-xl border bg-card">
            {tools.data.filter((tool) => tool.kind === "convenience").map((t) => (
              <li key={t.name} className="group">
                <Link href={`/tools?tool=${t.name}`} data-testid={`link-tool-${t.name}`} className="flex flex-col gap-1 px-5 py-4 transition-colors hover:bg-muted/60 md:flex-row md:items-center md:gap-6">
                  <code className="w-64 shrink-0 font-mono text-sm font-medium text-primary">{t.name}</code>
                  <span className="flex-1 text-sm text-muted-foreground">{t.description}</span>
                  <ArrowRight className="hidden h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-1 md:block" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="border-t bg-secondary text-secondary-foreground">
        <div className="mx-auto max-w-6xl px-5 py-14">
          <h2 className="mb-8 font-display text-2xl font-bold">Read the numbers correctly</h2>
          <div className="grid gap-x-10 gap-y-8 md:grid-cols-2">
            {NOTES.map((n) => (
              <div key={n.k} className="border-l-2 border-primary pl-4">
                <h3 className="font-mono text-sm font-bold text-primary">{n.k}</h3>
                <p className="mt-2 text-sm leading-relaxed text-secondary-foreground/80">{n.v}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
