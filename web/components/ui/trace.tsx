import { StatusDot, type StatusTone } from "@/components/ui/status-dot";
import { cn } from "@/lib/cn";

export type TraceStage = {
  key: string;
  label: string;
  state: "pending" | "active" | "done" | "failed";
  durationMs?: number;
  detail?: string;
};

const TONE: Record<TraceStage["state"], StatusTone> = {
  pending: "idle",
  active: "active",
  done: "good",
  failed: "bad",
};

function ms(v?: number) {
  if (v === undefined) return "";
  return v < 1000 ? `${v}ms` : `${(v / 1000).toFixed(1)}s`;
}

export function Trace({ stages, className }: { stages: TraceStage[]; className?: string }) {
  return (
    <ol className={cn("flex flex-wrap items-center gap-x-4 gap-y-2", className)}>
      {stages.map((s) => (
        <li key={s.key} className="flex items-baseline gap-2">
          <StatusDot tone={TONE[s.state]} label={s.label} />
          {s.durationMs !== undefined && (
            <span className="font-mono text-[11px] tabular-nums text-subtle">
              {ms(s.durationMs)}
            </span>
          )}
          {s.detail && <span className="text-[11px] text-subtle">{s.detail}</span>}
        </li>
      ))}
    </ol>
  );
}
