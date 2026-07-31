import { describe, expect, it } from "vitest";
import fixture from "@/fixtures/msal-extract-rerank.json";
import { LocationSchema, type Location } from "@/lib/contracts";
import { basisFor, matchTier, ordering, qualifiedName, rankDelta, topScore } from "@/lib/results/rank";

const LOCATIONS: Location[] = fixture.job.result.locations.map((l) => LocationSchema.parse(l));

/** Minimal row: only the fields the ranking logic reads. */
function loc(over: Partial<Location> & { symbol: string; rank: number }): Location {
  return LocationSchema.parse({
    path: "a.py",
    name: "x",
    kind: "function",
    start_line: 1,
    end_line: 2,
    score: 0.01,
    channels: ["bm25"],
    signature: "",
    ...over,
  });
}

describe("rankDelta", () => {
  it("reports movement toward rank 1 as up", () => {
    expect(rankDelta(7, 1)).toEqual({ direction: "up", magnitude: 6 });
  });

  it("reports movement away from rank 1 as down", () => {
    expect(rankDelta(1, 6)).toEqual({ direction: "down", magnitude: 5 });
  });

  it("reports an unchanged position", () => {
    expect(rankDelta(4, 4)).toEqual({ direction: "none", magnitude: 0 });
  });

  // "added by reranking" is unreachable: _rerank only reorders and appends candidates it was
  // given, so a row can never enter from nowhere. A missing base position IS reachable, and
  // must say so rather than fabricate movement.
  it("reports an unrecorded retrieval position as unknown, never as movement", () => {
    for (const missing of [0, -1, NaN, Infinity]) {
      expect(rankDelta(missing, 3)).toEqual({ direction: "unknown", magnitude: 0 });
    }
  });

  it("is invariant to the numbering base, since only the difference matters", () => {
    expect(rankDelta(4, 2)).toEqual(rankDelta(3, 1));
  });
});

describe("basisFor", () => {
  const withBase = [
    loc({ symbol: "a", rank: 1, base_rank: 2 }),
    loc({ symbol: "b", rank: 2, base_rank: 1 }),
  ];
  const withoutBase = [loc({ symbol: "a", rank: 1 }), loc({ symbol: "b", rank: 2 })];

  it("is measured when every row carries a retrieval position", () => {
    expect(basisFor("extract_rerank", withBase)).toBe("measured");
  });

  it("falls back to relative when the position is missing", () => {
    expect(basisFor("extract_rerank", withoutBase)).toBe("relative");
  });

  // `extract` runs a model and emits model.selected, but never reranks.
  it("is identity for modes that do not rerank", () => {
    expect(basisFor("extract", withBase)).toBe("identity");
    expect(basisFor("hybrid", withBase)).toBe("identity");
    expect(basisFor("bm25", withBase)).toBe("identity");
  });

  it("is identity when there is nothing to compare", () => {
    expect(basisFor("extract_rerank", withBase.slice(0, 1))).toBe("identity");
  });
});

describe("ordering", () => {
  it("prefers the recorded retrieval position over the score ordering", () => {
    // Score order would be c, b, a; base_rank says a, b, c. base_rank must win.
    const rows = [
      loc({ symbol: "a", rank: 1, base_rank: 1, score: 0.01 }),
      loc({ symbol: "b", rank: 2, base_rank: 2, score: 0.02 }),
      loc({ symbol: "c", rank: 3, base_rank: 3, score: 0.03 }),
    ];
    const o = ordering(rows, "extract_rerank");
    expect(o.basis).toBe("measured");
    expect(o.retrieval.map((l) => l.symbol)).toEqual(["a", "b", "c"]);
    expect(o.movedCount).toBe(0);
  });

  it("is total: shuffling the input does not change the derived positions", () => {
    const a = ordering(LOCATIONS, fixture.job.mode);
    const b = ordering([...LOCATIONS].reverse(), fixture.job.mode);
    expect([...b.basePosition].sort()).toEqual([...a.basePosition].sort());
    expect(b.retrieval.map((l) => l.symbol)).toEqual(a.retrieval.map((l) => l.symbol));
  });

  it("leaves retrieval order equal to result order when nothing reranked", () => {
    const rows = [loc({ symbol: "a", rank: 1 }), loc({ symbol: "b", rank: 2 })];
    const o = ordering(rows, "hybrid");
    expect(o.retrieval).toEqual(o.reranked);
    expect(o.movedCount).toBe(0);
  });

  function displacement(o: ReturnType<typeof ordering>) {
    let up = 0;
    let down = 0;
    for (const l of o.reranked) {
      const d = rankDelta(o.basePosition.get(l.symbol) ?? 0, l.rank);
      if (d.direction === "up") up += d.magnitude;
      if (d.direction === "down") down += d.magnitude;
    }
    return { up, down };
  }

  // The whole reason the backend records base_rank. Reconstructing from the visible rows is a
  // permutation of a fixed set, so displacement cancels exactly: it can show churn, never gain.
  it("reconstruction can only ever show churn — sum(up) equals sum(down)", () => {
    const stripped = LOCATIONS.map((l) => loc({ ...l, base_rank: undefined }));
    const o = ordering(stripped, "extract_rerank");
    expect(o.basis).toBe("relative");
    const { up, down } = displacement(o);
    expect(up).toBe(down);
  });

  it("the measured basis does show net gain on the real capture", () => {
    const o = ordering(LOCATIONS, fixture.job.mode);
    expect(o.basis).toBe("measured");
    const { up, down } = displacement(o);
    expect(up).not.toBe(down);
    // A promotion from beyond the ten shown, which reconstruction could not have surfaced.
    expect(Math.max(...LOCATIONS.map((l) => l.base_rank ?? 0))).toBeGreaterThan(LOCATIONS.length);
  });
});

describe("topScore", () => {
  it("is the maximum score in the set", () => {
    expect(topScore(LOCATIONS)).toBe(Math.max(...LOCATIONS.map((l) => l.score)));
  });

  it("keeps every bar within range, unlike normalising to the first row", () => {
    const top = topScore(LOCATIONS);
    expect(LOCATIONS.every((l) => l.score / top <= 1)).toBe(true);
    // On any reranked capture the top-ranked row is not the strongest retrieval score, so the
    // first-row denominator produces ratios above 1 that clamp to full width — the reranker's
    // override rendering as identical bars. Asserted as a property, not a row count, because
    // the count is a fact about one capture.
    expect(topScore(LOCATIONS)).toBeGreaterThan(LOCATIONS[0].score);
    expect(LOCATIONS.some((l) => l.score / LOCATIONS[0].score > 1)).toBe(true);
  });

  it("does not divide by zero on an empty set", () => {
    expect(topScore([])).toBe(0);
  });
});

describe("qualifiedName", () => {
  it("keeps the class prefix that `name` alone drops", () => {
    const l = loc({ symbol: "msal/authority.py:Authority.__init__", name: "__init__", rank: 1 });
    expect(qualifiedName(l)).toBe("Authority.__init__");
  });

  it("survives a symbol containing further colons", () => {
    const l = loc({ symbol: "a/b.py:Outer:inner", name: "inner", rank: 1 });
    expect(qualifiedName(l)).toBe("Outer:inner");
  });

  it("falls back to the bare name when there is no path prefix", () => {
    expect(qualifiedName(loc({ symbol: "lonely", name: "lonely", rank: 1 }))).toBe("lonely");
  });
});

describe("matchTier", () => {
  it("splits at two thirds and one third of the strongest score", () => {
    expect(matchTier(0.9, 1).tier).toBe("strong");
    expect(matchTier(0.5, 1).tier).toBe("good");
    expect(matchTier(0.2, 1).tier).toBe("possible");
    expect(matchTier(1, 0).tier).toBe("possible");
  });

  it('says "match", never a probability word — the score is a rank, not a confidence', () => {
    for (const label of [matchTier(0.9, 1).label, matchTier(0.5, 1).label, matchTier(0.1, 1).label]) {
      expect(label).toMatch(/match$/);
      expect(label.toLowerCase()).not.toMatch(/confiden|probab|%/);
    }
  });
});
