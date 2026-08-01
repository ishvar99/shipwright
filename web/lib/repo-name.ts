/** Display name for a repo slug. GitHub slugs stay "owner/name" — that is how GitHub reads
 * and the owner is meaningful. Local imports carry the directory name, which conventionally
 * encodes the owner as "owner__name". A zip slug is the user's filename, taken verbatim. */
export function repoDisplayName(slug: string): string {
  const bare = slug.replace(/^(local|zip):/, "");
  if (slug.startsWith("zip:")) return bare || slug;
  return bare.split("__").pop() || bare || slug;
}
