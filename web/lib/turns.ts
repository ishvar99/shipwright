/**
 * Multi-turn plumbing shared by the browser engine and the answering route. Pure, so the
 * budget rules — what history the free-tier model actually sees — are pinned by tests.
 */

export type Turn = { q: string; a: string };

/** The last few turns, sizes capped. Oldest turns go first (they matter least), whole-turn:
 * a truncated question invites the model to invent the missing half. Answers are clipped —
 * their tail is usually restatement — and the code excerpts are never traded for history. */
export const MAX_TURNS = 4;
const MAX_Q_CHARS = 600;
const MAX_A_CHARS = 2_000;

export function capHistory(turns: readonly Turn[]): Turn[] {
  return turns.slice(-MAX_TURNS).map((t) => ({
    q: t.q.slice(0, MAX_Q_CHARS),
    a: t.a.length > MAX_A_CHARS ? `${t.a.slice(0, MAX_A_CHARS)}…` : t.a,
  }));
}

/** What the follow-up searches for. A follow-up leans on its antecedent ("how is that
 * validated?" carries no searchable nouns), so the previous question rides along — clipped,
 * so a long first question cannot drown the new one in BM25. */
export function retrievalQuery(issue: string, priorIssue?: string): string {
  if (!priorIssue) return issue;
  return `${issue} ${priorIssue.slice(0, 160)}`;
}
