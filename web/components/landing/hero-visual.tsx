"use client";

import dynamic from "next/dynamic";

/** three.js stays out of the shared bundle: loaded client-side, landing chunk only. */
const HeroGraph = dynamic(() => import("@/components/landing/hero-graph"), { ssr: false });

export function HeroVisual() {
  return <HeroGraph />;
}
