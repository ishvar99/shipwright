import type { Finding, ReviewCoverage } from "@/lib/contracts";

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
