import { INTERVAL_SECONDS, STALE_MS, type TargetId } from "./probe";

export const ALERT_COOLDOWN_MS = 30 * 60 * 1000;
export type Subject = TargetId | "checker";
export type Sample = { target: TargetId; slot: number; at: number; down: boolean };
type SubjectState = { down: boolean; changedAt: number; lastOutageAt: number };
export type AlertState = { armedAt: number; subjects: Record<Subject, SubjectState> };
export type AlertTransition = { subject: Subject; kind: "outage" | "recovery"; at: number };
const subjects: Subject[] = ["elexon", "mcp", "checker"];

export function initialAlertState(now: number): AlertState {
  return { armedAt: now, subjects: Object.fromEntries(subjects.map((s) =>
    [s, { down: false, changedAt: now, lastOutageAt: 0 }])) as AlertState["subjects"] };
}

// Pure policy: missing samples never imply an API outage or recovery. Degraded
// responses are successful. Only distinct, adjacent five-minute slots qualify.
export function evaluateAlerts(previous: AlertState, samples: Sample[], now: number) {
  const state = structuredClone(previous);
  const transitions: AlertTransition[] = [];
  const pairs = (["elexon", "mcp"] as const).map((target) =>
    samples.filter((s) => s.target === target && s.at <= now)
      .sort((a, b) => b.slot - a.slot).slice(0, 2));
  const paired = (rows: Sample[], after: number) => rows.length === 2 &&
    rows[0].slot - rows[1].slot === INTERVAL_SECONDS * 1000 &&
    rows.every((s) => s.at >= after && now - s.at <= STALE_MS);
  function change(subject: Subject, down: boolean) {
    const s = state.subjects[subject];
    if (s.down === down) return;
    if (down && s.lastOutageAt && now - s.lastOutageAt < ALERT_COOLDOWN_MS) return;
    s.down = down;
    s.changedAt = now;
    if (down) s.lastOutageAt = now;
    transitions.push({ subject, kind: down ? "outage" : "recovery", at: now });
  }
  for (let i = 0; i < 2; i++) {
    const subject = (["elexon", "mcp"] as const)[i], s = state.subjects[subject];
    const rows = pairs[i];
    if (paired(rows, Math.max(state.armedAt, s.changedAt)) && rows[0].down === rows[1].down) {
      change(subject, rows[0].down);
    }
  }
  const checker = state.subjects.checker;
  // A missing target also means incomplete checker coverage, not target downtime.
  const stale = pairs.some((rows) => !rows[0] || now - rows[0].at > STALE_MS);
  if (stale && now - state.armedAt > STALE_MS) change("checker", true);
  else if (!stale && pairs.every((rows) => paired(rows, Math.max(state.armedAt, checker.changedAt)))) {
    change("checker", false);
  }
  return { state, transitions };
}
