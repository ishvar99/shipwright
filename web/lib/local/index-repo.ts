/**
 * The browser indexer: every text file becomes symbols, whatever the language.
 *
 * The same shape as the backend's tree-sitter graph (src/shipwright/codegraph/build.py)
 * minus calls/called_by: resolving call edges needs an AST, and guessing them from text
 * would link the wrong symbols often enough to mislead. Ids stay `path:name`, so a locally
 * indexed symbol and a backend one address identically.
 */

import { chunkFile, extract, type LocalSymbol } from "@/lib/local/languages";

export { indexPython, type LocalSymbol } from "@/lib/local/languages";

/** Recognised languages get real symbol names; everything else gets sections. An extractor
 * that finds nothing also falls through — a recognised extension with no declarations (a
 * config-shaped .ts file, say) must still be searchable. */
export function indexRepo(files: { path: string; content: string }[]): LocalSymbol[] {
  return files.flatMap((f) => {
    const precise = extract(f.path, f.content);
    return precise?.length ? precise : chunkFile(f.path, f.content);
  });
}
