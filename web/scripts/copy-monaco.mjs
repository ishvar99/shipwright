/**
 * Monaco is served from our own origin, never a CDN: the CSP is same-origin only.
 * The language/ directory is the IntelliSense workers (~7.6MB) — syntax colouring comes from
 * Monarch grammars on the main thread, so a read-and-edit editor does not need them.
 */
import { cp, rm, stat } from "node:fs/promises";

const SRC = "node_modules/monaco-editor/min/vs";
const DEST = "public/monaco/vs";

try {
  await stat(SRC);
} catch {
  console.error(`copy-monaco: ${SRC} is missing — run npm install first.`);
  process.exit(1);
}

await rm("public/monaco", { recursive: true, force: true });
await cp(SRC, DEST, { recursive: true });
await rm(`${DEST}/language`, { recursive: true, force: true });
console.log(`copy-monaco: ${SRC} -> ${DEST}`);
