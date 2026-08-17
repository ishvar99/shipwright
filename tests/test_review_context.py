from pathlib import Path

from shipwright.codegraph.build import build
from shipwright.review.context import (
    MAX_NEIGHBOURS,
    assemble,
    changed_symbols,
)
from shipwright.review.diff import parse_file_patch


def _repo(tmp_path: Path) -> Path:
    """A real two-file repo and a real graph, the way test_assisted_degradation.py does it —
    a stubbed graph would not exercise the fan-out and defaultdict traps this module guards."""
    (tmp_path / "pkg").mkdir()
    (tmp_path / "pkg" / "core.py").write_text(
        "def target(value):\n"
        "    return value * 2\n"
        "\n"
        "def caller_one():\n"
        "    return target(1)\n"
        "\n"
        "def caller_two():\n"
        "    return target(2)\n"
    )
    (tmp_path / "pkg" / "other.py").write_text(
        "from pkg.core import target\n\n\ndef far_caller():\n    return target(3)\n"
    )
    return tmp_path


def test_changed_symbols_finds_the_function_containing_a_changed_line(tmp_path):
    root = _repo(tmp_path)
    graph = build(root)
    fd = parse_file_patch(
        "pkg/core.py", "@@ -1,2 +1,2 @@\n-    return value * 2\n+    return value * 3\n"
    )
    # The hunk starts at line 1, so the changed line lands inside `target`.
    assert "pkg/core.py:target" in changed_symbols(graph, fd)


def test_assemble_includes_the_function_body(tmp_path):
    graph = build(_repo(tmp_path))
    text = assemble(graph, "pkg/core.py:target")
    assert "def target(value):" in text
    assert "value * 2" in text


def test_assemble_lists_callers_as_signatures_not_bodies(tmp_path):
    graph = build(_repo(tmp_path))
    text = assemble(graph, "pkg/core.py:target")
    assert "caller_one" in text
    # The signature line is present; the caller's body is not. This is the whole budget policy.
    assert "return target(1)" not in text


def test_assemble_caps_neighbour_count(tmp_path):
    root = tmp_path
    (root / "m.py").write_text(
        "def hot():\n    return 1\n"
        + "".join(f"def c{i}():\n    return hot()\n" for i in range(MAX_NEIGHBOURS + 6))
    )
    graph = build(root)
    text = assemble(graph, "m.py:hot")
    named = [line for line in text.splitlines() if line.strip().startswith("m.py:c")]
    assert len(named) <= MAX_NEIGHBOURS


def test_assemble_says_so_when_there_are_no_edges(tmp_path):
    root = tmp_path
    (root / "lonely.py").write_text("def orphan():\n    return 1\n")
    graph = build(root)
    text = assemble(graph, "lonely.py:orphan")
    # Never "nothing calls this" — the index may simply not know, and MAX_NAME_FANOUT
    # silently drops every edge for common names.
    assert "no callers found in the index" in text


def test_assemble_does_not_mutate_the_graph(tmp_path):
    graph = build(_repo(tmp_path))
    before = graph.stats()
    assemble(graph, "pkg/core.py:target")
    assemble(graph, "pkg/core.py:does-not-exist")
    # calls/called_by are defaultdicts; a bare [] lookup inserts an empty set and inflates stats.
    assert graph.stats() == before


def test_assemble_on_unknown_symbol_returns_empty(tmp_path):
    graph = build(_repo(tmp_path))
    assert assemble(graph, "nope.py:missing") == ""


def test_changed_symbols_ignores_a_diff_that_touches_nothing(tmp_path):
    graph = build(_repo(tmp_path))
    assert changed_symbols(graph, parse_file_patch("pkg/core.py", "")) == []
