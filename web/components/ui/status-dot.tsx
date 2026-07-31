import { cn } from "@/lib/cn";

export type StatusTone = "idle" | "active" | "good" | "warn" | "bad";

/** Status speaks the status palette. The accent means "working"; the evidence colours mean
 * retrieval channels and are never reused for state. */
const TONE: Record<StatusTone, string> = {
  idle: "bg-subtle",
  active: "bg-accent animate-pulse",
  good: "bg-ok",
  warn: "bg-warn",
  bad: "bg-danger",
};

export function StatusDot({ tone, label }: { tone: StatusTone; label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[length:var(--text-ui)] text-muted">
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", TONE[tone])} />
      {label}
    </span>
  );
}
