/**
 * Symbol extraction for repos indexed in the browser, all languages.
 *
 * Tiered on purpose: precise extractors where a language's shape is worth knowing
 * (real names on result cards), and a section chunker for everything else so no text
 * file is ever unsearchable. Approximate by design — a brace inside a regex literal
 * may mis-extend one symbol, never corrupt a file — because BM25 needs names and
 * bodies, not ASTs.
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

export const MAX_FILE_CHARS = 400_000;

// ---------- indentation languages (extent = next line at the same depth) ----------

type IndentSpec = {
  /** Captures: 1 indent, 2 keyword, 3 name. */
  decl: RegExp;
  containers: Set<string>;
  comment: string;
};

const PYTHON: IndentSpec = {
  /** `def` must show its paren; `class` may be bare (`class A:`). */
  decl: /^([ \t]*)(?:async[ \t]+)?(def|class)[ \t]+([A-Za-z_]\w*)[ \t]*[(:]/,
  containers: new Set(["class"]),
  comment: "#",
};

const RUBY: IndentSpec = {
  decl: /^([ \t]*)(def|class|module)[ \t]+(?:self\.)?([A-Za-z_]\w*[?!]?)/,
  containers: new Set(["class", "module"]),
  comment: "#",
};

const ELIXIR: IndentSpec = {
  decl: /^([ \t]*)(defmodule|defmacro|defp|def)[ \t]+([A-Za-z_][\w.]*[?!]?)/,
  containers: new Set(["defmodule"]),
  comment: "#",
};

const indentOf = (line: string): number => line.length - line.trimStart().length;

/**
 * Definitions in source order, which is also the backend's pre-order: a container precedes
 * its own members and every later sibling. Extent comes from indentation alone, so a symbol
 * runs until the next real line that is no deeper than its own declaration.
 */
function indexIndented(path: string, source: string, spec: IndentSpec): LocalSymbol[] {
  if (source.length > MAX_FILE_CHARS) return [];

  const lines = source.split("\n");
  // A trailing newline splits into a phantom last element; keeping it pushes the final
  // symbol's end_line one line past the end of the file.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

  // Blank lines and comments drift between blocks and belong to neither, so a dedent on
  // one does not close the block above it.
  const isFiller = (line: string): boolean => {
    const trimmed = line.trim();
    return trimmed === "" || trimmed.startsWith(spec.comment);
  };

  const out: LocalSymbol[] = [];
  const open: { indent: number; name: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = spec.decl.exec(lines[i]);
    if (!match) continue;
    const indent = match[1].length;
    const container = spec.containers.has(match[2]);
    const kind = container ? "class" : "function";
    const bare = match[3];

    while (open.length && open[open.length - 1].indent >= indent) open.pop();
    // Only containers are stacked, so a function nested in a method still reports the
    // class — matching the backend, which carries `parent` through function bodies.
    const parent = open.length ? open[open.length - 1].name : "";
    // Members are qualified Class.method because that is how Loc-Bench ground truth is
    // written; a nested container keeps its bare name, as tree-sitter does.
    const name = kind === "function" && parent ? `${parent}.${bare}` : bare;

    let end = lines.length - 1;
    for (let j = i + 1; j < lines.length; j++) {
      if (isFiller(lines[j])) continue;
      if (indentOf(lines[j]) <= indent) {
        end = j - 1;
        break;
      }
    }
    // Trim the blank lines between this symbol and the next: carrying the gap would
    // inflate every `text` excerpt and misreport end_line to the editor's reveal.
    while (end > i && !lines[end].trim()) end -= 1;

    out.push({
      id: `${path}:${name}`,
      path,
      name,
      kind,
      start_line: i + 1,
      end_line: end + 1,
      text: lines.slice(i, end + 1).join("\n"),
      parent,
    });

    if (container) open.push({ indent, name: bare });
  }

  return out;
}

/** The original entry point, kept callable by name: the Python tests pin its behaviour. */
export function indexPython(path: string, source: string): LocalSymbol[] {
  return indexIndented(path, source, PYTHON);
}

// ---------- brace languages (extent = where the block's braces balance) ----------

type BraceSpec = {
  /** Class-like declarations; each opens a parent frame members qualify against. */
  containers: RegExp[];
  /** Function-like declarations, valid anywhere. */
  callables: RegExp[];
  /** Member declarations, only trusted directly inside a container's body — the depth
   * rule is what keeps ordinary call statements from reading as methods. */
  members?: RegExp[];
  /** Also trust member patterns at file scope (C, C++ free functions). */
  freeMembers?: boolean;
  /** Rust has no char-quote ambiguity worth keeping: `'a` lifetimes are unpaired. */
  quotes?: string;
};

/** Control flow and other non-names that the looser member patterns could catch. */
const NOT_A_NAME = new Set([
  "if", "for", "while", "switch", "catch", "return", "else", "do", "try", "new",
  "throw", "typeof", "await", "yield", "constructor", "function", "match", "when",
]);

const JS: BraceSpec = {
  containers: [
    /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    // TS-only shapes; their bodies are signatures, which the container's own text carries.
    /^\s*(?:export\s+)?(?:declare\s+)?(?:interface|enum|namespace)\s+([A-Za-z_$][\w$]*)/,
  ],
  callables: [
    /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/,
    // const f = (a, b) => …, const f = async x => …, const f: Handler = (req) => …
    /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]{0,120})?=\s*(?:async\s+)?(?:\([^)]*\)?|[A-Za-z_$][\w$]*)\s*(?::[^=]*)?=>/,
    /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b/,
  ],
  members: [
    // Modifiers, then `name(...)` ending in `{` — defaults inside the parens are fine, an
    // `=` before the paren is a field initialiser and stays out. Signature-only lines
    // (interface members, `foo(): void;`) end in `;` and stay out too.
    /^\s*(?:(?:public|private|protected|static|readonly|async|get|set|override)\s+)*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^;]*\)\s*(?::[^;={]+)?\s*\{/,
    // Parameter list spilling onto following lines.
    /^\s*(?:(?:public|private|protected|static|readonly|async|get|set|override)\s+)*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^;)]*$/,
  ],
};

const GO: BraceSpec = {
  // `[T any]` between name and body/paren: generics arrived in Go 1.18.
  containers: [/^type\s+([A-Za-z_]\w*)(?:\[[^\]]*\])?\s+(?:struct|interface)\b/],
  callables: [
    // A receiver qualifies the name the way a class would: Server.Handle.
    /^func\s*\(\s*\w+\s+\*?([A-Za-z_]\w*)(?:\[[^\]]*\])?\s*\)\s*([A-Za-z_]\w*)\s*[([]/,
    /^func\s+([A-Za-z_]\w*)\s*[([]/,
  ],
};

const RUST: BraceSpec = {
  containers: [
    /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|union)\s+([A-Za-z_]\w*)/,
    /^\s*impl(?:<[^>]*>)?\s+(?:[\w:<>]+\s+for\s+)?([A-Za-z_][\w:]*)/,
    /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*\{/,
  ],
  callables: [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/],
  // A lifetime (`<'a>`, `&'a str`) is an unpaired apostrophe: treating it as a char-literal
  // opener ate the rest of the line, including impl braces.
  quotes: '"',
};

/** Java, C#, Kotlin, Swift, Scala, Dart, C/C++ — one family: keyword-led containers, and
 * either keyword-led callables (fun/func/def) or type-led signatures guarded by depth. */
const CLIKE: BraceSpec = {
  containers: [
    /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|internal|open|final|sealed|abstract|static|data|partial|export)\s+)*(?:class|interface|enum|object|struct|record|trait|protocol|extension)\s+([A-Za-z_]\w*)/,
  ],
  callables: [/^\s*(?:(?:public|private|protected|internal|open|override|suspend|static|final|async)\s+)*(?:fun|func)\s+([A-Za-z_]\w*)\s*[(<]/],
  members: [
    // `int add(int a, int b) {` / `public static void main(String[] a) {` — a return type,
    // a name, an argument list, and an opening brace (possibly on the next line).
    /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|internal|static|final|abstract|synchronized|native|override|virtual|async|const)\s+)*[\w<>[\],.?*&:\s]+?[\s*&]([A-Za-z_]\w*)\s*\([^;=]*(?:\)[^;={]*\{|,?\s*$)/,
  ],
  // C and C++ define functions at file scope, where no container frame exists.
  freeMembers: true,
};

const PHP: BraceSpec = {
  containers: [/^\s*(?:final\s+|abstract\s+)?(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/],
  callables: [/^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*function\s+&?([A-Za-z_]\w*)\s*\(/],
};

/** Strings, comments and (heuristically) regex literals removed so their braces never
 * count. Quote state resets per line — a multiline template literal can leak braces, which
 * mis-extends one symbol at worst. A `/` reads as a regex opener only where an expression
 * may start; that heuristic is exactly the one syntax highlighters get away with. */
function stripLiterals(lines: string[], quotes = "\"'`"): string[] {
  let inBlock = false;
  return lines.map((raw) => {
    let out = "";
    let quote: string | null = null;
    let prev = ""; // last significant character emitted
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (inBlock) {
        if (c === "*" && raw[i + 1] === "/") {
          inBlock = false;
          i += 1;
        }
        continue;
      }
      if (quote) {
        if (c === "\\") i += 1;
        else if (c === quote) quote = null;
        continue;
      }
      if (quotes.includes(c)) {
        quote = c;
        continue;
      }
      if (c === "/" && raw[i + 1] === "*") {
        inBlock = true;
        i += 1;
        continue;
      }
      if (c === "/" && raw[i + 1] === "/") break;
      if (c === "/" && "=([{,;:!&|?+-*%<>~^".includes(prev || "(")) {
        // Regex literal: consume to the unescaped closing slash on this line.
        for (i += 1; i < raw.length; i++) {
          if (raw[i] === "\\") i += 1;
          else if (raw[i] === "/") break;
        }
        continue;
      }
      out += c;
      if (c.trim()) prev = c;
    }
    return out;
  });
}

const opens = (s: string): number => (s.match(/\{/g) ?? []).length;
const closes = (s: string): number => (s.match(/\}/g) ?? []).length;

/** From the declaration line, the block ends where its braces balance; a declaration that
 * never opens one (an expression-bodied arrow, a prototype) ends at its own statement. */
function braceExtent(stripped: string[], from: number): number {
  let depth = 0;
  let opened = false;
  for (let j = from; j < stripped.length; j++) {
    depth += opens(stripped[j]) - closes(stripped[j]);
    if (opens(stripped[j]) > 0) opened = true;
    if (opened && depth <= 0) return j;
    // Statement-bodied declaration: no brace before the statement ends.
    if (!opened && /;\s*$/.test(stripped[j])) return j;
    // Nothing opened within a screenful — treat as a one-liner rather than swallow the file.
    if (!opened && j - from > 16) return from;
  }
  return stripped.length - 1;
}

function indexBraced(path: string, source: string, spec: BraceSpec): LocalSymbol[] {
  if (source.length > MAX_FILE_CHARS) return [];

  const lines = source.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const stripped = stripLiterals(lines, spec.quotes);

  const out: LocalSymbol[] = [];
  // Containers by extent, so parent lookup is "innermost frame still covering this line".
  const frames: { name: string; end: number; bodyDepth: number }[] = [];
  let depth = 0;

  const push = (name: string, kind: string, i: number, end: number, parent: string) => {
    out.push({
      id: `${path}:${name}`,
      path,
      name,
      kind,
      start_line: i + 1,
      end_line: end + 1,
      text: lines.slice(i, end + 1).join("\n"),
      parent,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    while (frames.length && frames[frames.length - 1].end < i) frames.pop();
    const line = stripped[i];
    const frame = frames[frames.length - 1];

    const container = spec.containers.map((re) => re.exec(line)).find(Boolean);
    if (container) {
      const name = container[1];
      const end = braceExtent(stripped, i);
      push(name, "class", i, end, frame?.name ?? "");
      // One level in from the declaration, wherever the brace lands — computing it from
      // this line's own braces made Allman-style bodies (brace on the next line) invisible.
      frames.push({ name, end, bodyDepth: depth + 1 });
      depth += opens(line) - closes(line);
      continue;
    }

    let matched = false;
    for (const re of spec.callables) {
      const m = re.exec(line);
      if (!m) continue;
      const captures = m.slice(1).filter(Boolean);
      // Go receivers capture (Type, name); everything else captures (name).
      const bare = captures[captures.length - 1];
      const qualifier = captures.length > 1 ? captures[0] : frame?.name;
      if (NOT_A_NAME.has(bare)) break;
      const end = braceExtent(stripped, i);
      push(qualifier ? `${qualifier}.${bare}` : bare, "function", i, end, qualifier ?? "");
      matched = true;
      break;
    }

    // Members only directly inside a container's body (one level down, no deeper), or at
    // file scope where the language defines free functions — the depth rule is what stops
    // ordinary call statements from reading as declarations.
    const inBody = frame && depth === frame.bodyDepth;
    const atTop = !frame && depth === 0 && spec.freeMembers;
    if (!matched && spec.members && (inBody || atTop)) {
      for (const re of spec.members) {
        const m = re.exec(line);
        if (!m) continue;
        const bare = m.slice(1).find(Boolean)!;
        if (NOT_A_NAME.has(bare)) break;
        const end = braceExtent(stripped, i);
        push(frame ? `${frame.name}.${bare}` : bare, "function", i, end, frame?.name ?? "");
        break;
      }
    }

    depth += opens(line) - closes(line);
  }

  return out;
}

// ---------- the universal fallback ----------

const CHUNK_LINES = 60;

/** Sections for files no extractor understands — configs, templates, docs, minor languages.
 * Degraded granularity, honest labels, and every text file stays searchable. */
export function chunkFile(path: string, source: string): LocalSymbol[] {
  if (source.length > MAX_FILE_CHARS) return [];
  const lines = source.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  if (!lines.some((l) => l.trim())) return [];

  const base = path.split("/").pop() ?? path;
  const out: LocalSymbol[] = [];
  for (let start = 0; start < lines.length; start += CHUNK_LINES) {
    const end = Math.min(start + CHUNK_LINES, lines.length) - 1;
    const slice = lines.slice(start, end + 1);
    if (!slice.some((l) => l.trim())) continue;
    const first = slice.find((l) => l.trim())?.trim().slice(0, 60) ?? base;
    // The line marker makes the name unique per section, and the id stays `path:name` —
    // result cards derive their title from the id's tail, exactly as backend ids do.
    const name = lines.length <= CHUNK_LINES ? base : `${first}… · L${start + 1}`;
    out.push({
      id: `${path}:${name}`,
      path,
      name,
      kind: "section",
      start_line: start + 1,
      end_line: end + 1,
      text: slice.join("\n"),
      parent: "",
    });
  }
  return out;
}

// ---------- registry ----------

const BY_EXT = new Map<string, (path: string, source: string) => LocalSymbol[]>();
const register = (exts: string, fn: (path: string, source: string) => LocalSymbol[]) => {
  for (const ext of exts.split(" ")) BY_EXT.set(ext, fn);
};

register("py pyi", indexPython);
register("rb rake", (p, s) => indexIndented(p, s, RUBY));
register("ex exs", (p, s) => indexIndented(p, s, ELIXIR));
register("js jsx ts tsx mjs cjs mts cts", (p, s) => indexBraced(p, s, JS));
register("go", (p, s) => indexBraced(p, s, GO));
register("rs", (p, s) => indexBraced(p, s, RUST));
register("java cs kt kts swift scala dart c cc cpp cxx h hh hpp m mm", (p, s) =>
  indexBraced(p, s, CLIKE),
);
register("php", (p, s) => indexBraced(p, s, PHP));

/** Null when no extractor claims the extension — the caller decides to chunk. */
export function extract(path: string, source: string): LocalSymbol[] | null {
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
  const fn = BY_EXT.get(ext);
  return fn ? fn(path, source) : null;
}
