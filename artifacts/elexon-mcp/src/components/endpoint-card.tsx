import { AlertTriangle, ShieldCheck } from "lucide-react";
import type { ServerInfo } from "@workspace/api-client-react";
import { CopyButton, endpointUrl, isPreviewHost } from "@/components/shell";

export function EndpointCard({ info }: { info: ServerInfo }) {
  const url = endpointUrl(info.endpointPath);
  const preview = isPreviewHost();
  return (
    <div className="rounded-xl border bg-card p-5 shadow-[0_1px_0_hsl(var(--border)),0_12px_30px_-18px_hsl(222_40%_12%/.35)]">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">MCP endpoint</span>
        {preview ? (
          <span data-testid="badge-preview" className="rounded-full bg-chart-4/20 px-2 py-0.5 font-mono text-[11px] text-foreground">preview only</span>
        ) : (
          <span className="rounded-full bg-accent/15 px-2 py-0.5 font-mono text-[11px] text-accent">live</span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <code data-testid="text-endpoint-url" className="min-w-0 flex-1 break-all font-mono text-[15px] font-medium">{url}</code>
        <CopyButton text={url} label="Copy URL" testId="button-copy-url" />
      </div>
      {preview && (
        <div className="mt-4 flex gap-2.5 rounded-lg border border-chart-4/50 bg-chart-4/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-chart-4" />
          <p>
            This is a development preview URL. It can change or sleep at any time. Publish the app to get a stable endpoint, then copy it from the published site.
          </p>
        </div>
      )}
      <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5 text-accent" /> {info.transport} · {info.authentication} · read-only
      </div>
    </div>
  );
}
