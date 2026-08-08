/**
 * The router's cheap half, ported from src/shipwright/intent.py so the browser pipeline is as
 * honest as the backend one.
 *
 * Without it the deployed path answered everything: "please fix it" came back as a confident,
 * grounded-looking paragraph about whatever five files BM25 happened to rank, because
 * `run.ts` declared `intent: "question"` unconditionally. The backend has always refused
 * these. Pure regex — no model call, no dependency, decided in microseconds.
 *
 * Kept as a straight port, rule for rule: two implementations of one product behaviour that
 * drift are worse than one that is merely duplicated.
 */

const GREETING =
  /^(hi|hey|hello|yo|thanks|thank you|ta|cheers|ok|okay|cool|nice|good (morning|afternoon|evening))\b/i;

const META = /\b(what can you do|who are you|what are you|how do you work|help me use)\b/i;

/** "fix it", "it's broken" — a change request in grammar, with nothing to act on. */
const VAGUE =
  /^(please\s+)?(fix|repair|debug|solve)\s+(it|this|that|the (bug|issue|problem))[\s.!?]*$|^(it|this|that)('?s| is)?\s*(broken|not working|buggy|failing)[\s.!?]*$/i;

const WORDS = /[A-Za-z][A-Za-z_]{2,}/g;

/** A decided reason, or null when the pipeline should actually look. The reason names WHICH
 * rule fired, because the right reply differs by subclass — the answer card renders per
 * reason. */
export function prefilter(issue: string): "meta" | "vague" | "chitchat" | "nonsense" | null {
  const text = issue.trim();
  // Meta before length: "help me" and "who are you" are short AND about the assistant, and
  // the capabilities answer is the better reply for both.
  if (META.test(text)) return "meta";
  if (text.length < 12) return GREETING.test(text) ? "chitchat" : "vague";
  // Nothing word-like to retrieve on: punctuation, emoji, or a keyboard mash.
  const words = text.match(WORDS) ?? [];
  if (!words.length) return "nonsense";
  if (VAGUE.test(text)) return "vague";
  if (GREETING.test(text) && words.length <= 4) return "chitchat";
  return null;
}
