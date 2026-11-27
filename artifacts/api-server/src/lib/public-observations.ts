// This cache accepts only normalized responses downloaded from fixed public
// Elexon observation routes. Never pass Ask datasets, questions or credentials.
export type PublicObservations = {
  rows: Record<string, unknown>[];
  metadata: Record<string, unknown>;
  fetchedAt: string;
};
export const HISTORICAL_TTL_MS = 6 * 60 * 60 * 1000;
const DAY = 86400000;
const PREFIX = "/bmrs/api/v1";

function historicalKey(source: string, now: number): string | undefined {
  const url = new URL(source);
  if (url.origin !== "https://data.elexon.co.uk" || url.username || url.password || url.hash) return;
  const path = url.pathname.slice(PREFIX.length);
  if (!url.pathname.startsWith(`${PREFIX}/`)) return;
  let end: number;
  if (/^\/datasets\/(?:FUELHH|FUELINST|ITSDO|INDO|AGPT)$/.test(path) || path === "/demand/outturn") {
    const from = url.searchParams.get("settlementDateFrom");
    const to = url.searchParams.get("settlementDateTo");
    if (!from || !to || ![from, to].every((s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s)) return;
    if (from > to) return;
    // Inclusive London settlement dates: a two-day buffer covers UTC offsets
    // and the end of the final day without assuming 48 settlement periods.
    end = Date.parse(to) + 2 * DAY;
  } else if (path === "/generation/actual/per-type") {
    const from = Date.parse(url.searchParams.get("from") ?? "");
    end = Date.parse(url.searchParams.get("to") ?? "");
    if (!Number.isFinite(from) || end <= from) return;
  } else {
    const date = path.match(/^\/balancing\/settlement\/system-prices\/(\d{4}-\d{2}-\d{2})(?:\/\d+)?$/)?.[1];
    if (!date || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) return;
    end = Date.parse(date) + 2 * DAY;
  }
  if (!Number.isFinite(end) || end > now - 7 * DAY) return;
  // Preserve all upstream filters, including repeated array values and revision
  // selectors. Local MCP page controls never form part of the source URL.
  url.searchParams.sort();
  return `public-observations-v1:${url}`;
}

function incomplete(metadata: Record<string, unknown>, rows: number): boolean {
  return Object.entries(metadata).some(([key, value]) => {
    if (value && typeof value === "object" && !Array.isArray(value)) return incomplete(value as Record<string, unknown>, rows);
    if (/^(incomplete|truncated|hasMore)$/i.test(key)) return value === true;
    if (/^(nextOffset|nextPage|nextPageToken|continuationToken)$/i.test(key)) return value != null && value !== "";
    return /^(totalCount|total)$/i.test(key) && typeof value === "number" && value > rows;
  });
}

export class PublicObservationCache {
  private entries = new Map<string, { value: PublicObservations; expires: number; bytes: number }>();
  private bytes = 0;

  constructor(
    private maxBytes = 64_000_000,
    private maxEntries = 4096,
    private now = () => Date.now(),
  ) {}

  get(source: string): PublicObservations | undefined {
    const key = historicalKey(source, this.now());
    if (!key) return;
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.expires <= this.now()) { this.remove(key); return; }
    this.entries.delete(key);
    this.entries.set(key, entry);
    // Each browser's normalization/calculation work owns its own copy.
    return structuredClone(entry.value);
  }

  set(source: string, value: PublicObservations): void {
    const key = historicalKey(source, this.now());
    const fetched = Date.parse(value.fetchedAt);
    if (!key || !value.rows.length || incomplete(value.metadata, value.rows.length) || !Number.isFinite(fetched)) return;
    const expires = fetched + HISTORICAL_TTL_MS;
    if (expires <= this.now()) return;
    // Explicit projection excludes any caller-owned fields from retained data.
    const snapshot = { rows: value.rows, metadata: value.metadata, fetchedAt: value.fetchedAt };
    const bytes = Buffer.byteLength(JSON.stringify(snapshot));
    if (bytes > this.maxBytes || this.maxEntries < 1) return;
    for (const [entryKey, entry] of this.entries) if (entry.expires <= this.now()) this.remove(entryKey);
    this.remove(key);
    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
      this.remove(this.entries.keys().next().value!);
    }
    this.entries.set(key, { value: structuredClone(snapshot), expires, bytes });
    this.bytes += bytes;
  }

  private remove(key: string) {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(key);
  }
}
