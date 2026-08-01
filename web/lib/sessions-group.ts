import type { Job } from "@/lib/contracts";
import { parseJobTime } from "@/lib/sessions";

export type SessionGroup = { label: string; sessions: Job[] };

/** Calendar days in the viewer's timezone, not 24-hour buckets: a session from 23:50 last night
 * should read "Yesterday" at 00:10, not "Today". */
function dayIndex(ms: number): number {
  const offset = new Date(ms).getTimezoneOffset() * 60_000;
  return Math.floor((ms - offset) / 86_400_000);
}

/** Groups an already-sorted list. Adjacent runs only — the list arrives newest-first, so a
 * label can never appear twice. */
export function groupSessions(sessions: readonly Job[], now: number = Date.now()): SessionGroup[] {
  const today = dayIndex(now);
  const out: SessionGroup[] = [];
  for (const s of sessions) {
    const ms = parseJobTime(s.created_at); // same instant the row's relative time shows
    const delta = Number.isFinite(ms) ? today - dayIndex(ms) : 0;
    const label =
      delta <= 0
        ? "Today"
        : delta === 1
          ? "Yesterday"
          : new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
    const last = out[out.length - 1];
    if (last && last.label === label) last.sessions.push(s);
    else out.push({ label, sessions: [s] });
  }
  return out;
}
