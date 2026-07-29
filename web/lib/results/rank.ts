export type RankDirection = "up" | "down" | "none" | "new";

export type RankDeltaResult = {
  direction: RankDirection;
  magnitude: number;
};

/** Indices are 0-based positions; lower is a better rank. -1 means absent from retrieval. */
export function rankDelta(retrievalIndex: number, finalIndex: number): RankDeltaResult {
  if (retrievalIndex < 0) return { direction: "new", magnitude: 0 };
  if (retrievalIndex === finalIndex) return { direction: "none", magnitude: 0 };
  const magnitude = Math.abs(retrievalIndex - finalIndex);
  return { direction: finalIndex < retrievalIndex ? "up" : "down", magnitude };
}
