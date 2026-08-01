/**
 * Pane geometry lives in the DOM, not in React: two custom properties on <html> that CSS reads
 * directly. Nothing subscribes, so a drag re-renders nothing.
 *
 * Sizes are PERCENTAGES, not pixels. That is the load-bearing choice — a percentage is
 * scale-free, so no stored value can overflow at any viewport width, which removes the
 * re-clamp-on-resize pass and keeps the stored number, the rendered width and `aria-valuenow`
 * the same integer.
 */

export const PREFS_KEY = "sw.shell.v1";

/** Maxima sum to 62%, so the centre pane keeps a usable width by arithmetic, not measurement.
 * These bounds are mirrored in the `clamp()` in globals.css — keep them in step. */
export const LEFT = { min: 14, max: 26, def: 20 } as const;
export const RIGHT = { min: 24, max: 36, def: 32 } as const;

export type TraceState = "open" | "collapsed";
/** "auto" collapses to the rail only on the editor route; the other two always win. */
export type SidebarState = "auto" | "expanded" | "rail";
export type Prefs = { left: number; right: number; trace: TraceState; sidebar: SidebarState };

export type Side = "left" | "right";
export type Bounds = { readonly min: number; readonly max: number; readonly def: number };
export const BOUNDS: Record<Side, Bounds> = { left: LEFT, right: RIGHT };

export function clampPct(value: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

/**
 * Runs before first paint so restored sizes are in the very first layout — the same trick
 * next-themes already uses here for the theme class. A literal string rather than
 * `fn.toString()`, which a minifier is free to rewrite.
 *
 * Clamping inside the script is not decorative: an unclamped `NaN%` makes the track invalid and
 * `grid-template-columns` silently falls back to min-content.
 */
// Two separate try blocks: a corrupt value must still leave the properties set to defaults,
// rather than skipping the writes and relying on the var() fallback to cover it.
export const UI_PREFS_BOOT = `(function(){var p={};try{p=JSON.parse(localStorage.getItem("${PREFS_KEY}")||"{}")||{}}catch(_){}try{var e=document.documentElement,c=function(v,lo,hi,d){v=Number(v);return isFinite(v)?Math.min(hi,Math.max(lo,v)):d};e.style.setProperty("--sw-left",c(p.left,${LEFT.min},${LEFT.max},${LEFT.def})+"%");e.style.setProperty("--sw-right",c(p.right,${RIGHT.min},${RIGHT.max},${RIGHT.def})+"%");if(p.trace==="collapsed"){e.dataset.trace="collapsed"}if(p.sidebar==="rail"||p.sidebar==="expanded"){e.dataset.sidebar=p.sidebar}}catch(_){}})()`;

function read(): Partial<Prefs> {
  try {
    // Access itself throws when site data is blocked, so the read is inside the try too.
    // `?? {}` guards a stored literal `null`, which JSON.parse returns as null.
    return (JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs> | null) ?? {};
  } catch {
    return {};
  }
}

let pending: Partial<Prefs> = {};
let timer: ReturnType<typeof setTimeout> | null = null;

/** Read-modify-write behind a trailing timer. Merging is required: otherwise the splitter
 * erases `trace` and vice versa, a loss only visible after a reload. */
export function savePrefs(patch: Partial<Prefs>): void {
  pending = { ...pending, ...patch };
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    const merged = { ...read(), ...pending };
    pending = {};
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(merged));
    } catch {
      // Private mode or blocked storage: sizes just do not persist.
    }
  }, 150);
}

export function paneWidthPct(side: Side): number {
  const { min, max, def } = BOUNDS[side];
  const raw = getComputedStyle(document.documentElement).getPropertyValue(`--sw-${side}`);
  return clampPct(parseFloat(raw), min, max, def);
}

export function setPaneWidthPct(side: Side, pct: number): number {
  const { min, max, def } = BOUNDS[side];
  const next = clampPct(pct, min, max, def);
  document.documentElement.style.setProperty(`--sw-${side}`, `${next}%`);
  savePrefs({ [side]: next });
  return next;
}

/** The boot script does not run on a client-side navigation from `/`, so the shell re-applies
 * on mount. Idempotent by construction. */
export function applyStoredPrefs(): void {
  const p = read();
  const root = document.documentElement;
  root.style.setProperty("--sw-left", `${clampPct(p.left, LEFT.min, LEFT.max, LEFT.def)}%`);
  root.style.setProperty("--sw-right", `${clampPct(p.right, RIGHT.min, RIGHT.max, RIGHT.def)}%`);
  if (p.trace === "collapsed") root.dataset.trace = "collapsed";
  else delete root.dataset.trace;
  if (p.sidebar === "rail" || p.sidebar === "expanded") root.dataset.sidebar = p.sidebar;
  else delete root.dataset.sidebar;
}

export function setTraceState(state: TraceState): void {
  if (state === "collapsed") document.documentElement.dataset.trace = "collapsed";
  else delete document.documentElement.dataset.trace;
  savePrefs({ trace: state });
}

export function readTraceState(): TraceState {
  return document.documentElement.dataset.trace === "collapsed" ? "collapsed" : "open";
}

export function readSidebarState(): SidebarState {
  const v = document.documentElement.dataset.sidebar;
  return v === "rail" || v === "expanded" ? v : "auto";
}

export function setSidebarState(state: SidebarState): void {
  if (state === "auto") delete document.documentElement.dataset.sidebar;
  else document.documentElement.dataset.sidebar = state;
  savePrefs({ sidebar: state });
}
