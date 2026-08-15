"""What the model is shown about a changed function.

The budget policy here is measured, not chosen. Including the full source of up to three
callers and three callees reached 38,447 estimated tokens on a Django task — over the 16,384
local window. Reducing neighbours to one signature line each, capped and same-file first,
held the same task to 1,691 and the worst of ten sampled tasks to 5,446. See the design spec
§9.2 for the table.
"""

from __future__ import annotations

from pathlib import Path

from ..codegraph.build import CodeGraph, Symbol
from .diff import FileDiff

MAX_NEIGHBOURS = 5  # per direction
SIG_CHARS = 120
MAX_OWN_CHARS = 6000
NO_CALLERS = "  (no callers found in the index)"
NO_CALLEES = "  (no callees found in the index)"


def changed_symbols(graph: CodeGraph, fd: FileDiff) -> list[str]:
    """Symbol ids whose line span contains a line this diff touched.

    Ordered by first touched line so the review reads top-down, the way the file does.
    """
    touched = fd.added_lines | fd.deleted_lines
    if not touched:
        return []
    hits: list[tuple[int, str]] = []
    for sid in graph.files.get(fd.path, []):
        sym = graph.symbols.get(sid)
        if sym is None or sym.kind != "function":
            continue
        inside = [n for n in touched if sym.start_line <= n <= sym.end_line]
        if inside:
            hits.append((min(inside), sid))
    return [sid for _, sid in sorted(hits)]


def _signature(text: str) -> str:
    for line in text.splitlines():
        if line.strip():
            return line.strip()[:SIG_CHARS]
    return ""


def _pick(graph: CodeGraph, ids: set[str], home: str) -> list[str]:
    """Cap and order neighbours, same-file first then same-directory.

    Call resolution is name-only (build.py:114), so a common name over-links across the whole
    repository. Without this ordering an unrelated same-named symbol wins the budget.
    """
    syms = [graph.symbols[i] for i in sorted(ids) if i in graph.symbols]
    home_dir = str(Path(home).parent)

    def rank(s: Symbol) -> int:
        if s.path == home:
            return 0
        return 1 if str(Path(s.path).parent) == home_dir else 2

    chosen = sorted(syms, key=lambda s: (rank(s), s.id))[:MAX_NEIGHBOURS]
    return [f"{s.id}  {_signature(s.text)}" for s in chosen]


def assemble(graph: CodeGraph, symbol_id: str) -> str:
    """The graph-tier context block for one changed function."""
    sym = graph.symbols.get(symbol_id)
    if sym is None:
        return ""

    # .get, never [] — these are defaultdicts and a miss would insert an empty set,
    # silently inflating stats().
    callers = _pick(graph, graph.called_by.get(symbol_id, set()), sym.path)
    callees = _pick(graph, graph.calls.get(symbol_id, set()), sym.path)

    parts = [
        f"# {sym.id}  (lines {sym.start_line}-{sym.end_line})",
        sym.text[:MAX_OWN_CHARS],
        "",
        "# Called by:",
        *([f"  {line}" for line in callers] if callers else [NO_CALLERS]),
        "",
        "# Calls:",
        *([f"  {line}" for line in callees] if callees else [NO_CALLEES]),
    ]
    return "\n".join(parts)
