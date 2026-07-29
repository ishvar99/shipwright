import { cn } from "@/lib/cn";

export type StatusTone = "idle" | "active" | "good" | "warn" | "bad";

// Shape and label carry the meaning; colour only reinforces.
const TONE: Record<StatusTone, string> = {
  idle: "bg-subtle",
  active: "bg-accent animate-pulse",
  good: "bg-evidence-dense",
  warn: "bg-evidence-graph",
  bad: "bg-evidence-path",
};

export function StatusDot({ tone, label }: { tone: StatusTone; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[length:var(--text-ui)] text-muted">
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", TONE[tone])} />
      {label}
    </span>
  );
}
