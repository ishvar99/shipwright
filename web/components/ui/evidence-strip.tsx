import { cn } from "@/lib/cn";

export type Channel = "bm25" | "graph" | "dense" | "path";

// Order is fixed so the eye reads columns down a list of results.
const SLOTS: { channel: Channel; glyph: string; name: string; color: string }[] = [
  { channel: "bm25", glyph: "T", name: "text match", color: "text-evidence-text" },
  { channel: "graph", glyph: "G", name: "call graph", color: "text-evidence-graph" },
  { channel: "dense", glyph: "D", name: "embedding", color: "text-evidence-dense" },
  { channel: "path", glyph: "P", name: "path in issue", color: "text-evidence-path" },
];

export function EvidenceStrip({
  channels,
  className,
}: {
  channels: Channel[];
  className?: string;
}) {
  const active = new Set(channels);
  const summary = SLOTS.filter((s) => active.has(s.channel)).map((s) => s.name);
  const label = summary.length ? `Evidence: ${summary.join(", ")}` : "No evidence channels";

  return (
    <span
      className={cn("inline-flex gap-0.5 font-mono text-[11px] leading-none", className)}
      title={label}
    >
      <span className="sr-only">{label}</span>
      {SLOTS.map((slot) => {
        const on = active.has(slot.channel);
        return (
          <span
            key={slot.channel}
            aria-hidden
            className={cn(
              "grid size-4 place-items-center rounded-sm border",
              on
                ? cn("border-current bg-soft font-semibold", slot.color)
                : "border-hairline text-hairline",
            )}
          >
            {on ? slot.glyph : "·"}
          </span>
        );
      })}
    </span>
  );
}
