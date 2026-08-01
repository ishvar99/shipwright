"use client";

import Link from "next/link";
import { useState } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { checklist, checklistComplete, nextStep, type ChecklistState } from "@/lib/checklist";
import { readChecklistDone, setChecklistDone } from "@/lib/ui-prefs";

/** Three steps, the first already done, dismissible for good. It disappears on its own once
 * every step is complete, so it is never a permanent row of ticks. */
export function FirstRun(state: ChecklistState) {
  const [dismissed, setDismissed] = useState(false);
  const [read, setRead] = useState(false);
  // Read during render, as elsewhere in the shell: nothing here is prerendered differently,
  // because a dismissed checklist renders nothing at all on both passes.
  if (!read && typeof document !== "undefined") {
    setRead(true);
    if (readChecklistDone()) setDismissed(true);
  }

  const items = checklist(state);
  if (dismissed || checklistComplete(items)) return null;
  const next = nextStep(items);

  return (
    <section className="sw-card sw-firstrun" aria-labelledby="firstrun-heading">
      <div className="flex items-start justify-between gap-3">
        <h2 id="firstrun-heading" className="text-subhead font-semibold text-fg">
          Getting started
        </h2>
        <button
          type="button"
          onClick={() => {
            setDismissed(true);
            setChecklistDone();
          }}
          className="sw-quiet-button"
        >
          Dismiss
        </button>
      </div>
      <ol className="sw-firstrun-list">
        {items.map((item) => (
          <li key={item.id} className={cn("sw-firstrun-item", item.done && "is-done")}>
            <span aria-hidden className="sw-firstrun-mark">
              {item.done && <Icon name="check" size={12} />}
            </span>
            {item.done ? (
              <span>{item.label}</span>
            ) : (
              <Link href={item.href} className="sw-firstrun-link">
                {item.label}
                {item.id === next?.id && <Icon name="chevron" size={12} />}
              </Link>
            )}
            <span className="sr-only">{item.done ? "done" : "not done"}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
