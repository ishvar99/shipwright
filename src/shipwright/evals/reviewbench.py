"""Reviewbench: does the reviewer find real historical bugs without flooding you?

Construction. Each Loc-Bench row carries the gold fix patch and the pre-fix `base_commit`.
Reviewing the REVERSED patch — a diff that re-introduces the real bug — measures detection
against function-level ground truth. Reviewing the FORWARD patch — the fix the maintainers
merged — measures noise on code known to be good.

Verified before this was written: 67 of 67 sampled gold patches apply forward and reverse
cleanly, and all 67 have every ground-truth file present in the diff.

Two caveats belong next to any number this produces, not in a footnote. A reversed diff reads
as "someone deleted a guard", which is plausibly easier than a naturally written bug. And the
sampled diffs have a median of 18 changed lines, so findings-per-100-lines measured here may
not transfer to real pull requests, and the chunker is barely exercised.
"""

from __future__ import annotations

import re
import subprocess
import time
from datetime import UTC, datetime
from pathlib import Path

from ..codegraph.build import build
from ..db import session
from ..models import ERROR, FAILED, RESOLVED, SKIPPED, Run, TaskResult
from ..review.diff import parse_unified
from ..review.run import ALL_CHECKERS, review_diff
from .locbench import REPOS, LocTask

_HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$")
SCRATCH = Path("evals/reviewbench/wt")


def invert(patch: str) -> str:
    """The reverse diff: what a pull request re-introducing this bug would look like."""
    out = []
    for line in patch.splitlines():
        m = _HUNK.match(line)
        if m:
            old_count = f",{m.group(2)}" if m.group(2) else ""
            new_count = f",{m.group(4)}" if m.group(4) else ""
            out.append(f"@@ -{m.group(3)}{new_count} +{m.group(1)}{old_count} @@{m.group(5)}")
        elif line.startswith(("+++", "---", "diff --git")):
            out.append(line)
        elif line.startswith("+"):
            out.append("-" + line[1:])
        elif line.startswith("-"):
            out.append("+" + line[1:])
        else:
            out.append(line)
    return "\n".join(out) + "\n"


def slice_for(patch: str, path: str) -> str:
    """One file's hunks out of a multi-file patch, matching GitHub's per-file shape."""
    keep, out = False, []
    for line in patch.splitlines():
        if line.startswith("diff --git"):
            keep = line.endswith(f"b/{path}")
            continue
        if not keep or line.startswith(("---", "+++", "index ")):
            continue
        out.append(line)
    return "\n".join(out)


def files_from(patch: str) -> list[dict]:
    return [
        {
            "path": fd.path,
            "status": "modified",
            "patch": slice_for(patch, fd.path),
            "reviewable": True,
        }
        for fd in parse_unified(patch)
    ]


def score(findings: list[dict], spans: dict[str, tuple[int, int]], diff_lines: int) -> dict:
    """Function-level detection, matching the existing Loc-Bench criterion, plus the noise
    measures that decide whether anyone would keep this switched on."""
    gt_files = {sid.split(":", 1)[0] for sid in spans}

    def inside(f: dict) -> bool:
        return any(
            f["path"] == sid.split(":", 1)[0] and lo <= f["line"] <= hi
            for sid, (lo, hi) in spans.items()
        )

    return {
        "detected_func": any(inside(f) for f in findings),
        "detected_file": any(f["path"] in gt_files for f in findings),
        "top1": bool(findings) and inside(findings[0]),
        "n_findings": len(findings),
        "diff_lines": diff_lines,
        "findings_per_100": round(len(findings) * 100 / diff_lines, 2) if diff_lines else 0.0,
    }


def materialize_head(dest: Path, patch: str, direction: str) -> bool:
    """Put the worktree into the state the reviewer should actually see.

    A pull request has a base B and a head H, the diff is B->H, and the reviewer reads H's
    content next to that diff. base_commit is the pre-fix state, so:

      reverse  B = fixed, H = buggy  -> base_commit already IS the head; leave it alone
      forward  B = buggy, H = fixed  -> apply the patch, or the reviewer reads buggy code
                                        while the diff claims to fix it

    Getting this wrong is not cosmetic. Measured on Bears-R-Us__arkouda-1969, only 52% of the
    forward diff's added lines existed on disk against 100% for reverse, and the resulting
    findings — real problems in the pre-fix code — were all scored as false positives.
    """
    if direction != "forward":
        return True
    if not patch.strip():
        return False
    applied = subprocess.run(
        ["git", "apply", "-"],
        input=patch if patch.endswith("\n") else patch + "\n",
        cwd=dest,
        capture_output=True,
        text=True,
        timeout=120,
    )
    return applied.returncode == 0


def _spans(root: Path, edit_functions: list[str]) -> dict[str, tuple[int, int]]:
    graph = build(root)
    out = {}
    for sid in edit_functions:
        sym = graph.symbols.get(sid)
        if sym is not None:
            out[sid] = (sym.start_line, sym.end_line)
    return out


def _changed_lines(patch: str) -> int:
    return sum(
        1
        for ln in patch.splitlines()
        if ln.startswith(("+", "-")) and not ln.startswith(("+++", "---"))
    )


def run_reviewbench(
    tasks: list[LocTask],
    *,
    model_name: str,
    provider,
    checkers: tuple[str, ...] = ALL_CHECKERS,
    direction: str = "reverse",
    notes: str = "",
) -> str:
    """direction: "reverse" (positives, bug re-introduced) or "forward" (negatives, the merged
    fix — anything found there is the noise measurement)."""
    commit = subprocess.run(
        ["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True
    ).stdout.strip()

    with session() as s:
        run = Run(
            suite="reviewbench",
            split=direction,
            scaffold=f"review_{'+'.join(checkers) if checkers else 'ruff_only'}",
            model=model_name if checkers else "none",
            model_tier="local",
            git_commit=commit,
            notes=notes,
            config={
                "direction": direction,
                "checkers": list(checkers),
                "dataset": "czlll/Loc-Bench_V1",
                "instance_ids": [t.instance_id for t in tasks],
            },
        )
        s.add(run)
        s.flush()
        run_id = run.id

    SCRATCH.mkdir(parents=True, exist_ok=True)

    for i, task in enumerate(tasks, 1):
        print(f"[{i}/{len(tasks)}] {task.instance_id}", flush=True)
        started = time.perf_counter()
        result = TaskResult(run_id=run_id, task_id=task.instance_id, status=FAILED)
        repo = REPOS / task.repo.replace("/", "__")
        # Absolute: `git worktree add` runs with cwd=repo, so a relative destination would
        # be created inside the vendored clone rather than under our scratch directory.
        dest = (SCRATCH / task.instance_id).resolve()
        try:
            if not (repo / ".git").exists():
                result.status = SKIPPED
                result.skip_reason = "repo_not_cloned"
                raise RuntimeError("repo not cloned")
            if not task.patch:
                result.status = SKIPPED
                result.skip_reason = "no_gold_patch"
                raise RuntimeError("no gold patch")
            added = subprocess.run(
                ["git", "worktree", "add", "--detach", "-f", str(dest), task.base_commit],
                cwd=repo,
                capture_output=True,
                text=True,
                timeout=900,
            )
            if added.returncode != 0 or not dest.exists():
                result.status = SKIPPED
                # Carry git's own reason. A bare "worktree_failed" hid a path bug across a
                # whole run: every task skipped and nothing said why.
                result.skip_reason = f"worktree: {(added.stderr or '').strip()[-90:]}"
                raise RuntimeError("worktree failed")

            patch = task.patch if direction == "forward" else invert(task.patch)
            if not materialize_head(dest, task.patch, direction):
                result.status = SKIPPED
                result.skip_reason = "head_state_unbuildable"
                raise RuntimeError("could not build the head state")
            out = review_diff(
                root=dest,
                files=files_from(patch),
                intent=task.problem_statement[:2000],
                model=provider,
                checkers=checkers,
            )
            metrics = score(
                out["findings"], _spans(dest, task.edit_functions), _changed_lines(patch)
            )

            # On the forward (negative) split detection is not the goal: any finding is noise.
            result.status = (
                RESOLVED
                if (metrics["detected_func"] if direction == "reverse" else not out["findings"])
                else FAILED
            )
            result.input_tokens = out["usage"]["input_tokens"]
            result.output_tokens = out["usage"]["output_tokens"]
            result.tool_calls = out["usage"]["calls"]
            result.metrics = {
                "evaluated": True,
                **metrics,
                "parse_failures": out["usage"]["parse_failures"],
                "provider_failures": out["usage"]["provider_failures"],
                "degraded": out["coverage"]["degraded"],
                "tier": out["coverage"]["tier"],
                "category": task.category,
                "ground_truth": task.edit_functions,
            }
            print(
                f"    detect={'Y' if metrics['detected_func'] else 'n'} "
                f"top1={'Y' if metrics['top1'] else 'n'} "
                f"findings={metrics['n_findings']} /100L={metrics['findings_per_100']}",
                flush=True,
            )
        except Exception as e:
            if result.status != SKIPPED:
                result.status = ERROR
                result.error = f"{type(e).__name__}: {e}"[:1000]
            print(f"    {result.status}: {result.skip_reason or result.error}", flush=True)
        finally:
            subprocess.run(
                ["git", "worktree", "remove", "--force", str(dest)],
                cwd=repo,
                capture_output=True,
                timeout=300,
            )

        result.wall_ms = int((time.perf_counter() - started) * 1000)
        with session() as s:
            s.add(result)

    with session() as s:
        s.get(Run, run_id).finished_at = datetime.now(UTC)
    return str(run_id)
