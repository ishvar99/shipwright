/**
 * Which recorded files ground a lite-mode answer.
 *
 * Lite mode runs when the backend is unreachable, so there is no index and no retrieval —
 * the recorded demo workspace is the only code we can hand the model. Free-tier APIs meter
 * tokens hard, so this picks the few files the question actually names and truncates rather
 * than ships 88KB of application.py wholesale. Pure, so the choice is testable.
 */

export type LiteFile = { path: string; content: string };

const MAX_TOTAL = 24_000;
const MAX_PER_FILE = 12_000;
const MIN_USEFUL = 2_000;

/** Words worth matching on: identifiers and words of 3+ chars, lowercased, deduped. */
export function issueTerms(issue: string): string[] {
  return [...new Set(issue.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) ?? [])];
}

export function pickLiteContext(
  files: LiteFile[],
  issue: string,
  caps: { maxTotal?: number; maxPerFile?: number } = {},
): LiteFile[] {
  const maxTotal = caps.maxTotal ?? MAX_TOTAL;
  const maxPerFile = caps.maxPerFile ?? MAX_PER_FILE;
  const terms = issueTerms(issue);
  if (!terms.length) return [];

  const scored = files
    .map((f) => {
      const hay = f.content.toLowerCase();
      const path = f.path.toLowerCase();
      let score = 0;
      for (const t of terms) {
        // Presence matters more than frequency: cap per-term contribution so one repeated
        // word cannot outvote a file that matches the whole question.
        let hits = 0;
        for (let i = hay.indexOf(t); i !== -1 && hits < 5; i = hay.indexOf(t, i + t.length)) {
          hits += 1;
        }
        score += hits;
        if (path.includes(t)) score += 3;
      }
      return { f, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const out: LiteFile[] = [];
  let budget = maxTotal;
  for (const { f } of scored) {
    // Guard the SECOND file onward: too little budget left makes a useless fragment. The
    // top-ranked file always goes, truncated — returning nothing because the cap is tight
    // would silently drop the one file the question was about.
    if (out.length && budget < MIN_USEFUL) break;
    const room = Math.min(maxPerFile, budget);
    const content =
      f.content.length <= room ? f.content : `${f.content.slice(0, room)}\n… (truncated)`;
    out.push({ path: f.path, content });
    budget -= content.length;
  }
  return out;
}
