from shipwright.review.diff import parse_unified
from shipwright.review.merge import MAX_FINDINGS, merge
from shipwright.review.render import to_github_review, to_markdown

PATCH = """diff --git a/a.py b/a.py
--- a/a.py
+++ b/a.py
@@ -1,2 +1,4 @@
 import os
+import subprocess
+SECRET = "x"
 def f():
"""

COVERAGE = {"files": 1, "reviewed": 1, "unreviewed": [], "degraded": [], "tier": "graph"}


def _f(line, **kw):
    base = {
        "path": "a.py",
        "line": line,
        "end_line": line,
        "side": "RIGHT",
        "category": "security",
        "severity": "high",
        "title": "t",
        "body": "b",
        "evidence": [],
        "source": "llm",
        "rule": "",
    }
    base.update(kw)
    return base


def test_finding_outside_the_diff_is_dropped():
    kept = merge([_f(2), _f(999)], parse_unified(PATCH))
    assert [f["line"] for f in kept] == [2]


def test_finding_on_the_wrong_side_is_dropped():
    assert merge([_f(2, side="LEFT")], parse_unified(PATCH)) == []


def test_duplicate_line_and_category_merge_into_one():
    kept = merge([_f(2, source="llm"), _f(2, source="ruff", rule="S404")], parse_unified(PATCH))
    assert len(kept) == 1


def test_agreement_across_sources_is_recorded():
    kept = merge([_f(2, source="llm"), _f(2, source="ruff", rule="S404")], parse_unified(PATCH))
    assert kept[0]["agreed"] is True


def test_one_source_twice_is_not_agreement():
    kept = merge([_f(2, source="llm"), _f(2, source="llm")], parse_unified(PATCH))
    assert kept[0]["agreed"] is False


def test_different_categories_on_one_line_both_survive():
    kept = merge([_f(2, category="security"), _f(2, category="quality")], parse_unified(PATCH))
    assert len(kept) == 2


def test_high_severity_outranks_low():
    kept = merge(
        [_f(2, severity="low", category="quality"), _f(3, severity="high")], parse_unified(PATCH)
    )
    assert kept[0]["severity"] == "high"


def test_merging_keeps_the_worst_severity():
    kept = merge(
        [_f(2, severity="low", source="llm"), _f(2, severity="high", source="ruff")],
        parse_unified(PATCH),
    )
    assert kept[0]["severity"] == "high"


def test_total_is_capped():
    many = [_f(2, category=f"c{i}") for i in range(MAX_FINDINGS + 10)]
    assert len(merge(many, parse_unified(PATCH))) == MAX_FINDINGS


def test_markdown_names_file_and_line():
    md = to_markdown([_f(2)], COVERAGE)
    assert "a.py" in md and "2" in md


def test_markdown_says_so_when_nothing_was_found():
    md = to_markdown([], {**COVERAGE, "files": 3, "reviewed": 3})
    assert "No blocking findings" in md
    # Silence must be evidence, so the empty state states what was checked.
    assert "3" in md


def test_markdown_names_degraded_checks():
    md = to_markdown([], {**COVERAGE, "degraded": ["security"]})
    assert "security" in md


def test_github_payload_is_a_comment_event_never_an_approval():
    payload = to_github_review([_f(2)], "abc123", COVERAGE)
    assert payload["event"] == "COMMENT"
    assert payload["commit_id"] == "abc123"
    assert payload["body"]


def test_github_payload_comments_carry_path_line_and_side():
    payload = to_github_review([_f(2)], "abc123", COVERAGE)
    c = payload["comments"][0]
    assert c["path"] == "a.py"
    assert c["line"] == 2
    assert c["side"] == "RIGHT"
    assert c["body"]


def test_github_payload_with_no_findings_still_has_a_body():
    # A COMMENT-event review requires a body; an empty one is a 422.
    payload = to_github_review([], "abc123", COVERAGE)
    assert payload["body"]
    assert payload["comments"] == []
