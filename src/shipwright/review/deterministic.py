"""Static checks that need no model, and the evaluation's null hypothesis.

Ruff already carries the flake8-bandit ruleset, so this needs no new dependency — 73 `S`
rules plus blind-except and the bugbear subset. The ruleset is curated deliberately: the
broad selection produced 113 findings on this repository's own `src/`, of which 47 were
TRY003, a style opinion. A reviewer that reports style opinions as defects is the exact
failure this project is trying to measure away.
"""

from __future__ import annotations

import json
import logging
import subprocess
from pathlib import Path

log = logging.getLogger("shipwright.review")

TIMEOUT_S = 60

# What we select, and the category each maps to. Prefixes are resolved longest-first, so
# BLE001 wins over a bare B.
RULES: dict[str, str] = {
    "S": "security",
    "BLE001": "error_handling",
    "B904": "error_handling",  # raise without `from` inside an except block
    "B012": "error_handling",  # break/return in finally silently swallows the exception
    "B006": "quality",  # mutable default argument
    "B008": "quality",  # function call in a default argument
    "ASYNC": "error_handling",
}

# S101 is `assert` — correct and ubiquitous in tests, and noise everywhere else.
IGNORE = ("S101",)


def _category(code: str) -> str:
    if code in RULES:
        return RULES[code]
    for prefix in sorted(RULES, key=len, reverse=True):
        if code.startswith(prefix):
            return RULES[prefix]
    return "quality"


def run_ruff(root: Path, rel_paths: list[str]) -> list[dict]:
    """Findings for the given files, relative to `root`.

    `--isolated` so the reviewed repository's own configuration cannot switch the reviewer
    off; inline `# noqa` is still honoured, because that is the author speaking about one
    specific line rather than setting a project-wide default.
    """
    root = Path(root)
    targets = [p for p in rel_paths if (root / p).is_file()]
    if not targets:
        return []

    cmd = [
        "ruff",
        "check",
        "--isolated",
        "--no-cache",
        "--output-format",
        "json",
        "--select",
        ",".join(sorted(RULES)),
        "--ignore",
        ",".join(IGNORE),
        *targets,
    ]
    try:
        proc = subprocess.run(cmd, cwd=root, capture_output=True, text=True, timeout=TIMEOUT_S)
    except (OSError, subprocess.TimeoutExpired):
        log.exception("ruff failed under %s", root)
        return []

    # Exit 1 means "findings exist", which is the normal success path here. Only >=2 is an
    # error; treating 1 as failure would return nothing exactly when there was something.
    if proc.returncode >= 2:
        log.warning("ruff exited %s: %s", proc.returncode, proc.stderr[-200:])
        return []
    try:
        rows = json.loads(proc.stdout or "[]")
    except json.JSONDecodeError:
        return []

    out = []
    for r in rows:
        code = r.get("code") or ""
        line = (r.get("location") or {}).get("row") or 0
        end = (r.get("end_location") or {}).get("row") or line
        try:
            path = str(Path(r["filename"]).resolve().relative_to(root.resolve()))
        except (ValueError, KeyError):
            continue
        message = r.get("message") or ""
        out.append(
            {
                "path": path,
                "line": line,
                "end_line": end,
                "side": "RIGHT",
                "category": _category(code),
                "severity": "medium" if code.startswith("S") else "low",
                "title": message[:80],
                "body": message,
                "evidence": [],
                "source": "ruff",
                "rule": code,
            }
        )
    return out
