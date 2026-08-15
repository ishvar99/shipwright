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
import shutil
import subprocess
import sys
from pathlib import Path

log = logging.getLogger("shipwright.review")

TIMEOUT_S = 60


class RuffUnavailable(RuntimeError):
    """Ruff could not be run at all. Raised rather than returned as 'no findings', so the
    stage runner marks the review degraded instead of reporting a clean file."""


def _ruff_cmd() -> list[str]:
    """Resolve ruff without depending on PATH.

    `ruff` on PATH only works when something has activated the virtualenv — true under
    `uv run`, false for a bare interpreter and false in a container that launches uvicorn
    directly. Preferring the module keeps it working wherever this process's own interpreter
    can import it.
    """
    if shutil.which("ruff"):
        return ["ruff"]
    binary = Path(sys.executable).with_name("ruff")
    if binary.is_file():
        return [str(binary)]
    return [sys.executable, "-m", "ruff"]


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
        *_ruff_cmd(),
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
    # Raised, never swallowed into an empty list: "ruff could not run" and "ruff found
    # nothing" are opposite facts, and reporting the first as the second would let the
    # deterministic layer silently vanish while the review still called itself complete.
    try:
        proc = subprocess.run(cmd, cwd=root, capture_output=True, text=True, timeout=TIMEOUT_S)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise RuffUnavailable(f"could not run ruff under {root}") from e

    # Exit 1 means "findings exist", which is the normal success path here. Only >=2 is an
    # error; treating 1 as failure would return nothing exactly when there was something.
    if proc.returncode >= 2:
        raise RuffUnavailable(f"ruff exited {proc.returncode}: {proc.stderr[-200:]}")
    try:
        rows = json.loads(proc.stdout or "[]")
    except json.JSONDecodeError as e:
        raise RuffUnavailable("ruff produced output we could not parse") from e

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
