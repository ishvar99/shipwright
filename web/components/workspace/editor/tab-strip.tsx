"use client";

import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import type { Tab } from "@/lib/repo-tabs";

/** Preview tabs render italic and get reused by the next single click, so browsing the tree
 * never fills the strip. The dirty dot occupies the close button's slot and swaps on hover. */
export function TabStrip({
  tabs,
  active,
  onSelect,
  onClose,
}: {
  tabs: Tab[];
  active: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}) {
  if (!tabs.length) return null;
  return (
    <div className="sw-tabs" role="tablist" aria-label="Open files">
      {tabs.map((tab) => {
        const name = tab.path.split("/").pop() ?? tab.path;
        const selected = tab.path === active;
        return (
          <div
            key={tab.path}
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            title={tab.path}
            onClick={() => onSelect(tab.path)}
            onKeyDown={(e) => {
              // Only the tab itself: otherwise this swallows Enter on the close button.
              if (e.target !== e.currentTarget) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(tab.path);
              }
            }}
            onAuxClick={(e) => {
              if (e.button === 1) onClose(tab.path);
            }}
            className={cn("sw-tab", selected && "sw-tab-active", tab.preview && "italic")}
          >
            <span className="truncate">{name}</span>
            {/* The state is in the accessible name too: the dot alone is colour-only. */}
            <span className="sr-only">{tab.dirty ? "unsaved changes" : ""}</span>
            <button
              type="button"
              aria-label={tab.dirty ? `Close ${name} (unsaved)` : `Close ${name}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.path);
              }}
              className={cn("sw-tab-close", tab.dirty && "sw-tab-close-dirty")}
            >
              <Icon name="x" size={12} className="sw-tab-x" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
