import type { AnalysisAnswer } from "@workspace/api-client-react";

export type AskEvent = { type: "progress" | "complete" | "error"; message: string; answer?: AnalysisAnswer };

export const MAX_QUESTION = 32000;

let browserToken: string | undefined;
export function askSessionHeaders(): Record<string, string> {
  if (!browserToken) {
    try {
      const saved = localStorage.getItem("ask-elexon-session");
      if (saved && /^[a-f0-9]{64}$/.test(saved)) browserToken = saved;
    } catch { /* Some embedded browsers deny persistent storage; keep a tab session. */ }
    if (!browserToken) {
      browserToken = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
      try { localStorage.setItem("ask-elexon-session", browserToken); } catch { /* Tab-scoped fallback. */ }
    }
  }
  return { "X-Ask-Session": browserToken };
}

export async function streamQuestion(
  body: { question: string; parentId?: string },
  signal: AbortSignal,
  onEvent: (e: AskEvent) => void,
): Promise<void> {
  const res = await fetch("/api/ask/questions", {
    method: "POST",
    credentials: "same-origin",
    headers: { ...askSessionHeaders(), "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    let msg = `The research desk returned ${res.status}.`;
    try {
      const j = await res.json();
      if (j && typeof j.error === "string") msg = j.error;
      else if (j && typeof j.message === "string") msg = j.message;
    } catch {
      /* not json */
    }
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let finished = false;
  const flush = (chunk: string) => {
    const data = chunk
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    let ev: AskEvent;
    try { ev = JSON.parse(data) as AskEvent; }
    catch { throw new Error("The server returned an unreadable analysis update. Please retry."); }
    if (ev.type === "complete" && !ev.answer) throw new Error("The server completed without returning an analysis. Please retry.");
    // Do not swallow callback/render/cache errors as though a result was displayed.
    onEvent(ev);
    if (ev.type === "complete" || ev.type === "error") finished = true;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        flush(buf.slice(0, i));
        buf = buf.slice(i + 2);
        if (finished) return;
      }
    }
    if (buf.trim()) flush(buf);
    if (!finished) throw new Error("The stream closed before an answer was completed. Nothing was saved; you can retry.");
  } finally {
    // A terminal event is sufficient: a proxy can keep the HTTP body open.
    // Release it immediately so completed/error results cannot leave controls busy.
    void reader.cancel().catch(() => { /* Already closed or aborted. */ });
    reader.releaseLock();
  }
}

export async function downloadExport(id: string, format: "xlsx" | "docx" | "pdf", title: string) {
  const res = await fetch(`/api/ask/answers/${encodeURIComponent(id)}/export/${format}`, { credentials: "same-origin", headers: askSessionHeaders() });
  if (!res.ok) {
    let msg = `Export failed (${res.status}).`;
    try {
      const j = await res.json();
      if (j && typeof j.error === "string") msg = j.error;
    } catch {
      /* binary or empty */
    }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "grid-mcp-analysis"}.${format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function fmtNum(v: number, unit?: string) {
  const abs = Math.abs(v);
  const s = abs >= 1000 ? v.toLocaleString("en-GB", { maximumFractionDigits: 0 }) : v.toLocaleString("en-GB", { maximumFractionDigits: abs < 10 ? 2 : 1 });
  return unit ? `${s} ${unit}` : s;
}

export function fmtCell(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "number") return fmtNum(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

export function fmtStamp(iso: string, tz: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return `${d.toLocaleString("en-GB", { timeZone: tz || "UTC", dateStyle: "medium", timeStyle: "short" })} ${tz || "UTC"}`;
  } catch {
    return `${d.toISOString().replace("T", " ").slice(0, 16)} UTC`;
  }
}

export function fmtExact(v: unknown): string {
  if (typeof v === "number") return Number.isFinite(v) ? v.toLocaleString("en-GB", { maximumFractionDigits: 20 }) : String(v);
  return fmtCell(v);
}
