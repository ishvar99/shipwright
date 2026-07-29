"use client";

import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";

/** The label is chosen by CSS, not by state: next-themes sets `.dark` on <html> in a
 * blocking script, so the correct word is right on first paint with no mount gate.
 * `resolvedTheme` is only read inside the handler, which cannot run before hydration. */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  return (
    <Button onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}>
      <span className="sr-only">Switch to </span>
      <span className="dark:hidden">Dark</span>
      <span className="hidden dark:inline">Light</span>
    </Button>
  );
}
