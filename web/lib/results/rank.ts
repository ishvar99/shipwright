import type { Location } from "@/lib/contracts";

export type RankDirection = "up" | "down" | "none" | "unknown";

export type RankDeltaResult = {
  direction: RankDirection;
  magnitude: number;
};

/**
 * Positions are 1-based ranks; lower is better. A non-positive base position means the
 * retrieval position was not recorded — that reports `unknown` rather than fabricating
 * movement, because "added by reranking" is unreachable: `_rerank` only ever reorders and
 * appends candidates it was given.
 */
export function rankDelta(basePosition: number, finalPosition: number): RankDeltaResult {
  if (!Number.isFinite(basePosition) || basePosition <= 0) {
    return { direction: "unknown", magnitude: 0 };
  }
  if (basePosition === finalPosition) return { direction: "none", magnitude: 0 };
  return {
    direction: finalPosition < basePosition ? "up" : "down",
    magnitude: Math.abs(basePosition - finalPosition),
  };
}

/**
 * Which retrieval order we can actually justify.
 *
 * - `measured`   every row carries `base_rank`, its position among all the candidates the
 *                model was shown. Movement is a real magnitude.
 * - `relative`   no `base_rank`, so retrieval order is reconstructed by sorting the rows we
 *                have. That is a permutation of a fixed set, so sum(up) === sum(down)
 *                identically: it can show churn but never net gain, and a row promoted from
 *                outside the visible set can even appear to move *down*. Must be labelled.
 * - `identity`   nothing was reranked, so retrieval order IS the result order.
 */
export type Basis = "measured" | "relative" | "identity";

const RERANKING_MODES = new Set(["rerank", "extract_rerank"]);

export function basisFor(mode: string, locations: readonly Location[]): Basis {
  // `extract` runs a model and emits model.selected, but never reranks.
  if (locations.length < 2 || !RERANKING_MODES.has(mode)) return "identity";
  return locations.every((l) => (l.base_rank ?? 0) > 0) ? "measured" : "relative";
}

export type Ordered = {
  basis: Basis;
  /** The rows in retrieval order. */
  retrieval: Location[];
  /** The rows in final (reranked) order. */
  reranked: Location[];
  /** Retrieval position per `symbol`, 1-based. */
  basePosition: Map<string, number>;
  /** How many rows sit at a different position in the two orders. */
  movedCount: number;
};

/**
 * Derives both orders and the base position of every row. Pure, and total: an input in any
 * order produces the same result, because the comparator never falls back to array position.
 */
export function ordering(locations: readonly Location[], mode: string): Ordered {
  const basis = basisFor(mode, locations);
  const reranked = [...locations].sort((a, b) => a.rank - b.rank);

  if (basis === "identity") {
    const basePosition = new Map(reranked.map((l) => [l.symbol, l.rank]));
    return { basis, retrieval: reranked, reranked, basePosition, movedCount: 0 };
  }

  const retrieval =
    basis === "measured"
      ? [...locations].sort((a, b) => (a.base_rank ?? 0) - (b.base_rank ?? 0))
      : // `score` is the retrieval score, carried through the rerank untouched. Ties break by
        // final rank so the comparator is total and shuffling the input changes nothing.
        [...locations].sort((a, b) => b.score - a.score || a.rank - b.rank);

  const basePosition = new Map(
    basis === "measured"
      ? locations.map((l) => [l.symbol, l.base_rank ?? 0])
      : retrieval.map((l, i) => [l.symbol, i + 1]),
  );

  let movedCount = 0;
  for (const l of reranked) {
    if (basePosition.get(l.symbol) !== l.rank) movedCount += 1;
  }
  return { basis, retrieval, reranked, basePosition, movedCount };
}

/**
 * The ScoreBar denominator. `max`, never `locations[0]`: `score` is the retrieval score and the
 * top-ranked row is usually not the highest-scoring one, so normalising to the first row clamps
 * several bars to full width and hides the very override the reranker performed.
 */
export function topScore(locations: readonly Location[]): number {
  return locations.reduce((m, l) => Math.max(m, l.score), 0);
}

/** "Authority.__init__" — `name` is only the bare identifier, so the class prefix lives in
 * `symbol` after the path. Splits once: a symbol may contain further colons. */
export function qualifiedName(location: Pick<Location, "symbol" | "name">): string {
  const cut = location.symbol.indexOf(":");
  const tail = cut === -1 ? "" : location.symbol.slice(cut + 1);
  return tail || location.name || location.symbol;
}
