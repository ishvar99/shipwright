"use client";

import { useTheme } from "next-themes";
import { Icon } from "@/components/ui/icon";

/** The label is chosen by CSS, not by state: next-themes sets `.dark` on <html> in a
 * blocking script, so the correct word is right on first paint with no mount gate.
 * `resolvedTheme` is only read inside the handler, which cannot run before hydration.
 * Styled as a sidebar row, not a form button — it lives in the nav and should speak its
 * grammar. */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  return (
    <button
      type="button"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      className="sw-side-item"
    >
      <span className="dark:hidden">
        <Icon name="moon" size={16} className="shrink-0" />
      </span>
      <span className="hidden dark:inline">
        <Icon name="sun" size={16} className="shrink-0" />
      </span>
      <span className="sr-only">Switch to </span>
      <span className="sw-rail-hide dark:hidden">Dark mode</span>
      <span className="sw-rail-hide hidden dark:inline">Light mode</span>
    </button>
  );
}
