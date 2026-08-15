from shipwright.evals.reviewbench import invert, score, slice_for


def test_invert_swaps_addition_and_deletion():
    out = invert("@@ -1,2 +1,2 @@\n-old\n+new\n")
    assert "-new" in out
    assert "+old" in out


def test_invert_swaps_the_hunk_counts():
    assert "@@ -1,3 +1,5 @@" in invert("@@ -1,5 +1,3 @@\n context\n")


def test_invert_leaves_file_headers_alone():
    out = invert("--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n-a\n+b\n")
    assert "--- a/x.py" in out
    assert "+++ b/x.py" in out


def test_invert_is_its_own_inverse():
    patch = "diff --git a/x.py b/x.py\n@@ -1,2 +1,3 @@\n keep\n-gone\n+added\n"
    assert invert(invert(patch)).strip() == patch.strip()


def test_slice_for_extracts_one_file_from_a_multi_file_patch():
    patch = (
        "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1 +1,2 @@\n x\n+ay\n"
        "diff --git a/b.py b/b.py\n--- a/b.py\n+++ b/b.py\n@@ -1 +1,2 @@\n x\n+by\n"
    )
    out = slice_for(patch, "b.py")
    assert "+by" in out
    assert "+ay" not in out


def test_score_counts_a_hit_inside_a_ground_truth_function():
    out = score(
        [{"path": "pkg/a.py", "line": 12, "severity": "high"}],
        {"pkg/a.py:target": (10, 20)},
        diff_lines=8,
    )
    assert out["detected_func"] is True
    assert out["detected_file"] is True
    assert out["top1"] is True


def test_score_counts_a_file_hit_that_misses_the_function():
    out = score(
        [{"path": "pkg/a.py", "line": 99, "severity": "high"}],
        {"pkg/a.py:target": (10, 20)},
        diff_lines=8,
    )
    assert out["detected_func"] is False
    assert out["detected_file"] is True


def test_score_reports_findings_per_hundred_lines():
    findings = [{"path": "a.py", "line": 1, "severity": "low"}] * 4
    assert score(findings, {}, diff_lines=200)["findings_per_100"] == 2.0


def test_score_of_nothing_is_not_a_division_error():
    out = score([], {}, diff_lines=0)
    assert out["findings_per_100"] == 0.0
    assert out["detected_func"] is False


def test_top1_is_false_when_the_best_finding_is_elsewhere():
    out = score(
        [
            {"path": "other.py", "line": 1, "severity": "high"},
            {"path": "pkg/a.py", "line": 12, "severity": "low"},
        ],
        {"pkg/a.py:target": (10, 20)},
        diff_lines=10,
    )
    assert out["detected_func"] is True
    assert out["top1"] is False


def test_unresolvable_ground_truth_cannot_be_scored_as_a_hit():
    # A ground-truth symbol the graph could not resolve contributes no span, so nothing
    # can land "inside" it. Silently treating that as a hit would inflate detection.
    out = score([{"path": "pkg/a.py", "line": 12, "severity": "high"}], {}, diff_lines=8)
    assert out["detected_func"] is False
