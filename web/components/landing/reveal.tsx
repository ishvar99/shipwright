"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";

/**
 * Reveal on scroll. The hidden start state lives in CSS behind a
 * `prefers-reduced-motion: no-preference` query, so this component only ever flips an
 * attribute — nothing here can leave content invisible.
 */
export function Reveal({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        el.dataset.shown = "true";
        io.disconnect(); // reveal once; re-animating on scroll-back is noise
      },
      { rootMargin: "0px 0px -12% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} className={cn("sw-reveal", className)}>
      {children}
    </div>
  );
}
