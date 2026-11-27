import { useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Check, Copy, ExternalLink } from "lucide-react";
import { useHealthCheck, getHealthCheckQueryKey } from "@workspace/api-client-react";
import { InstallAppButton, InstallBanner, OfflineBanner } from "@/components/install-app";

export const ELEXON_DOCS = "https://bmrs.elexon.co.uk/api-documentation";

export function endpointUrl(path: string) {
  return window.location.origin + path;
}
export function isPreviewHost() {
  return window.location.hostname.endsWith(".replit.dev");
}

export function CopyButton({ text, label = "Copy", testId }: { text: string; label?: string; testId: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      data-testid={testId}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        } catch {
          /* clipboard unavailable */
        }
      }}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-mono text-xs transition-all active:scale-95 ${
        done ? "border-accent bg-accent text-accent-foreground" : "bg-card hover:border-primary hover:text-primary"
      }`}
    >
      {done ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {done ? "Copied" : label}
    </button>
  );
}

export function CodeBlock({ code, testId, label }: { code: string; testId: string; label?: string }) {
  return (
    <div className="overflow-hidden rounded-lg border bg-secondary text-secondary-foreground">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <span className="font-mono text-[11px] uppercase tracking-widest text-secondary-foreground/60">{label ?? "json"}</span>
        <CopyButton text={code} testId={`button-copy-${testId}`} />
      </div>
      <pre data-testid={`code-${testId}`} className="overflow-x-auto p-4 font-mono text-[13px] leading-relaxed">{code}</pre>
    </div>
  );
}

function Mark() {
  return (
    <svg viewBox="0 0 32 32" className="h-8 w-8" aria-hidden>
      <rect width="32" height="32" rx="7" fill="hsl(var(--secondary))" />
      <path d="M4 16 Q8 6 12 16 T20 16 T28 16" fill="none" stroke="hsl(var(--primary))" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="20" cy="16" r="2.2" fill="hsl(40 40% 98%)" />
    </svg>
  );
}

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/ask", label: "Ask" },
  { href: "/tools", label: "Tools" },
  { href: "/connect", label: "Connect" },
  { href: "/health", label: "Health" },
];

export function Shell({ children }: { children: ReactNode }) {
  const [loc] = useLocation();
  const health = useHealthCheck({ query: { queryKey: getHealthCheckQueryKey(), refetchInterval: 30000 } });
  const ok = health.data?.status === "ok";
  const state = health.isLoading ? "checking" : ok ? "online" : "unreachable";
  return (
    <div className="flex min-h-[100dvh] flex-col">
      <header className="sticky top-0 z-30 border-b bg-background/85 pt-[env(safe-area-inset-top)] backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-3 sm:gap-4 sm:px-5">
          <Link href="/" aria-label="Grid MCP home" data-testid="link-home" className="flex items-center gap-2.5">
            <Mark />
            <span className="hidden font-display text-lg font-extrabold min-[420px]:inline">Grid <span className="text-primary">MCP</span></span>
          </Link>
          <nav className="ml-auto flex items-center gap-1">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                data-testid={`link-nav-${n.label.toLowerCase()}`}
                className={`rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors sm:px-3 ${
                  loc === n.href ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <div data-testid="status-health" className="hidden items-center gap-2 rounded-full border bg-card px-3 py-1 font-mono text-xs sm:flex">
            <span className="relative flex h-2 w-2">
              {ok && <span className="pulse-ring absolute inset-0 rounded-full bg-accent" />}
              <span className={`relative h-2 w-2 rounded-full ${ok ? "bg-accent" : health.isLoading ? "bg-muted-foreground" : "bg-destructive"}`} />
            </span>
            {state}
          </div>
          <InstallAppButton />
        </div>
        <OfflineBanner />
        <InstallBanner />
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t bg-muted/50">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-5 py-8 pb-[max(2rem,env(safe-area-inset-bottom))] text-sm text-muted-foreground md:flex-row md:items-center md:justify-between">
          <p className="max-w-xl">
            Independent project. Not affiliated with or endorsed by Elexon. Data sourced from the Elexon Insights Solution (BMRS) public API under its licence terms.
          </p>
          <a href={ELEXON_DOCS} target="_blank" rel="noreferrer" data-testid="link-footer-docs" className="inline-flex items-center gap-1.5 font-medium text-foreground hover:text-primary">
            Official Elexon API docs <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </footer>
    </div>
  );
}
