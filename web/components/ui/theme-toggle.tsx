"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // Theme is unknown until hydration; render a stable placeholder to avoid a flash.
  useEffect(() => setMounted(true), []);
  if (!mounted) return <Button aria-hidden className="w-20 opacity-0" />;

  const next = resolvedTheme === "dark" ? "light" : "dark";
  return (
    <Button onClick={() => setTheme(next)} aria-label={`Switch to ${next} theme`}>
      {resolvedTheme === "dark" ? "Light" : "Dark"}
    </Button>
  );
}
