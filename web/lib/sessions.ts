/** Presentation of a job for lists: a title, a relative time and a tone. Nothing internal. */
import type { StatusTone } from "@/components/ui/status-dot";
import type { Job } from "@/lib/contracts";

export const SESSION_TONE: Record<Job["status"], StatusTone> = {
  queued: "active",
  running: "active",
  done: "good",
  errored: "bad",
};

const MAX_TITLE = 64;

export function sessionTitle(issue: string): string {
  const first = issue.split("\n", 1)[0].replace(/^[#\s>*-]+/, "").trim();
  if (!first) return "Untitled session";
  if (first.length <= MAX_TITLE) return first;
  const cut = first.slice(0, MAX_TITLE);
  const atWord = cut.lastIndexOf(" ");
  return `${cut.slice(0, atWord > 32 ? atWord : MAX_TITLE)}…`;
}

export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso.endsWith("Z") || iso.includes("+") ? iso : `${iso}Z`);
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, (now - then) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(then).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
