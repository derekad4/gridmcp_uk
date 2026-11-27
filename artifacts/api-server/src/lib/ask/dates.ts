export function londonDate(instant: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const v = (name: string) => parts.find((p) => p.type === name)!.value;
  return `${v("year")}-${v("month")}-${v("day")}`;
}
export function londonMidnight(day: string) {
  const utc = new Date(`${day}T00:00:00Z`);
  const name = new Intl.DateTimeFormat("en", { timeZone: "Europe/London", timeZoneName: "shortOffset" }).formatToParts(utc).find((p) => p.type === "timeZoneName")!.value;
  const match = /GMT([+-])(\d+)(?::(\d+))?/.exec(name);
  const minutes = match ? (match[1] === "+" ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3] ?? 0)) : 0;
  return new Date(utc.getTime() - minutes * 60000).toISOString();
}
// Resolve only unambiguous ranges. Leave other wording to the analyst rather
// than silently replacing the user's month with today's date.
export function questionInterval(question: string, now = new Date()): { from: number; to: number } | undefined {
  const stamps = question.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})/gi) ?? [];
  if (stamps.length === 2) {
    const from = Date.parse(stamps[0]), to = Date.parse(stamps[1]);
    return Number.isFinite(from) && Number.isFinite(to) && to > from ? { from, to } : undefined;
  }
  if (stamps.length) return undefined;
  const today = londonDate(now);
  const rolling = /\b(?:past|last|previous)\s+(\d+|one|two|three|six|twelve)\s+months?\b/i.exec(question);
  if (rolling) {
    const words: Record<string, number> = { one: 1, two: 2, three: 3, six: 6, twelve: 12 };
    const count = words[rolling[1].toLowerCase()] ?? Number(rolling[1]);
    if (!Number.isSafeInteger(count) || count < 1 || count > 1200) return undefined;
    const [y, m, d] = today.split("-").map(Number);
    const target = new Date(Date.UTC(y, m - 1 - count, 1));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(d, lastDay));
    return { from: Date.parse(londonMidnight(target.toISOString().slice(0, 10))), to: now.getTime() };
  }
  let year: number | undefined, month: number | undefined;
  const explicit = /\b(\d{4})-(0[1-9]|1[0-2])(?!-\d{2})\b/.exec(question);
  const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const named = new RegExp(`\\b(${months.join("|")})\\s+(\\d{4})\\b`, "i").exec(question);
  if (explicit) { year = Number(explicit[1]); month = Number(explicit[2]); }
  else if (named) { year = Number(named[2]); month = months.indexOf(named[1].toLowerCase()) + 1; }
  else if (/\b(?:last|previous|this|current) month\b/i.test(question)) {
    year = Number(today.slice(0, 4));
    month = Number(today.slice(5, 7)) - (/\b(?:last|previous) month\b/i.test(question) ? 1 : 0);
  }
  if (year !== undefined && month !== undefined) {
    const day = (offset: number) => new Date(Date.UTC(year, month - 1 + offset, 1)).toISOString().slice(0, 10);
    const from = Date.parse(londonMidnight(day(0)));
    const end = Date.parse(londonMidnight(day(1)));
    return { from, to: /\b(?:this|current) month\b/i.test(question) ? Math.min(end, now.getTime()) : end };
  }
  const days = question.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? [];
  if (days.length === 2 && days.every((day) => Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day) && days[1] >= days[0]) {
    const afterLast = new Date(Date.parse(days[1]) + 86400000).toISOString().slice(0, 10);
    return { from: Date.parse(londonMidnight(days[0])), to: Date.parse(londonMidnight(afterLast)) };
  }
  return undefined;
}
export function relativeDates(now: Date) {
  const today = londonDate(now);
  const shift = (days: number) => new Date(Date.parse(`${today}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  const yesterday = shift(-1);
  return {
    today: { settlementDate: today, from: londonMidnight(today), to: londonMidnight(shift(1)) },
    yesterday: { settlementDate: yesterday, from: londonMidnight(yesterday), to: londonMidnight(today) },
    lastSevenCompletedLondonDays: { from: londonMidnight(shift(-7)), to: londonMidnight(today) },
    note: "These are local calendar boundaries expressed as UTC instants, not fixed 24-hour offsets. Native endpoint interval semantics still apply; convenience range tools require <=24h so DST autumn days need narrower requests.",
  };
}
