/**
 * The Shipwright mark: a scope ring with a hull curve through it — locating code, building
 * ships. One idea, two strokes, readable at 14px. Stroke-drawn like every other glyph so it
 * inherits currentColor and sits on any surface.
 */
export function Logo({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      className={className}
    >
      {/* The scope: an open ring, broken where the hull passes through. */}
      <path d="M5.5 14.7A7 7 0 1 1 18.5 14.7" />
      {/* The hull, riding the waterline. */}
      <path d="M3 14.5c2.6 3.4 6 5 9 5s6.4-1.6 9-5" />
      {/* The mast — also the crosshair's north. */}
      <path d="M12 2.4v5.1" />
      {/* The fix: where the change lives. */}
      <circle cx="12" cy="11.5" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Wordmark beside the mark, display face, tight — the product's name set like a name. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={className} style={{ fontFamily: "var(--font-display)", letterSpacing: "-0.02em" }}>
      Shipwright
    </span>
  );
}
