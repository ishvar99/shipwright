/**
 * Python symbols from a regex pass, for repos indexed in the browser.
 *
 * The same shape as the backend's tree-sitter graph (src/shipwright/codegraph/build.py) minus
 * calls/called_by: resolving call edges needs an AST, and guessing them from text would link
 * the wrong symbols often enough to mislead. Ids stay `path:name`, so a locally indexed symbol
 * and a backend one address identically.
 */

export type LocalSymbol = {
  id: string;
  path: string;
  name: string;
  kind: string;
  start_line: number;
  end_line: number;
  text: string;
  parent: string;
};

const MAX_FILE_CHARS = 400_000;

/** `def` must show its paren; `class` may be bare (`class A:`). */
const DEFINITION = /^([ \t]*)(?:async[ \t]+)?(def|class)[ \t]+([A-Za-z_]\w*)[ \t]*[(:]/;

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** Blank lines and comments drift between blocks and belong to neither, so a dedent on one
 * does not close the block above it. */
const isFiller = (line: string): boolean => {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
};

/**
 * Definitions in source order, which is also the backend's pre-order: a class precedes its own
 * methods and every later sibling. Extent comes from indentation alone, so a symbol runs until
 * the next real line that is no deeper than its own `def`/`class`.
 */
export function indexPython(path: string, source: string): LocalSymbol[] {
  if (source.length > MAX_FILE_CHARS) return [];

  const lines = source.split("\n");
  // A trailing newline splits into a phantom last element; keeping it pushes the final symbol's
  // end_line one line past the end of the file.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

  const out: LocalSymbol[] = [];
  const open: { indent: number; name: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = DEFINITION.exec(lines[i]);
    if (!match) continue;
    const indent = match[1].length;
    const kind = match[2] === "class" ? "class" : "function";
    const bare = match[3];

    while (open.length && open[open.length - 1].indent >= indent) open.pop();
    // Only classes are stacked, so a function nested in a method still reports the class —
    // matching the backend, which carries `parent` through function bodies unchanged.
    const parent = open.length ? open[open.length - 1].name : "";
    // Methods are qualified Class.method because that is how Loc-Bench ground truth is written;
    // a nested class keeps its bare name, as tree-sitter does.
    const name = kind === "function" && parent ? `${parent}.${bare}` : bare;

    let end = lines.length - 1;
    for (let j = i + 1; j < lines.length; j++) {
      if (isFiller(lines[j])) continue;
      if (indentOf(lines[j]) <= indent) {
        end = j - 1;
        break;
      }
    }
    // Trim the blank lines between this symbol and the next: tree-sitter's function_definition
    // node ends at the last statement, and carrying the gap would inflate every `text` excerpt
    // and misreport end_line to the editor's reveal.
    while (end > i && !lines[end].trim()) end -= 1;

    out.push({
      id: `${path}:${name}`,
      path,
      name,
      kind,
      start_line: i + 1,
      end_line: end + 1,
      // Decorators sit above the `def` and are excluded, so `text` lines up with start_line.
      text: lines.slice(i, end + 1).join("\n"),
      parent,
    });

    if (kind === "class") open.push({ indent, name: bare });
  }

  return out;
}

export function indexRepo(files: { path: string; content: string }[]): LocalSymbol[] {
  return files.flatMap((f) => (f.path.endsWith(".py") ? indexPython(f.path, f.content) : []));
}
