import { describe, expect, it } from "vitest";
import { rankDelta } from "@/lib/results/rank";

describe("rankDelta", () => {
  it("reports upward movement when the final index is smaller", () => {
    expect(rankDelta(5, 2)).toEqual({ direction: "up", magnitude: 3 });
  });

  it("reports downward movement when the final index is larger", () => {
    expect(rankDelta(1, 8)).toEqual({ direction: "down", magnitude: 7 });
  });

  it("reports no movement when indices match", () => {
    expect(rankDelta(4, 4)).toEqual({ direction: "none", magnitude: 0 });
  });

  it("reports 'new' when the symbol was absent from retrieval order", () => {
    expect(rankDelta(-1, 3)).toEqual({ direction: "new", magnitude: 0 });
  });

  it("always reports magnitude as a positive number", () => {
    expect(rankDelta(9, 0).magnitude).toBe(9);
    expect(rankDelta(0, 9).magnitude).toBe(9);
  });
});
