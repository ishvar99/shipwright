import { StatusDot } from "@/components/ui/status-dot";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { jobLabel, streamLabel, type ActivityState, type Indicator } from "@/lib/stream/reduce";

/**
 * The two axes are separated structurally, not tonally. StatusDot's five tones differ only by
 * background colour and the reduced-motion rule freezes the pulse, so two dots alone would be
 * indistinguishable in greyscale — hence a static word per axis and a real hairline between them.
 */
function Axis({ name, value }: { name: string; value: Indicator }) {
  return (
    <span className="flex shrink-0 items-baseline gap-1.5" title={value.detail}>
      <span className="text-subtle">{name}</span>
      <StatusDot tone={value.tone} label={value.text} />
    </span>
  );
}

export function StatusBar({ state }: { state: ActivityState }) {
  const job = jobLabel(state);
  const stream = streamLabel(state);
  const repo = state.repo ?? "no repository";

  return (
    <div className="workspace-bar">
      {/* Tail-truncated: for owner__repo the identifying tokens are at the front. */}
      <span className="min-w-0 flex-1 truncate font-mono text-fg" title={repo}>
        {repo}
      </span>

      <Axis name="job" value={job} />
      <span className="flex shrink-0 items-baseline gap-1.5 border-l border-hairline pl-gutter">
        <span className="text-subtle">stream</span>
        {/* Bounded width: the label is backend-authored on the failure path. */}
        <span className="max-w-[22ch] truncate">
          <StatusDot tone={stream.tone} label={stream.text} />
        </span>
      </span>

      {/* First to go when the bar runs out of room; job, stream and theme never drop. */}
      <span className="hidden shrink-0 font-mono text-subtle md:inline" title={state.model}>
        {state.model ?? "—"}
      </span>
      <span className="shrink-0">
        <ThemeToggle />
      </span>
    </div>
  );
}
