import type { Repo } from "@/lib/contracts";

/**
 * Resolving "fix issue #123" to a real GitHub issue.
 *
 * The trap this exists to avoid: a bare `#123` only means something when the open repository
 * IS a GitHub repository. Our slugs are `owner/name` only for `source: "github"` — a zip
 * import is `zip:<filename>` and a local folder is `local:<dir>` — so accepting `#123` against
 * those would silently fetch an issue from a repository the user never mentioned.
 */

export type IssueRef = { owner: string; name: string; number: number };

/** `owner/name` and nothing else: a zip: or local: slug must never match. */
const SLUG = /^([\w.-]+)\/([\w.-]+)$/;
const URL_REF = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)/i;
const QUALIFIED = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;
const BARE = /^#?(\d+)$/;

export function resolveIssueRef(input: string, repo: Repo | null): IssueRef | null {
  const text = input.trim();

  const url = URL_REF.exec(text);
  if (url) return { owner: url[1], name: url[2].replace(/\.git$/, ""), number: Number(url[3]) };

  const qualified = QUALIFIED.exec(text);
  if (qualified) return { owner: qualified[1], name: qualified[2], number: Number(qualified[3]) };

  const bare = BARE.exec(text);
  if (!bare) return null;
  // Bare numbers need the open repository to supply the owner, and only a GitHub one can.
  if (repo?.source !== "github") return null;
  const slug = SLUG.exec(repo.slug);
  if (!slug) return null;
  return { owner: slug[1], name: slug[2], number: Number(bare[1]) };
}

/** The question text an issue becomes. Title and body, because the title alone is often under
 * the router's 12-character floor and would be refused as "vague" — and a body-less issue is
 * exactly the kind people file when they intend to say "fix issue #123". */
export function issueToQuestion(issue: {
  title: string;
  body?: string | null;
  html_url?: string;
}): string {
  const body = (issue.body ?? "").trim();
  if (body) return `${issue.title}\n\n${body}`;
  return issue.html_url ? `${issue.title}\n\n${issue.html_url}` : issue.title;
}
