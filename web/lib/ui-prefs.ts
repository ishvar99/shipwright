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

/** LEFT is the file tree on the editor route; RIGHT is the session code pane. They live on
 * different routes, so their bounds are independent. RIGHT defaults to 60: when the pane is
 * open, reading code is the task, and the results column reads fine at 40. Both are mirrored
 * in `clamp()`s in globals.css — keep them in step. */
export const LEFT = { min: 14, max: 26, def: 20 } as const;
export const RIGHT = { min: 30, max: 70, def: 60 } as const;

export type TraceState = "open" | "collapsed";
/** "auto" collapses to the rail when the surface needs the width — the editor route, or a
 * session with its code pane open. The other two always win. */
export type SidebarState = "auto" | "expanded" | "rail";
/** Beyond the furniture: what the user was actually doing. Splitter widths survived a reload
 * and the half-written issue did not, which is the wrong way round. */
export type Prefs = {
  left: number;
  right: number;
  trace: TraceState;
  sidebar: SidebarState;
  /** Last repository worked in, so /app opens where you left off. */
  repo: string;
  /** One unsent issue, tagged with the repository it was written for. */
  draft: { repo: string; text: string };
  /** First-run checklist dismissed by hand. */
  checklistDone: boolean;
};

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

/** Reads the stored preference, not the rendered state. `data-sidebar` is only the CSS switch:
 * the frame always writes a concrete value there, so it can never report "auto". */
export function readStoredSidebarPref(): SidebarState {
  const v = read().sidebar;
  return v === "rail" || v === "expanded" ? v : "auto";
}

export function setSidebarState(state: SidebarState): void {
  if (state === "auto") delete document.documentElement.dataset.sidebar;
  else document.documentElement.dataset.sidebar = state;
  savePrefs({ sidebar: state });
}

export function readLastRepo(): string {
  const v = read().repo;
  return typeof v === "string" ? v : "";
}

export function setLastRepo(repoId: string): void {
  savePrefs({ repo: repoId });
}

/** Tagged with its repository: restoring an issue written about one project into the composer
 * of another would be worse than losing it. */
export function readDraft(repoId: string): string {
  const d = read().draft;
  return d && d.repo === repoId && typeof d.text === "string" ? d.text : "";
}

export function setDraft(repoId: string, text: string): void {
  savePrefs({ draft: { repo: repoId, text } });
}

export function readChecklistDone(): boolean {
  return read().checklistDone === true;
}

export function setChecklistDone(): void {
  savePrefs({ checklistDone: true });
}
