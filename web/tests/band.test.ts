import { describe, expect, it } from "vitest";
import snapshot from "@/fixtures/analytics.json";
import { AnalyticsSchema } from "@/lib/contracts";
import { bandPp, isWithinBand, pairwiseN, resolutionPp } from "@/lib/evals/band";

describe("resolutionPp", () => {
  it("is one task expressed in percentage points", () => {
    expect(resolutionPp(100)).toBeCloseTo(1, 6);
    expect(resolutionPp(30)).toBeCloseTo(3.3333, 4);
    expect(resolutionPp(353)).toBeCloseTo(0.2833, 4);
  });

  it("returns Infinity for a zero or negative sample so callers cannot divide by zero", () => {
    expect(resolutionPp(0)).toBe(Infinity);
    expect(resolutionPp(-5)).toBe(Infinity);
  });
});

describe("bandPp", () => {
  it("defaults to two tasks, matching the observed run-to-run spread", () => {
    expect(bandPp(30)).toBeCloseTo(6.6667, 4);
    expect(bandPp(100)).toBeCloseTo(2, 6);
  });

  it("narrows as the sample grows", () => {
    expect(bandPp(353)).toBeLessThan(bandPp(100));
    expect(bandPp(100)).toBeLessThan(bandPp(30));
  });

  it("accepts an explicit task count", () => {
    expect(bandPp(100, 1)).toBeCloseTo(1, 6);
  });
});

describe("isWithinBand", () => {
  it("treats a two-point difference at n=100 as inconclusive", () => {
    expect(isWithinBand(2, 100)).toBe(true);
  });

  it("treats a ten-point difference at n=100 as a result", () => {
    expect(isWithinBand(10, 100)).toBe(false);
  });

  it("ignores the sign of the difference", () => {
    expect(isWithinBand(-2, 100)).toBe(true);
    expect(isWithinBand(-10, 100)).toBe(false);
  });

  it("treats everything as inconclusive when the sample is empty", () => {
    expect(isWithinBand(50, 0)).toBe(true);
  });
});

describe("pairwiseN", () => {
  it("takes the coarser of the two samples", () => {
    expect(pairwiseN(353, 30)).toBe(30);
    expect(pairwiseN(30, 353)).toBe(30);
    expect(pairwiseN(100, 100)).toBe(100);
  });

  // The direction that matters: borrowing the larger n would shrink the band and make a
  // difference look real when the coarser run cannot express it.
  it("never lets a large run lend its resolution to a small one", () => {
    const delta = 4;
    expect(isWithinBand(delta, 353)).toBe(false); // would read as a result
    expect(isWithinBand(delta, pairwiseN(353, 30))).toBe(true); // honestly inconclusive
  });
});

describe("the committed snapshot", () => {
  const runs = snapshot.runs;

  it("parses and carries a spread of sample sizes worth banding", () => {
    expect(() => AnalyticsSchema.parse(snapshot)).not.toThrow();
    expect(new Set(runs.map((r) => r.n)).size).toBeGreaterThan(2);
  });

  // The done-criterion, asserted rather than eyeballed.
  it("bands widen as the sample shrinks", () => {
    const sizes = [...new Set(runs.map((r) => r.n))].sort((a, b) => a - b);
    const widths = sizes.map((n) => bandPp(n));
    expect(widths).toEqual([...widths].sort((a, b) => b - a));
    const smallest = Math.min(...sizes);
    const largest = Math.max(...sizes);
    expect(bandPp(smallest)).toBeGreaterThan(bandPp(largest));
  });

  it("records the fine-tune's parse-failure result, which accuracy alone would hide", () => {
    const pool = runs.filter((r) => r.parse_failures > 0 && r.n === 100);
    const tuned = pool.find((r) => r.model === "Engine S (tuned)");
    const base = pool.find((r) => r.model === "Engine S");
    expect(tuned && base).toBeTruthy();
    expect(tuned!.parse_failures).toBeLessThan(base!.parse_failures);
    // ...while the accuracy difference between them sits inside the band.
    const delta = tuned!.file5 - base!.file5;
    expect(isWithinBand(delta, pairwiseN(tuned!.n, base!.n))).toBe(true);
  });
});
