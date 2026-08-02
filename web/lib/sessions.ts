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

/** What a finished session produced, as one short fact — the difference between a list of
 * grey cards and a list that says what happened. Facts only, no adjectives. */
export function sessionFact(job: Job): string {
  if (job.status === "queued" || job.status === "running") return "running";
  if (job.status === "errored") return "didn't finish";
  const secs = job.wall_ms >= 1000 ? ` · ${Math.round(job.wall_ms / 1000)}s` : "";
  if (job.result.intent === "question") return `answered${secs}`;
  if (job.result.intent === "other") return "no code work needed";
  const n = job.result.locations.length;
  return n > 0 ? `${n} places found${secs}` : "done";
}

/** The backend column is `timestamp without time zone`, so the wire string carries no offset and
 * must be read as UTC. Every consumer has to agree, or a row's day header and its own relative
 * time disagree about which day it was. */
export function parseJobTime(iso: string): number {
  return Date.parse(iso.endsWith("Z") || iso.includes("+") ? iso : `${iso}Z`);
}

export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = parseJobTime(iso);
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, (now - then) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(then).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
