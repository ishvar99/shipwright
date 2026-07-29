import { describe, expect, it } from "vitest";
import { bandPp, isWithinBand, resolutionPp } from "@/lib/evals/band";

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
