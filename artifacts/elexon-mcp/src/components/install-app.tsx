import { useState, type ReactNode } from "react";
import { Download, Share, SquarePlus, WifiOff, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useInstallPrompt, useOnline } from "@/hooks/use-install-prompt";

const buttonClass = "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border bg-card px-2 text-sm font-medium transition-colors hover:border-primary hover:text-primary sm:px-2.5";

function IosSteps() {
  return (
    <PopoverContent align="end" className="w-72 text-sm" data-testid="popover-install-ios">
      <p className="mb-2 font-display font-bold">Add Grid MCP to your Home Screen</p>
      <ol className="space-y-2 text-muted-foreground">
        <li className="flex items-start gap-2"><Share className="mt-0.5 h-4 w-4 shrink-0 text-primary" />Tap the Share button in Safari.</li>
        <li className="flex items-start gap-2"><SquarePlus className="mt-0.5 h-4 w-4 shrink-0 text-primary" />Choose “Add to Home Screen”, then tap Add.</li>
      </ol>
    </PopoverContent>
  );
}

function InstallTrigger({ children, className, testId }: { children: ReactNode; className: string; testId: string }) {
  const { canPrompt, manual, install } = useInstallPrompt();
  if (canPrompt) {
    return <button type="button" onClick={() => void install()} data-testid={testId} aria-label="Install Grid MCP app" className={className}>{children}</button>;
  }
  if (!manual) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" data-testid={testId} aria-label="Install Grid MCP app" className={className}>{children}</button>
      </PopoverTrigger>
      <IosSteps />
    </Popover>
  );
}

/** Header control for tablets and desktops, where there is room beside the navigation. */
export function InstallAppButton() {
  return (
    <InstallTrigger testId="button-install-app" className={`hidden sm:inline-flex ${buttonClass}`}>
      <Download className="h-4 w-4" />
      <span className="hidden md:inline">Install</span>
    </InstallTrigger>
  );
}

const DISMISSED = "grid-mcp-install-dismissed";

/** Phones have no spare header width, so offer installation in a dismissible strip. */
export function InstallBanner() {
  const { canPrompt, manual } = useInstallPrompt();
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(DISMISSED) === "1"; } catch { return false; }
  });
  if (dismissed || (!canPrompt && !manual)) return null;
  return (
    <div data-testid="banner-install-app" className="flex items-center gap-3 border-b bg-muted/60 px-4 py-2 text-sm sm:hidden">
      <img src={`${import.meta.env.BASE_URL}icons/icon-192.png`} alt="" className="h-7 w-7 rounded-md" />
      <span className="flex-1 text-muted-foreground">Install Grid MCP for quick access from your home screen.</span>
      <InstallTrigger testId="button-install-app-mobile" className={buttonClass}>
        <Download className="h-4 w-4" /> Install
      </InstallTrigger>
      <button
        type="button"
        aria-label="Dismiss install suggestion"
        data-testid="button-dismiss-install"
        className="rounded-md p-1 text-muted-foreground hover:text-foreground"
        onClick={() => {
          try { localStorage.setItem(DISMISSED, "1"); } catch { /* storage unavailable */ }
          setDismissed(true);
        }}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div role="status" data-testid="banner-offline" className="border-b bg-secondary px-4 py-2 text-center text-sm text-secondary-foreground">
      <WifiOff className="mr-2 inline h-4 w-4 align-[-3px]" />
      You're offline. Live market data, Ask and health checks will resume when you reconnect.
    </div>
  );
}
