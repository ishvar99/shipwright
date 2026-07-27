"""Deterministic code graph from tree-sitter ASTs.

No LLM extraction: it is slower, costs money, and published comparisons find it misses
files silently. Parsing is exact and rebuilds in seconds.

Nodes are files, classes and functions. Edges are contains / imports / invokes. Call
resolution is name-based, which is approximate — the same approach Aider's repo map and
RepoGraph use.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

import tree_sitter_python
from tree_sitter import Language, Parser

PY = Language(tree_sitter_python.language())
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", "build", "dist", ".tox"}
MAX_FILE_BYTES = 400_000


@dataclass
class Symbol:
    """A function or class. `id` is 'path:name', matching Loc-Bench ground truth."""

    id: str
    path: str
    name: str
    kind: str  # function | class
    start_line: int
    end_line: int
    text: str
    parent: str | None = None  # enclosing class for methods


@dataclass
class CodeGraph:
    root: Path
    symbols: dict[str, Symbol] = field(default_factory=dict)
    files: dict[str, list[str]] = field(default_factory=lambda: defaultdict(list))
    calls: dict[str, set[str]] = field(default_factory=lambda: defaultdict(set))
    called_by: dict[str, set[str]] = field(default_factory=lambda: defaultdict(set))
    imports: dict[str, set[str]] = field(default_factory=lambda: defaultdict(set))

    def neighbors(self, symbol_id: str, hops: int = 1) -> set[str]:
        """Callers, callees, and file siblings — the blast radius around a symbol."""
        seen = {symbol_id}
        frontier = {symbol_id}
        for _ in range(hops):
            nxt: set[str] = set()
            for sid in frontier:
                nxt |= self.calls.get(sid, set()) | self.called_by.get(sid, set())
            frontier = nxt - seen
            seen |= nxt
        return seen - {symbol_id}

    def stats(self) -> dict[str, int]:
        return {
            "files": len(self.files),
            "symbols": len(self.symbols),
            "call_edges": sum(len(v) for v in self.calls.values()),
            "import_edges": sum(len(v) for v in self.imports.values()),
        }


def _node_name(node) -> str | None:
    ident = node.child_by_field_name("name")
    return ident.text.decode("utf8", "replace") if ident else None


def _walk_defs(node, path: str, src: bytes, out: list[Symbol], parent: str | None = None) -> None:
    for child in node.children:
        kind = None
        if child.type == "function_definition":
            kind = "function"
        elif child.type == "class_definition":
            kind = "class"

        if kind:
            name = _node_name(child)
            if name:
                # Methods are qualified as Class.method: 61% of Loc-Bench ground truth
                # uses that form, and bare names silently never match it.
                qualified = f"{parent}.{name}" if (kind == "function" and parent) else name
                sym = Symbol(
                    id=f"{path}:{qualified}",
                    path=path,
                    name=name,
                    kind=kind,
                    start_line=child.start_point[0] + 1,
                    end_line=child.end_point[0] + 1,
                    text=src[child.start_byte : child.end_byte].decode("utf8", "replace"),
                    parent=parent,
                )
                out.append(sym)
                body = child.child_by_field_name("body")
                if body is not None:
                    _walk_defs(body, path, src, out, parent=name if kind == "class" else parent)
            continue
        _walk_defs(child, path, src, out, parent)


def _collect_calls(node, src: bytes, acc: set[str]) -> None:
    if node.type == "call":
        fn = node.child_by_field_name("function")
        if fn is not None:
            text = fn.text.decode("utf8", "replace")
            acc.add(text.rsplit(".", 1)[-1])  # bare name; attribute calls lose the receiver
    for child in node.children:
        _collect_calls(child, src, acc)


def _collect_imports(node, src: bytes, acc: set[str]) -> None:
    if node.type in ("import_statement", "import_from_statement"):
        acc.add(node.text.decode("utf8", "replace"))
    for child in node.children:
        _collect_imports(child, src, acc)


def build(root: Path, max_files: int = 4000) -> CodeGraph:
    graph = CodeGraph(root=root)
    parser = Parser(PY)
    by_name: dict[str, list[str]] = defaultdict(list)
    pending_calls: dict[str, set[str]] = {}

    count = 0
    for file in sorted(root.rglob("*.py")):
        if any(part in SKIP_DIRS for part in file.parts):
            continue
        try:
            if file.stat().st_size > MAX_FILE_BYTES:
                continue
            src = file.read_bytes()
        except OSError:
            continue

        rel = str(file.relative_to(root))
        tree = parser.parse(src)
        syms: list[Symbol] = []
        _walk_defs(tree.root_node, rel, src, syms)

        for sym in syms:
            graph.symbols[sym.id] = sym
            graph.files[rel].append(sym.id)
            by_name[sym.name].append(sym.id)
            called: set[str] = set()
            _collect_calls(parser.parse(sym.text.encode()).root_node, sym.text.encode(), called)
            pending_calls[sym.id] = called

        imports: set[str] = set()
        _collect_imports(tree.root_node, src, imports)
        graph.imports[rel] = imports

        count += 1
        if count >= max_files:
            break

    # Resolve calls by name. Ambiguous names link to every match — recall over precision,
    # since this feeds retrieval expansion rather than a correctness check.
    for sid, names in pending_calls.items():
        for name in names:
            for target in by_name.get(name, ()):
                if target != sid:
                    graph.calls[sid].add(target)
                    graph.called_by[target].add(sid)

    return graph
