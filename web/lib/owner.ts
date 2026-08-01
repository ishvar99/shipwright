import { headers } from "next/headers";
import { auth, githubConfigured } from "@/lib/auth";

/**
 * Who owns the repositories a request touches, as a stable GitHub account id.
 *
 * Deliberately NOT `session.user.id`. With no database adapter Better Auth keeps users in
 * memory and mints a fresh id per sign-in, so keying ownership on it would re-own every
 * repository on each restart — worse than not scoping at all. The provider's own account id
 * is stable, is available without an adapter, and is what a person would call "me".
 *
 * `""` is the anonymous owner: nobody signed in. That is the single-user local install, and it
 * owns every row that predates ownership. Falling back to `""` rather than to some synthetic
 * id is the safe direction — it can only ever show someone their own existing work.
 */
export async function callerOwner(): Promise<string> {
  if (!githubConfigured) return "";
  try {
    const accounts = await auth.api.listUserAccounts({ headers: await headers() });
    const github = accounts?.find((a) => a.providerId === "github");
    return github?.accountId ? `gh:${github.accountId}` : "";
  } catch {
    // No cookie, an expired one, or a shape this version does not provide: anonymous.
    return "";
  }
}
