import { cn } from "@/lib/cn";

export type Channel = "bm25" | "graph" | "dense" | "path";

/** Customer words for the four retrieval signals. The hue reinforces the label and means
 * channels only — nowhere else in the product. */
const CHANNELS: { channel: Channel; label: string; dot: string }[] = [
  { channel: "bm25", label: "Name match", dot: "bg-evidence-text" },
  { channel: "graph", label: "Call graph", dot: "bg-evidence-graph" },
  { channel: "dense", label: "Similar code", dot: "bg-evidence-dense" },
  { channel: "path", label: "Mentioned in issue", dot: "bg-evidence-path" },
];

export function EvidenceStrip({ channels, className }: { channels: Channel[]; className?: string }) {
  const present = CHANNELS.filter((c) => channels.includes(c.channel));
  if (!present.length) return null;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1.5", className)}>
      <span className="sr-only">
        {`Evidence: ${present.map((c) => c.label.toLowerCase()).join(", ")}`}
      </span>
      {present.map((c) => (
        <span
          key={c.channel}
          aria-hidden
          className="inline-flex items-center gap-1.5 rounded-full bg-soft px-2 py-0.5 text-xs font-medium text-muted"
        >
          <span className={cn("size-1.5 rounded-full", c.dot)} />
          {c.label}
        </span>
      ))}
    </span>
  );
}
