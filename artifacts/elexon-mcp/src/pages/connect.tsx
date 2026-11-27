import { ExternalLink } from "lucide-react";
import { useGetServerInfo, getGetServerInfoQueryKey } from "@workspace/api-client-react";
import { EndpointCard } from "@/components/endpoint-card";
import { CodeBlock, CopyButton, ELEXON_DOCS, endpointUrl } from "@/components/shell";
import { Skeleton } from "@/components/ui/skeleton";

const PROMPTS = [
  "What were the GB system buy and sell prices for each settlement period on 2025-01-15?",
  "Break down GB generation by fuel type between 2025-01-15T06:00:00Z and 2025-01-15T12:00:00Z. Which fuel peaked?",
  "Compare demand outturn with the wind forecast for yesterday afternoon in UTC.",
  "Find the settlement period with the highest system price on the last Sunday of March 2025, remembering that day has 46 periods.",
  "Find the native reference-data tool for BM units and list available units, paging through results.",
  "Find REMIT message-search tools and show the required filters before querying outage notices.",
];

export default function Connect() {
  const info = useGetServerInfo({ query: { queryKey: getGetServerInfoQueryKey() } });
  const path = info.data?.endpointPath ?? "/api/mcp";
  const config = JSON.stringify({ mcpServers: { "grid-mcp": { url: endpointUrl(path) } } }, null, 2);

  const steps = [
    { t: "Copy the endpoint", d: "Use the URL below. For a stable address, publish the app and copy the URL from the published site." },
    { t: "Add a remote server", d: "In your MCP client, add a remote server using Streamable HTTP transport. Clients that only support local stdio servers cannot connect directly." },
    { t: "Skip authentication", d: "The server is public and read-only. Do not configure tokens or headers." },
    { t: "Refresh tool discovery", d: "Reconnect or refresh your client’s tool list after upgrading. It now includes every documented GET operation and the four original shortcuts. Clients may limit the number of tools they enable; use their tool-selection controls if necessary." },
  ];

  return (
    <div className="mx-auto max-w-6xl px-5 py-12">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">Connect</p>
      <h1 className="mt-2 font-display text-4xl font-extrabold md:text-5xl">Plug in a remote MCP client</h1>
      <p className="mt-3 max-w-2xl text-muted-foreground">Stateless Streamable HTTP. Each request is independent, so there are no sessions to keep alive.</p>
      <p className="mt-4 max-w-3xl text-sm text-muted-foreground">{info.data?.endpointCount ?? "All documented"} native endpoint tools plus four convenience tools. Native tools retain the <code>elexon_get_</code> prefix to identify the upstream API source and preserve compatibility with existing clients. They use the original API parameter names. Their pagination controls are <code>_limit</code> and <code>_offset</code>; follow <code>nextOffset</code> to continue. The four <code>get_*</code> shortcuts retain <code>limit</code>/<code>offset</code>.</p>
      <p className="mt-3 max-w-3xl text-sm text-muted-foreground">Native tools preserve endpoint-specific units, metadata and nested records. Small JSON, XML, CSV and text responses are supported. Downloads over 4 MB or single records over the response budget fail explicitly: narrow the upstream filters rather than just reducing the local page size. Legacy endpoints remain discoverable but may have been retired by Elexon.</p>

      <div className="mt-10 grid gap-10 md:grid-cols-[1fr_1.1fr]">
        <ol className="space-y-6">
          {steps.map((s, i) => (
            <li key={s.t} className="flex gap-4">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 border-primary font-mono text-sm font-bold text-primary">{i + 1}</span>
              <div>
                <h3 className="font-display font-bold">{s.t}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{s.d}</p>
              </div>
            </li>
          ))}
        </ol>
        <div className="space-y-5">
          {info.isLoading ? <Skeleton className="h-40 w-full rounded-xl" /> : info.data ? <EndpointCard info={info.data} /> : (
            <p className="text-sm text-destructive">Server info unavailable; using default path {path}.</p>
          )}
          <CodeBlock code={config} testId="config" label="remote client config" />
          <p className="text-xs text-muted-foreground">Key names vary by client. Some expect <code className="font-mono">serverUrl</code> or a <code className="font-mono">type</code> field; the URL is what matters.</p>
        </div>
      </div>

      <section className="mt-16">
        <h2 className="font-display text-2xl font-bold">Example prompts</h2>
        <div className="mt-5 grid gap-3 md:grid-cols-2">
          {PROMPTS.map((p, i) => (
            <div key={i} className="group flex items-start justify-between gap-3 rounded-lg border bg-card p-4 transition-colors hover:border-primary">
              <p data-testid={`text-prompt-${i}`} className="text-sm">{p}</p>
              <CopyButton text={p} testId={`button-copy-prompt-${i}`} />
            </div>
          ))}
        </div>
      </section>

      <section className="mt-16 rounded-xl border bg-muted/50 p-6">
        <h2 className="font-display text-xl font-bold">Source and attribution</h2>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          Every tool result includes its source, source URL and fetch time. Results are cached for {info.data?.cacheTtlSeconds ?? "a short period of"} seconds; Elexon revises data through settlement, so cite fetchedAt when reporting figures. This project is independent and not operated by Elexon.
        </p>
        <a href={ELEXON_DOCS} target="_blank" rel="noreferrer" data-testid="link-connect-docs" className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
          bmrs.elexon.co.uk/api-documentation <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </section>
    </div>
  );
}

