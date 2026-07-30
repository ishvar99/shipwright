"use client";

import { useEffect, useRef } from "react";
import { BOUNDS, paneWidthPct, setPaneWidthPct, type Side } from "@/lib/ui-prefs";

const STEP = 2;
const BIG_STEP = 6;

type Props = { side: Side; controls: string; label: string };

/**
 * WAI-ARIA Window Splitter. `role="separator"` with `tabIndex=0` — not a button, which is not a
 * range role and so cannot legally carry `aria-valuenow`.
 *
 * Writes one custom property on <html> and updates `aria-valuenow` imperatively, so a drag
 * causes zero React renders.
 */
export function Splitter({ side, controls, label }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const { min, max, def } = BOUNDS[side];

  // Moving the separator right widens the left pane but narrows the right one.
  const sign = side === "left" ? 1 : -1;

  const apply = (pct: number) => {
    const next = setPaneWidthPct(side, pct);
    ref.current?.setAttribute("aria-valuenow", String(Math.round(next)));
  };

  // The restored value comes from the boot script, which React never saw.
  useEffect(() => {
    ref.current?.setAttribute("aria-valuenow", String(Math.round(paneWidthPct(side))));
  }, [side]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? BIG_STEP : STEP;
    const now = paneWidthPct(side);
    switch (e.key) {
      case "ArrowLeft":
        apply(now - sign * step);
        break;
      case "ArrowRight":
        apply(now + sign * step);
        break;
      case "Home":
        apply(min);
        break;
      case "End":
        apply(max);
        break;
      case "Enter":
        // One keystroke out of the way, and back. There is no collapse-to-zero, so this can
        // never strand a keyboard user in a pane they cannot reopen.
        apply(now <= min + 0.5 ? def : min);
        break;
      default:
        return; // let Tab, Escape and browser shortcuts through
    }
    e.preventDefault();
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.isPrimary || e.button !== 0) return;
    const row = ref.current?.parentElement;
    if (!row) return;

    // Measured once: no move handler touches layout.
    const rowWidth = row.getBoundingClientRect().width;
    const startX = e.clientX;
    const startPct = paneWidthPct(side);
    const rtl = getComputedStyle(row).direction === "rtl";
    const dir = sign * (rtl ? -1 : 1);

    // Capture, so a fast drag that leaves the 8px track does not strand the gesture.
    ref.current?.setPointerCapture(e.pointerId);
    ref.current?.focus({ preventScroll: true });
    document.documentElement.dataset.swResizing = "";

    const onMove = (ev: PointerEvent) => {
      apply(startPct + (dir * ((ev.clientX - startX) / rowWidth) * 100));
    };
    const onDone = () => {
      ref.current?.removeEventListener("pointermove", onMove);
      ref.current?.removeEventListener("lostpointercapture", onDone);
      delete document.documentElement.dataset.swResizing;
    };
    // lostpointercapture fires after pointerup, after pointercancel, and on node removal.
    ref.current?.addEventListener("pointermove", onMove);
    ref.current?.addEventListener("lostpointercapture", onDone);
  };

  return (
    <div
      ref={ref}
      role="separator"
      tabIndex={0}
      // The role's implicit orientation is horizontal; the arrows that move it are left/right.
      aria-orientation="vertical"
      aria-controls={controls}
      aria-label={`Resize ${label} pane`}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={def}
      className="workspace-sep"
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
    />
  );
}
