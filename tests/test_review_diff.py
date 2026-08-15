from shipwright.review.diff import (
    FileDiff,
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
