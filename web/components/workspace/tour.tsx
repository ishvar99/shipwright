"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { TOUR_STEPS, tourStep, type TourFacts } from "@/lib/tour";

/** Each step stays up at least this long — the replay's early stages land seconds apart,
 * and a narrator that flashes past its own first line reads as broken. */
const DWELL_MS = 4000;

/** Walks the shown step toward the earned one, one dwell at a time. State, not derivation:
 * the earned step can jump (terminal earns the last step while the fix one is still up),
 * and every step in between deserves its moment. */
export function useTourStep(facts: TourFacts): number {
  const earned = tourStep(facts);
  const [shown, setShown] = useState(0);
  // Written in effects only: reading the clock during render is impure, and the mount
  // effect below runs before the advance effect by declaration order.
  const shownAt = useRef(0);

  useEffect(() => {
    shownAt.current = Date.now();
  }, []);

  useEffect(() => {
    if (shown >= earned) return;
    const wait = Math.max(0, DWELL_MS - (Date.now() - shownAt.current));
    const t = setTimeout(() => {
      shownAt.current = Date.now();
      setShown((s) => Math.min(s + 1, earned));
    }, wait);
    return () => clearTimeout(t);
  }, [earned, shown]);

  return shown;
}

/** The narrator card for the guided replay. Fixed at the bottom like a caption bar — it
 * describes the page, so it must never sit on top of the thing it points at. */
export function Tour({ step, onDismiss }: { step: number; onDismiss: () => void }) {
  const s = TOUR_STEPS[step] ?? TOUR_STEPS[0];
  const closing = s.target === null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // defaultPrevented: an Escape the code pane or a popover already consumed closes that
      // surface, not the tour — otherwise closing the pane mid-tour silently ended it too.
      if (e.key === "Escape" && !e.defaultPrevented) onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  return (
    <div className="sw-tour-card" role="status" aria-live="polite">
      <p className="sw-tour-step">
        {/* Dots, not "2 of 4": progress you can see coming beats progress you have to parse. */}
        <span className="sw-tour-dots" aria-label={`Step ${step + 1} of ${TOUR_STEPS.length}`}>
          {TOUR_STEPS.map((_, i) => (
            <span key={i} aria-hidden data-done={i <= step || undefined} />
          ))}
        </span>
      </p>
      {/* Keyed by step so each one enters with its own beat instead of snapping in place. */}
      <div key={step} className="sw-tour-swap grid gap-1">
        <p className="sw-tour-title">{s.title}</p>
        <p className="sw-tour-body">{s.body}</p>
      </div>
      <div className="sw-tour-actions">
        {closing ? (
          <>
            <Link href="/app/repos" className="sw-primary-link">
              Import your repository
            </Link>
            <button type="button" onClick={onDismiss} className="sw-tour-skip">
              or keep exploring this session
            </button>
          </>
        ) : (
          <button type="button" onClick={onDismiss} className="sw-tour-skip">
            Skip the tour
          </button>
        )}
      </div>
    </div>
  );
}
