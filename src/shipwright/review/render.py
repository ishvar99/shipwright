"""Findings as prose, and as a GitHub review payload.

The empty state is a confident state: "no blocking findings" says what was checked, so
silence reads as evidence rather than as absence.
"""

from __future__ import annotations

_LABEL = {"high": "High", "medium": "Medium", "low": "Minor"}


def coverage_line(coverage: dict) -> str:
    reviewed, files = coverage.get("reviewed", 0), coverage.get("files", 0)
    line = f"Reviewed {reviewed} of {files} changed files."
    unreviewed = coverage.get("unreviewed") or []
    if unreviewed:
        shown = ", ".join(sorted(unreviewed)[:5])
        line += f" Not reviewed: {shown}"
        line += f" and {len(unreviewed) - 5} more." if len(unreviewed) > 5 else "."
    degraded = coverage.get("degraded") or []
    if degraded:
        line += f" These checks did not complete: {', '.join(sorted(degraded))}."
    tier = coverage.get("tier")
    if tier == "window":
        line += " No call graph for this language, so findings are scoped to the changed files."
    elif tier == "none":
        # Say what actually happened. Blaming the language here would be a false reason.
        line += " Static checks only — no model review ran."
    return line


def to_markdown(findings: list[dict], coverage: dict) -> str:
    head = "## Shipwright review"
    if not findings:
        return f"{head}\n\nNo blocking findings. {coverage_line(coverage)}"
    rows = [
        f"- **{_LABEL[f['severity']]}** · `{f['path']}:{f['line']}` — {f['title']}\n  {f['body']}"
        for f in findings
    ]
    return f"{head}\n\n{coverage_line(coverage)}\n\n" + "\n".join(rows)


def _comment_body(f: dict) -> str:
    label = _LABEL[f["severity"]]
    category = f["category"].replace("_", " ")
    body = f"**{label} · {category}** — {f['title']}\n\n{f['body']}"
    if f.get("rule"):
        body += f"\n\n<sub>ruff {f['rule']}</sub>"
    if f.get("agreed"):
        body += "\n\n<sub>Flagged independently by more than one check.</sub>"
    return body


def to_github_review(findings: list[dict], commit_id: str, coverage: dict) -> dict:
    """One review object.

    Always COMMENT — never APPROVE, never REQUEST_CHANGES — so the reviewer can annotate but
    structurally cannot block or bless a merge. `body` is always populated because GitHub
    rejects a COMMENT-event review without one.
    """
    summary = (
        f"Shipwright found {len(findings)} thing(s) worth a look. {coverage_line(coverage)}"
        if findings
        else f"No blocking findings. {coverage_line(coverage)}"
    )
    return {
        "commit_id": commit_id,
        "event": "COMMENT",
        "body": summary,
        "comments": [
            {
                "path": f["path"],
                "line": f["line"],
                "side": f.get("side", "RIGHT"),
                "body": _comment_body(f),
            }
            for f in findings
        ],
    }
