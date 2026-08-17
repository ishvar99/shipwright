"""The head state each split must review.

Real pull-request semantics: base B, head H, diff = B->H, and the reviewer sees H's CONTENT
alongside the diff.

  reverse split (positive, bug re-introduced):  B = fixed, H = buggy  -> head IS base_commit
  forward split (negative, the merged fix):     B = buggy, H = fixed  -> head is base+patch

Checking out base_commit for both is right for reverse and wrong for forward. Measured on
Bears-R-Us__arkouda-1969: 100% of the reverse diff's added lines were present on disk against
52% of the forward diff's. The forward reviewer was shown buggy code with a diff claiming to
fix it, reported the real problems it saw, and every one was scored as a false positive.
"""

import subprocess

from shipwright.evals.reviewbench import materialize_head

PATCH = """diff --git a/mod.py b/mod.py
--- a/mod.py
+++ b/mod.py
@@ -1,2 +1,4 @@
 def handler(value):
+    if value is None:
+        raise ValueError("value required")
     return value * 2
"""

ORIGINAL = "def handler(value):\n    return value * 2\n"


def _repo(tmp_path):
    (tmp_path / "mod.py").write_text(ORIGINAL)
    for args in (
        ["init", "-q"],
        ["config", "user.email", "t@t.local"],
        ["config", "user.name", "t"],
        ["add", "-A"],
        ["commit", "-q", "-m", "base"],
    ):
        subprocess.run(["git", *args], cwd=tmp_path, capture_output=True, check=True)
    return tmp_path


def test_forward_applies_the_patch_so_the_head_is_the_fixed_state(tmp_path):
    root = _repo(tmp_path)
    assert materialize_head(root, PATCH, "forward") is True
    content = (root / "mod.py").read_text()
    assert 'raise ValueError("value required")' in content


def test_reverse_leaves_the_worktree_alone(tmp_path):
    root = _repo(tmp_path)
    assert materialize_head(root, PATCH, "reverse") is True
    # base_commit already IS the head for the reverse split; touching it would review the
    # wrong state in the other direction.
    assert (root / "mod.py").read_text() == ORIGINAL


def test_forward_reports_failure_when_the_patch_does_not_apply(tmp_path):
    root = _repo(tmp_path)
    (root / "mod.py").write_text("something else entirely\n")
    assert materialize_head(root, PATCH, "forward") is False


def test_forward_is_a_no_op_on_an_empty_patch(tmp_path):
    root = _repo(tmp_path)
    assert materialize_head(root, "", "forward") is False
    assert (root / "mod.py").read_text() == ORIGINAL
