from shipwright.review.diff import (
    FileDiff,
    excerpt,
    parse_file_patch,
    parse_unified,
    postable,
)

# One file's patch exactly as GitHub's /pulls/{n}/files returns it: hunks only, no
# "diff --git" header.
GH_PATCH = """@@ -10,6 +10,7 @@ def handler(req):
     name = req.get("name")
-    return lookup(name)
+    if name is None:
+        raise ValueError("name required")
+    return lookup(name)
"""

# A full multi-file patch, as the gold patches in Loc-Bench are shaped.
FULL_PATCH = """diff --git a/pkg/a.py b/pkg/a.py
--- a/pkg/a.py
+++ b/pkg/a.py
@@ -1,3 +1,4 @@
 import os
+import sys

 def f():
diff --git a/pkg/b.py b/pkg/b.py
--- a/pkg/b.py
+++ b/pkg/b.py
@@ -5,4 +5,3 @@ def g():
     x = 1
-    y = 2
     return x
"""


def test_parse_file_patch_counts_and_path():
    fd = parse_file_patch("api/handler.py", GH_PATCH)
    assert fd.path == "api/handler.py"
    assert fd.additions == 3
    assert fd.deletions == 1


def test_added_line_numbers_are_new_side():
    fd = parse_file_patch("api/handler.py", GH_PATCH)
    # Hunk starts at new line 10: context 10, then three additions at 11, 12, 13.
    assert fd.added_lines == frozenset({11, 12, 13})


def test_deleted_line_numbers_are_old_side():
    fd = parse_file_patch("api/handler.py", GH_PATCH)
    # The removed line sat at old line 11.
    assert fd.deleted_lines == frozenset({11})


def test_parse_unified_splits_files():
    diffs = parse_unified(FULL_PATCH)
    assert [d.path for d in diffs] == ["pkg/a.py", "pkg/b.py"]
    assert diffs[0].added_lines == frozenset({2})
    assert diffs[1].deleted_lines == frozenset({6})


def test_postable_covers_both_sides():
    diffs = parse_unified(FULL_PATCH)
    p = postable(diffs)
    assert ("pkg/a.py", 2, "RIGHT") in p
    assert ("pkg/b.py", 6, "LEFT") in p
    # A line that is merely nearby was never in the diff and cannot carry a comment.
    assert ("pkg/a.py", 99, "RIGHT") not in p


def test_empty_and_missing_patch_are_not_errors():
    # GitHub omits `patch` on very large files; that must be an empty diff, not a crash.
    assert parse_file_patch("big.bin", "").added_lines == frozenset()
    assert parse_unified("") == []


def test_malformed_hunk_header_is_skipped_not_fatal():
    fd = parse_file_patch("x.py", "@@ nonsense @@\n+a\n")
    assert fd.added_lines == frozenset()


def test_changed_line_count_is_additions_plus_deletions():
    fd = parse_file_patch("api/handler.py", GH_PATCH)
    assert fd.changed == 4
    assert FileDiff(path="e.py", hunks=(), additions=0, deletions=0).changed == 0


EXC_PATCH = """@@ -10,4 +10,6 @@ def handler(req):
     name = req.get("name")
-    return lookup(name)
+    if name is None:
+        raise ValueError("name required")
+    return lookup(name)
 """


def test_excerpt_returns_the_containing_hunk_with_header():
    fd = parse_file_patch("a.py", EXC_PATCH)
    out = excerpt(fd, 12, "RIGHT")
    assert out.startswith("@@")
    assert 'raise ValueError("name required")' in out


def test_excerpt_is_side_aware_across_hunks():
    # Two hunks whose old/new numbering diverges: the side must pick the hunk.
    # Hunk A deletes at old 11-12; hunk B adds at new 39-40.
    patch = (
        "@@ -10,3 +10,1 @@\n context\n-gone one\n-gone two\n"
        "@@ -40,1 +38,3 @@\n context\n+added one\n+added two\n"
    )
    fd = parse_file_patch("a.py", patch)
    assert "added one" in excerpt(fd, 39, "RIGHT")
    # New line 39 exists only on the RIGHT; a side-blind excerpt would still match here.
    assert excerpt(fd, 39, "LEFT") == ""
    assert "gone two" in excerpt(fd, 12, "LEFT")
    assert excerpt(fd, 12, "RIGHT") == ""


def test_excerpt_outside_every_hunk_is_empty():
    fd = parse_file_patch("a.py", EXC_PATCH)
    assert excerpt(fd, 999, "RIGHT") == ""


def test_excerpt_is_bounded_on_a_giant_hunk():
    lines = "\n".join(f"+line {i}" for i in range(1, 201))
    fd = parse_file_patch("big.py", f"@@ -1,0 +1,200 @@\n{lines}\n")
    out = excerpt(fd, 100, "RIGHT")
    assert len(out.splitlines()) == 41  # header + exactly 40 lines
    assert "line 100" in out


def test_excerpt_late_anchor_still_gets_a_full_window():
    lines = "\n".join(f"+line {i}" for i in range(1, 201))
    fd = parse_file_patch("big.py", f"@@ -1,0 +1,200 @@\n{lines}\n")
    out = excerpt(fd, 200, "RIGHT")
    assert len(out.splitlines()) == 41  # header + exactly 40
    assert "line 200" in out
    assert "clipped" in out.splitlines()[0]
