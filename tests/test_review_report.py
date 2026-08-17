"""The reviewbench suite must not borrow the Loc-Bench table.

`_pct` divides by the attempted count, so a run whose rows never recorded a key renders a
measured-looking 0.0%. That is exactly the fabricated number report.py refuses to print, so
reviewbench gets its own aggregation that answers "—" instead.
"""

from datetime import UTC, datetime

from shipwright.evals.report_html import _pct, _review_pct, review_table


class _Row:
    def __init__(self, metrics, status="resolved"):
        self.metrics = metrics
        self.status = status


class _Run:
    suite = "reviewbench"
    scaffold = "review_security+quality"
    split = "reverse"
    model = "qwen2.5-coder-7b-16k"
    git_commit = "abc1234"
    started_at = datetime(2026, 8, 15, tzinfo=UTC)


def test_missing_metric_renders_nothing_rather_than_zero():
    rows = [_Row({"n_findings": 1})]
    assert _review_pct(rows, "detected_func") is None
    # The trap this exists to avoid: the Loc-Bench helper reports a confident 0.0 instead.
    assert _pct(rows, "detected_func") == 0.0


def test_present_metric_is_averaged_over_rows_that_have_it():
    rows = [_Row({"detected_func": True}), _Row({"detected_func": False})]
    assert _review_pct(rows, "detected_func") == 50.0


def test_rows_lacking_the_key_do_not_dilute_the_rate():
    # A row that never recorded the metric is not evidence of failure.
    rows = [_Row({"detected_func": True}), _Row({"n_findings": 3})]
    assert _review_pct(rows, "detected_func") == 100.0


def test_skipped_rows_are_excluded():
    rows = [_Row({"detected_func": True}), _Row({"detected_func": False}, status="skipped")]
    assert _review_pct(rows, "detected_func") == 100.0


def test_empty_rows_give_none():
    assert _review_pct([], "detected_func") is None


def test_table_renders_a_dash_for_a_missing_metric():
    html = review_table([{"run": _Run(), "n": 5, "detect": None, "top1": None, "per100": None}])
    assert "—" in html
    assert "0.0%" not in html


def test_table_shows_the_split_so_noise_is_not_read_as_detection():
    html = review_table([{"run": _Run(), "n": 5, "detect": 37.5, "top1": 12.5, "per100": 1.03}])
    assert "reverse" in html
    assert "37.5%" in html
    assert "1.03" in html
