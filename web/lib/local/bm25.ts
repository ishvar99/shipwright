/**
 * Sparse ranking for locally indexed repos: BM25 plus Reciprocal Rank Fusion, ported from
 * `codegraph/retrieve.py`. Same tokenizer, same constants, on purpose — a local repo has no
 * backend to ask, and its results sit next to benchmarked ones in the same UI, so they must
 * come from the same algorithm rather than something merely similar.
 */

/** Identifier-shaped, like the backend's TOKEN: underscores stay inside the word, so the whole
 * snake_case form survives as a term of its own alongside its parts. */
const WORD = /[A-Za-z_][A-Za-z0-9_]+/g;
const CAMEL = /([a-z0-9])(?=[A-Z])/g;

const K1 = 1.5;
const B = 0.75;
const RRF_K = 60;

/**
 * Emits each identifier *and* its parts, so a query saying `user` reaches `get_user_name`
 * while an exact hit on the full identifier still counts for more.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const word of text.match(WORD) ?? []) {
    out.push(word.toLowerCase());
    // Turning the camel boundary into an underscore lets one split cover both conventions.
    for (const part of word.replace(CAMEL, "$1_").split("_")) {
      if (part.length >= 2) out.push(part.toLowerCase());
    }
  }
  return out;
}

export type Doc = { id: string; text: string };

/**
 * BM25Okapi with the rank_bm25 defaults the backend relies on. Documents scoring zero are
 * dropped rather than tailed on: nothing matched, so their order would be arbitrary.
 */
export function bm25Rank(docs: Doc[], query: string, limit: number = docs.length): string[] {
  const terms = tokenize(query);
  if (docs.length === 0 || terms.length === 0) return [];

  const counts: Map<string, number>[] = [];
  const lengths: number[] = [];
  const df = new Map<string, number>();
  for (const doc of docs) {
    const tokens = tokenize(doc.text);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    counts.push(tf);
    lengths.push(tokens.length);
  }
  const avgdl = lengths.reduce((a, b) => a + b, 0) / docs.length;

  const idf = new Map<string, number>();
  for (const t of terms) {
    const n = df.get(t) ?? 0;
    idf.set(t, Math.log(1 + (docs.length - n + 0.5) / (n + 0.5)));
  }

  const scores = docs.map((_, i) => {
    const norm = K1 * (1 - B + (B * lengths[i]) / avgdl);
    let score = 0;
    // Repeats in `terms` count repeatedly, as rank_bm25 does: a term the issue keeps naming
    // weighs more.
    for (const t of terms) {
      const f = counts[i].get(t) ?? 0;
      if (f > 0) score += (idf.get(t) ?? 0) * ((f * (K1 + 1)) / (f + norm));
    }
    return score;
  });

  return docs
    .map((_, i) => i)
    .filter((i) => scores[i] > 0)
    .sort((a, b) => scores[b] - scores[a] || a - b)
    .slice(0, limit)
    .map((i) => docs[i].id);
}

/**
 * Fuses rankings by position, never by score: the channels are on incomparable scales, and
 * agreement between them is the signal worth rewarding.
 */
export function rrf(rankings: string[][], k: number = RRF_K): string[] {
  const fused = new Map<string, { score: number; best: number }>();
  for (const ranking of rankings) {
    for (let i = 0; i < ranking.length; i += 1) {
      const row = fused.get(ranking[i]);
      if (row) {
        row.score += 1 / (k + i);
        row.best = Math.min(row.best, i);
      } else {
        fused.set(ranking[i], { score: 1 / (k + i), best: i });
      }
    }
  }
  return [...fused]
    .sort(
      // Code-unit order last, not locale order: the result must not depend on the browser.
      ([aId, a], [bId, b]) => b.score - a.score || a.best - b.best || (aId < bId ? -1 : 1),
    )
    .map(([id]) => id);
}
