import type { Finding, ReviewCoverage } from "@/lib/contracts";
import type { DiffLine } from "@/lib/results/diff";

/**
 * Severity is an OUTCOME, so it reuses the outcome palette and nothing else. The four
 * --evidence-* hues mean retrieval channels and must never carry state (DESIGN.md).
 */
export function severityTone(severity: Finding["severity"]): string {
  if (severity === "high") return "bg-danger-soft text-danger";
  if (severity === "medium") return "bg-warn-soft text-warn";
  return "bg-soft text-subtle";
}

/**
 * Claims only what the analysis knows. Same rule as `matchTier` in lib/results/rank.ts:
 * the score is a heuristic, not a probability, and the wording must not promote it to one.
 */
export function severityLabel(severity: Finding["severity"]): string {
  if (severity === "high") return "Likely bug";
  if (severity === "medium") return "Worth checking";
  return "Minor";
}

export function categoryLabel(category: Finding["category"]): string {
  return category.replace(/_/g, " ");
}

/** What was and was not reviewed, as one sentence. Silence has to be evidence, not absence. */
export function coverageSentence(coverage: ReviewCoverage): string {
  const parts = [`Reviewed ${coverage.reviewed} of ${coverage.files} changed files.`];
  if (coverage.unreviewed.length) {
    const shown = coverage.unreviewed.slice(0, 3).join(", ");
    const rest = coverage.unreviewed.length - 3;
    parts.push(`Not reviewed: ${shown}${rest > 0 ? ` and ${rest} more` : ""}.`);
  }
  if (coverage.degraded.length) {
    parts.push(`These checks did not complete: ${[...coverage.degraded].sort().join(", ")}.`);
  }
  if (coverage.tier === "window") {
    parts.push("No call graph for this language, so findings are scoped to the changed files.");
  } else if (coverage.tier === "none") {
    parts.push("Static checks only — no model review ran.");
  }
  return parts.join(" ");
}

export type TriageState = { state: "kept" | "dismissed"; reason: string };
export type TriageMap = Record<string, TriageState>;

/** The four reasons the endpoint's regex accepts. Order is the triage menu's order. */
export const DISMISS_REASONS: Record<string, string> = {
  not_real: "Not a real issue",
  not_worth_posting: "True, but not worth posting",
  duplicate: "Duplicate of another finding",
  pre_existing: "Pre-existing, not this PR",
};

/** The triage identity: the same path:line:category string render.py's finding_key builds. */
export function findingKey(f: Pick<Finding, "path" | "line" | "category">): string {
  return `${f.path}:${f.line}:${f.category}`;
}

/** The stored hunk is prefixed diff lines under an @@ header. Mapped onto DiffLine so the
 * card renders through the same sw-diff classes FixCard already uses. */
export function hunkLines(hunk: string): DiffLine[] {
  if (!hunk) return [];
  return hunk
    .split("\n")
    .filter((l) => !l.startsWith("@@"))
    .map((l) =>
      l.startsWith("+")
        ? { kind: "add" as const, text: l.slice(1) }
        : l.startsWith("-")
          ? { kind: "del" as const, text: l.slice(1) }
          : { kind: "ctx" as const, text: l.startsWith(" ") ? l.slice(1) : l },
    );
}

export function keptCount(triage: TriageMap): number {
  return Object.values(triage).filter((t) => t.state === "kept").length;
}

/** "Keep all" means "finish the undecided ones", not "discard my triage" — an existing keep
 * or dismissal is a decision the user already made, so it wins over the fill. */
export function fillUndecided(keys: string[], triage: TriageMap): TriageMap {
  return {
    ...Object.fromEntries(keys.map((k) => [k, { state: "kept" as const, reason: "" }])),
    ...triage,
  };
}

/**
 * May the composer offer to review this pull-request reference?
 *
 * Only when the reference names the repository that is actually open. `resolveIssueRef`
 * resolves cross-repo references — `owner/name#12` and a full GitHub URL both name a
 * repository that may not be the open one — while `POST /api/reviews` can only ever target
 * the open repo. Offering on a mismatch would review a DIFFERENT pull request that happens
 * to share the number.
 */
export function offerTargetsOpenRepo(
  ref: { owner: string; name: string } | null,
  repo: { source: string; slug: string } | null,
): boolean {
  if (!ref || repo?.source !== "github") return false;
  return repo.slug === `${ref.owner}/${ref.name}`;
}

/**
 * The one line every review leaves behind: what was checked, what the human decided, and —
 * once posted — the link back to GitHub. Deliberately makes no claim about what happens to
 * the code or any model's training data afterward: the hosted deploy's model tier differs
 * from a local run, so a sometimes-true posture sentence would be worse than none at all.
 */
export function receiptMarkdown(r: {
  title: string;
  number: number;
  headSha: string;
  coverage: ReviewCoverage;
  findings: number;
  kept: number;
  dismissed: Record<string, number>;
  reviewUrl: string;
}): string {
  const dismissedTotal = Object.values(r.dismissed).reduce((a, b) => a + b, 0);
  const reasons = Object.entries(r.dismissed)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${(DISMISS_REASONS[k] ?? k).toLowerCase()}`)
    .join(", ");
  const undecided = r.findings - r.kept - dismissedTotal;
  const parts = [
    `Reviewed **#${r.number} ${r.title}** at \`${r.headSha.slice(0, 7)}\``,
    `${r.coverage.reviewed} of ${r.coverage.files} changed files`,
    // Never a bare "checks run:" — a row written before coverage.checks existed has none,
    // and this is the one surface whose whole value is that every word on it is true.
    r.coverage.checks.length
      ? `checks run: ${r.coverage.checks.join(", ")}`
      : "checks run: not recorded",
    // Undecided is named rather than dropped: the arrow reads as a partition, and
    // "8 findings → 3 kept, 0 dismissed" would leave five unaccounted for.
    `${r.findings} findings → ${r.kept} kept, ${dismissedTotal} dismissed${
      reasons ? ` (${reasons})` : ""
    }${undecided > 0 ? `, ${undecided} undecided` : ""}`,
  ];
  if (r.reviewUrl) parts.push(`posted to GitHub as [review](${r.reviewUrl})`);
  return parts.join(" · ");
}
