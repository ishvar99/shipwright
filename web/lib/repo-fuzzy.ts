export type FuzzyMatch = { path: string; score: number; hits: number[] };

/**
 * Subsequence match over paths, ranked by how tight the match is. Consecutive characters and
 * matches inside the filename score highest, because that is what people actually type.
 */
export function fuzzyRank(query: string, paths: string[], limit = 50): FuzzyMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return paths.slice(0, limit).map((path) => ({ path, score: 0, hits: [] }));

  const out: FuzzyMatch[] = [];
  for (const path of paths) {
    const match = score(q, path);
    if (match) out.push(match);
  }
  // Ties broken by the shorter path: a match in a top-level file beats one nested six deep.
  out.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  return out.slice(0, limit);
}

function score(q: string, path: string): FuzzyMatch | null {
  const lower = path.toLowerCase();
  const slash = lower.lastIndexOf("/");
  const hits: number[] = [];
  let total = 0;
  let from = 0;
  let previous = -2;

  for (const char of q) {
    const at = lower.indexOf(char, from);
    if (at === -1) return null;
    hits.push(at);
    let points = 1;
    if (at === previous + 1) points += 4; // consecutive run
    if (at > slash) points += 3; // inside the filename, not the directory
    if (at === slash + 1) points += 4; // filename start
    total += points;
    previous = at;
    from = at + 1;
  }
  // Shorter spans are tighter matches: "abc" over 3 chars beats the same 3 over 30.
  const span = hits[hits.length - 1] - hits[0] + 1;
  return { path, score: total - span * 0.1, hits };
}
