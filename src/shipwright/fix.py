"""Fix generation: whole-function rewrite, diff computed by us.

The model NEVER emits diff syntax — spiked at 0/2 valid on the local 7B, `git apply` corrupt
both times. Instead it rewrites one function whose exact span the code graph knows, and this
module owns everything failable: parse, locate (unwrapping a class wrapper), hoist new
imports, re-indent, whole-file parse, `git apply --check`. The resulting diff applies by
construction or the attempt is reported failed — never a corrupt patch.
"""

from __future__ import annotations

import ast
import difflib
import re
import subprocess
import textwrap
import time
from collections.abc import Callable
from pathlib import Path

MAX_ISSUE_CHARS = 3000
MAX_FN_TOKENS = 1200
DELTA_FLUSH_S = 0.5
_FENCE = re.compile(r"```(?:\w+)?\s*\n(.*?)```", re.S)


class FixError(Exception):
    """Curated, customer-safe reason. Never a repr."""


def _batcher(on_delta: Callable[[str], None] | None):
    """Batches streamed chunks to ~2 events/sec so the DB is not written per token."""
    buffer: list[str] = []
    stamp = [time.monotonic()]

    def chunk(piece: str) -> None:
        buffer.append(piece)
        if on_delta and time.monotonic() - stamp[0] >= DELTA_FLUSH_S:
            on_delta("".join(buffer))
            buffer.clear()
            stamp[0] = time.monotonic()

    def flush() -> None:
        if on_delta and buffer:
            on_delta("".join(buffer))
            buffer.clear()

    return chunk, flush


def _read(root: Path, rel: str) -> str:
    # utf-8-sig: real repos open with BOMs (msal/token_cache.py does).
    return (root / rel).read_text(encoding="utf-8-sig", errors="replace")


def _strip_fences(text: str) -> str:
    m = _FENCE.search(text)
    return (m.group(1) if m else text).strip()


def _find_function(code: str, name: str) -> str:
    """The rewritten function's source, tolerating a leading class wrapper or extra prose the
    parser accepts. Raises FixError when it is genuinely absent."""
    tree = ast.parse(code)
    lines = code.splitlines()

    def scan(body):
        for node in body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
                return textwrap.dedent("\n".join(lines[node.lineno - 1 : node.end_lineno]))
            if isinstance(node, ast.ClassDef):
                found = scan(node.body)
                if found:
                    return found
        return None

    found = scan(tree.body)
    if not found:
        raise FixError("the rewrite did not contain the target function")
    return found


def _new_imports(code: str, existing_source: str) -> list[str]:
    tree = ast.parse(code)
    out = []
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            stmt = ast.unparse(node)
            if stmt not in existing_source:
                out.append(stmt + "\n")
    return out


def build_patch(
    repo_path: str,
    rel_path: str,
    fn_name: str,
    start_line: int,
    end_line: int,
    rewritten: str,
) -> dict:
    """Validate a rewrite and turn it into a diff of ours. Raises FixError with a curated
    reason; on success the patch is guaranteed to `git apply`."""
    root = Path(repo_path)
    code = _strip_fences(rewritten)
    try:
        fn_src = _find_function(code, fn_name)
    except SyntaxError as e:
        raise FixError("the rewrite was not valid Python") from e

    original = _read(root, rel_path)
    old_lines = original.splitlines(keepends=True)
    if not (1 <= start_line <= end_line <= len(old_lines)):
        raise FixError("the target function has moved since indexing — re-import the repository")

    indent = re.match(r"\s*", old_lines[start_line - 1]).group(0)
    new_fn = [indent + line + "\n" if line.strip() else "\n" for line in fn_src.splitlines()]
    hoisted = _new_imports(code, original)
    new_lines = hoisted + old_lines[: start_line - 1] + new_fn + old_lines[end_line:]

    try:
        ast.parse("".join(new_lines))
    except SyntaxError as e:
        raise FixError("the fix did not fit the surrounding file") from e

    patch = "".join(difflib.unified_diff(old_lines, new_lines, f"a/{rel_path}", f"b/{rel_path}"))
    if not patch:
        raise FixError("the rewrite was identical to the current code")

    check = subprocess.run(
        ["git", "apply", "--check", "-"],
        input=patch,
        text=True,
        capture_output=True,
        cwd=root,
    )
    if check.returncode != 0:
        raise FixError("the change could not be applied cleanly")

    body = [ln for ln in patch.splitlines() if not ln.startswith(("+++", "---"))]
    additions = sum(1 for ln in body if ln.startswith("+"))
    deletions = sum(1 for ln in body if ln.startswith("-"))
    return {
        "patch": patch,
        "files": 1,
        "additions": additions,
        "deletions": deletions,
        "imports_added": len(hoisted),
    }


def fix_prompt(issue: str, rel_path: str, fn_src: str, lo: int, hi: int, feedback: str = "") -> str:
    fb = (
        f"\nA previous attempt was applied and the tests failed with:\n{feedback[:1200]}\n"
        "Write a corrected version that addresses the failure.\n"
        if feedback
        else ""
    )
    return (
        f"Issue:\n{issue[:MAX_ISSUE_CHARS]}\n\n"
        f"File: {rel_path} (lines {lo}-{hi})\n```python\n{fn_src}\n```\n{fb}\n"
        "Rewrite the complete corrected function. Keep the same name and signature. If you "
        "need a new import, put it on its own line before the function. Output ONLY code, "
        "no prose."
    )


def generate_fix(
    *,
    repo_path: str,
    issue: str,
    target: dict,
    model,
    on_delta: Callable[[str], None] | None = None,
    feedback: str = "",
    attempts: int = 2,
) -> tuple[dict, object]:
    """Streamed generation with one bounded format retry. Returns (fix, usage-like result)."""
    root = Path(repo_path)
    rel, name = target["path"], target["name"]
    lo, hi = int(target["start_line"]), int(target["end_line"]) or int(target["start_line"])
    fn_src = "\n".join(_read(root, rel).splitlines()[lo - 1 : hi])

    prompt = fix_prompt(issue, rel, fn_src, lo, hi, feedback)
    last_error: FixError | None = None
    for attempt in range(attempts):
        chunk, flush = _batcher(on_delta)
        result = model.generate(
            [{"role": "user", "content": prompt}],
            max_tokens=MAX_FN_TOKENS,
            temperature=0.0 if attempt == 0 else 0.4,
            on_delta=chunk,
        )
        flush()
        try:
            fix = build_patch(str(root), rel, name, lo, hi, result.text)
            fix["target"] = {
                "symbol": target["symbol"],
                "path": rel,
                "name": name,
                "start_line": lo,
            }
            fix["attempt"] = attempt + 1
            return fix, result
        except FixError as e:
            last_error = e
            prompt = (
                fix_prompt(issue, rel, fn_src, lo, hi, feedback)
                + f"\nYour previous output was rejected: {e}. Output the complete function "
                "definition only, starting with `def`."
            )
    raise last_error or FixError("could not produce a valid fix")
