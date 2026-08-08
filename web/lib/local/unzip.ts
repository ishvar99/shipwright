/**
 * Reads a zip in the browser so a local import never uploads the archive. The guards are ported
 * from the server importer (`api/importer.py`) rather than deferred to it — nothing on this path
 * reaches a server, so a guard missing here is missing entirely. Header sizes are checked first
 * and the bytes actually produced are checked again, because a bomb under-reports itself.
 */

export type ZipEntry = { path: string; content: string };

/** Message is user-facing copy, rendered verbatim — never a repr. */
export class ZipRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipRejected";
  }
}

const MAX_ENTRIES = 10_000;
const MAX_TOTAL = 500 * 1024 * 1024;
const MAX_FILE = 50 * 1024 * 1024;

const MALFORMED = "That file isn't a zip archive.";
const TOO_BIG = "That archive is too large uncompressed (limit 500 MB).";
const FILE_TOO_BIG = "That archive contains a file over 50 MB.";

// Every mainstream language, framework single-file components, templates, configs, docs
// and build files. Dotfiles stay excluded below — that rule keeps `.env` out of IndexedDB.
const TEXT_EXTENSIONS = new Set(
  (
    "py pyi md txt json toml cfg ini yml yaml rst sh bash zsh fish bat ps1 sql " +
    "js jsx ts tsx mjs cjs mts cts html htm css scss sass less styl " +
    "go rs java cs kt kts swift scala dart c cc cpp cxx h hh hpp m mm " +
    "rb rake erb php phtml ex exs erl lua r jl pl pm hs elm ml mli fs fsx clj cljs edn " +
    // Not svg (image markup, huge single lines), not csv/tsv (AWS exports credentials as
    // credentials.csv — a canonical accidentally-committed secret).
    "vue svelte astro tf hcl proto graphql gql prisma xml " +
    // `.env` variants stay out on purpose — "example" admits the secretless template only.
    "gradle properties conf example lock mod sum work njk ejs hbs mustache twig"
  ).split(" "),
);
const TEXT_FILENAMES = new Set([
  "LICENSE",
  "Makefile",
  "Dockerfile",
  "Gemfile",
  "Rakefile",
  "Procfile",
  "Vagrantfile",
  "Justfile",
  "yarn.lock",
  "go.mod",
  "go.sum",
]);
const SKIPPED_DIRS = new Set([".git", "__MACOSX"]);

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const EOCD_SIZE = 22;

const lenient = new TextDecoder();
const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * The EOCD is followed by a comment of up to 65535 bytes, so it is not at a fixed position and
 * has to be found by scanning back. A stored file can contain the signature by chance, so a
 * candidate only counts if its comment length reaches exactly the end of the archive.
 */
function findEocd(view: DataView): number {
  const earliest = Math.max(0, view.byteLength - 0xffff - EOCD_SIZE);
  for (let at = view.byteLength - EOCD_SIZE; at >= earliest; at -= 1) {
    if (view.getUint32(at, true) !== EOCD_SIG) continue;
    if (view.getUint16(at + 20, true) === view.byteLength - at - EOCD_SIZE) return at;
  }
  return -1;
}

/**
 * Reject rather than sanitise: silently dropping a ".." would import a mangled tree instead of
 * telling the user what was wrong. Backslashes are unsafe because they are a path separator on
 * the platform the archive may have been built for, but not on the one reading it.
 */
function unsafePath(path: string): boolean {
  return path.startsWith("/") || path.includes("\\") || path.split("/").includes("..");
}

/** Exported so the benchmark admits exactly the files an import would, and no others. */
export function isTextFile(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (TEXT_FILENAMES.has(name)) return true;
  // Variants like Dockerfile.dev / makefile.inc, any case — the family, not the exact name.
  if (/^(dockerfile|makefile|jenkinsfile)(\.|$)/i.test(name)) return true;
  const dot = name.lastIndexOf(".");
  // `dot > 0` keeps dotfiles out: ".gitignore" has a name, not an extension — and with it
  // every `.env` variant, which is what keeps secrets out of IndexedDB.
  return dot > 0 && TEXT_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

async function inflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const reader = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  })
    .pipeThrough(new DecompressionStream("deflate-raw"))
    .getReader();

  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_FILE) throw new ZipRejected(FILE_TOO_BIG);
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof ZipRejected) {
      await reader.cancel();
      throw e;
    }
    throw new ZipRejected("That archive is damaged and couldn't be read.");
  }

  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** Central directory fields needed to reach an entry's bytes. */
type Header = {
  path: string;
  method: number;
  compressed: number;
  localOffset: number;
  crc: number;
};

/**
 * Every entry is validated, including the ones extraction later skips: a ".." path or a 200 MB
 * blob under `.git/` is evidence about the archive, not about the files we happen to want.
 * An uploaded `.git` never survives — a `.git/hooks/pre-commit` in the archive must not be able
 * to reach the git directory of whatever the import becomes.
 */
function readCentralDirectory(view: DataView, bytes: Uint8Array): { headers: Header[]; allPaths: string[] } {
  const eocd = findEocd(view);
  if (eocd === -1) throw new ZipRejected(MALFORMED);

  const count = view.getUint16(eocd + 10, true);
  if (count > MAX_ENTRIES) throw new ZipRejected("That archive has too many files (limit 10,000).");

  const headers: Header[] = [];
  let at = view.getUint32(eocd + 16, true);
  let total = 0;
  // Every path, including the ones skipped below: the wrapper-directory decision has to see
  // the archive as it really is. Computing it from the surviving entries deleted a real `src/`
  // from every repo zipped together with its `.git/`.
  const allPaths: string[] = [];

  for (let i = 0; i < count; i += 1) {
    if (at + 46 > view.byteLength || view.getUint32(at, true) !== CD_SIG) {
      throw new ZipRejected(MALFORMED);
    }
    const nameLength = view.getUint16(at + 28, true);
    const path = lenient.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (unsafePath(path)) throw new ZipRejected("That archive contains unsafe file paths.");

    const size = view.getUint32(at + 24, true);
    if (size > MAX_FILE) throw new ZipRejected(FILE_TOO_BIG);
    total += size;
    if (total > MAX_TOTAL) throw new ZipRejected(TOO_BIG);

    allPaths.push(path);
    if (!path.split("/").some((s) => SKIPPED_DIRS.has(s))) {
      headers.push({
        path,
        method: view.getUint16(at + 10, true),
        crc: view.getUint32(at + 16, true),
        compressed: view.getUint32(at + 20, true),
        localOffset: view.getUint32(at + 42, true),
      });
    }
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return { headers, allPaths };
}

/**
 * A GitHub zipball wraps the tree in one directory named after the ref. Hoisting it makes
 * `zip -r proj.zip proj/` and a zipball of the same tree import identically. Decided over every
 * entry in the archive rather than the text files that survive filtering: `src/a.py` next to a
 * `logo.png` is a wrapper only if you first delete the png, and stripping `src/` there would
 * rename real source paths. Requiring the trailing slash also stops a single root-level file
 * being hoisted into an empty path.
 */
function wrapperPrefix(paths: string[]): string {
  const first = paths[0]?.split("/", 1)[0];
  if (!first) return "";
  const prefix = `${first}/`;
  return paths.every((p) => p.startsWith(prefix)) ? prefix : "";
}

let crcTable: Uint32Array | null = null;

/** CRC-32, built once. Without it a bit-flipped download imports as if it were the real source
 * — and for stored (uncompressed) entries there is no other integrity signal at all. */
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export async function unzip(data: ArrayBuffer): Promise<ZipEntry[]> {
  if (data.byteLength < EOCD_SIZE) throw new ZipRejected(MALFORMED);
  const view = new DataView(data);
  const bytes = new Uint8Array(data);

  const { headers, allPaths } = readCentralDirectory(view, bytes);
  const prefix = wrapperPrefix(allPaths);
  const entries: ZipEntry[] = [];
  let written = 0;

  for (const header of headers) {
    // A directory entry's name is empty after the last slash, so it has no extension either.
    if (!isTextFile(header.path)) continue;
    if (header.method !== 0 && header.method !== 8) {
      throw new ZipRejected("That archive uses a compression method we can't read.");
    }

    // The local header repeats the name and extra fields at its own lengths, and the extra
    // field routinely differs from the central directory's. Only these two locate the bytes.
    const local = header.localOffset;
    if (local + 30 > view.byteLength) throw new ZipRejected(MALFORMED);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const end = start + header.compressed;
    if (end > view.byteLength) throw new ZipRejected(MALFORMED);

    const raw = bytes.subarray(start, end);
    if (header.method === 0 && raw.length > MAX_FILE) throw new ZipRejected(FILE_TOO_BIG);
    const content = header.method === 8 ? await inflate(raw) : raw;

    // A zero CRC with the streaming flag set means the value lives in the data descriptor,
    // not here; anything else that disagrees is a damaged archive.
    if (header.crc !== 0 && crc32(content) !== header.crc) throw new ZipRejected(MALFORMED);

    written += content.length;
    if (written > MAX_TOTAL) throw new ZipRejected(TOO_BIG);

    // Re-checked after stripping: the guard above saw the original path, and a doubled
    // separator right after the wrapper ("proj//a.py") strips to an absolute "/a.py".
    const path = header.path.slice(prefix.length);
    if (!path || unsafePath(path)) throw new ZipRejected("That archive contains unsafe file paths.");

    try {
      entries.push({ path, content: utf8.decode(content) });
    } catch {
      // Binary that slipped past the extension test. One odd file must not fail the import.
    }
  }

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}
