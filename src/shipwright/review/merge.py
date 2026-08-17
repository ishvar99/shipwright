"""Gate, dedupe, rank, cap.

The gate is the reason this feature can be trusted. A model asked to review a diff will
comment on the untouched code around it, and GitHub rejects a comment on a line outside the
diff — rejecting the whole batched review with it. Dropping those findings here is both the
noise control and the thing that makes posting possible at all.
"""

from __future__ import annotations

from .diff import FileDiff, postable

MAX_FINDINGS = 25
_RANK = {"high": 0, "medium": 1, "low": 2}


def merge(findings: list[dict], diffs: list[FileDiff]) -> list[dict]:
    """Keep only postable findings, collapse duplicates, order by what matters, cap."""
    allowed = postable(diffs)
    kept: dict[tuple[str, int, str], dict] = {}

    for f in findings:
        if (f["path"], f["line"], f.get("side", "RIGHT")) not in allowed:
            continue
        key = (f["path"], f["line"], f["category"])
        existing = kept.get(key)
        if existing is None:
            kept[key] = {**f, "agreed": False}
            continue
        # Two checkers on the same line is corroboration, not two findings. Agreement
        # promotes the finding rather than doubling the noise.
        if existing["source"] != f["source"]:
            existing["agreed"] = True
        if _RANK[f["severity"]] < _RANK[existing["severity"]]:
            existing["severity"] = f["severity"]

    ordered = sorted(
        kept.values(),
        key=lambda f: (_RANK[f["severity"]], not f["agreed"], f["path"], f["line"]),
    )
    return ordered[:MAX_FINDINGS]
