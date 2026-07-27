"""Loc-Bench: 560 curated issues with function-level ground truth.

Localization needs no code execution, which makes it the benchmark that actually fits a
free local tier. Scoring follows LocAgent: Acc@k counts a task correct only if *all*
ground-truth locations appear in the top k.
"""

from __future__ import annotations

import json
import subprocess
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from ..codegraph.build import build
from ..codegraph.retrieve import Localizer
from ..db import session
from ..models import ERROR, FAILED, RESOLVED, SKIPPED, Run, TaskResult

DATASET = "czlll/Loc-Bench_V1"
CACHE = Path("evals/locbench/data")
REPOS = Path("evals/locbench/repos")


@dataclass
class LocTask:
    instance_id: str
    repo: str
    base_commit: str
    problem_statement: str
    edit_functions: list[str]
    category: str

    @property
    def gt_files(self) -> set[str]:
        return {f.split(":", 1)[0] for f in self.edit_functions}


def fetch(limit: int | None = None) -> list[LocTask]:
    CACHE.mkdir(parents=True, exist_ok=True)
    cached = CACHE / "test.jsonl"
    if not cached.exists():
        from datasets import load_dataset

        ds = load_dataset(DATASET, split="test")
        with cached.open("w") as f:
            for row in ds:
                f.write(json.dumps(row, default=str) + "\n")

    tasks = []
    with cached.open() as f:
        for line in f:
            r = json.loads(line)
            tasks.append(
                LocTask(
                    instance_id=r["instance_id"],
                    repo=r["repo"],
                    base_commit=r["base_commit"],
                    problem_statement=r["problem_statement"],
                    edit_functions=list(r.get("edit_functions") or []),
                    category=r.get("category", ""),
                )
            )
    tasks = [t for t in tasks if t.edit_functions]
    tasks.sort(key=lambda t: t.instance_id)
    return tasks[:limit] if limit else tasks


def _run(cmd: list[str], cwd: Path | None = None, timeout: int = 600) -> bool:
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    return r.returncode == 0


def checkout(task: LocTask) -> Path | None:
    """Blobless partial clone, then fetch just the one commit. Repos are cached and
    reused across instances; only the checkout changes."""
    dest = REPOS / task.repo.replace("/", "__")
    dest.parent.mkdir(parents=True, exist_ok=True)
    url = f"https://github.com/{task.repo}.git"

    if not (dest / ".git").exists():
        if not _run(["git", "clone", "--filter=blob:none", "--no-checkout", url, str(dest)]):
            return None

    if not _run(["git", "fetch", "--depth", "1", "origin", task.base_commit], cwd=dest):
        return None
    if not _run(["git", "checkout", "--force", task.base_commit], cwd=dest):
        return None
    return dest


def _acc_at_k(predicted: list[str], truth: set[str], k: int) -> bool:
    """Strict: every ground-truth location must appear in the top k."""
    return truth.issubset(set(predicted[:k])) if truth else False


def run_locbench(
    tasks: list[LocTask], *, mode: str = "hybrid", top_k: int = 10, notes: str = ""
) -> str:
    commit = subprocess.run(
        ["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True
    ).stdout.strip()

    with session() as s:
        run = Run(
            suite="locbench",
            split="test",
            scaffold=f"retrieval_{mode}",
            model="none",  # pure retrieval: no inference, no cost
            model_tier="local",
            git_commit=commit,
            notes=notes,
            config={
                "mode": mode,
                "top_k": top_k,
                "dataset": DATASET,
                "instance_ids": [t.instance_id for t in tasks],
            },
        )
        s.add(run)
        s.flush()
        run_id = run.id

    for i, task in enumerate(tasks, 1):
        print(f"[{i}/{len(tasks)}] {task.instance_id}", flush=True)
        started = time.perf_counter()
        result = TaskResult(run_id=run_id, task_id=task.instance_id, status=FAILED)

        try:
            repo = checkout(task)
            if repo is None:
                result.status = SKIPPED
                result.skip_reason = "checkout_failed"
                raise RuntimeError("checkout failed")

            graph = build(repo)
            ranked = Localizer(graph).localize(task.problem_statement, mode=mode, top_k=top_k)
            pred_funcs = [r.symbol_id for r in ranked]
            pred_files = list(dict.fromkeys(p.split(":", 1)[0] for p in pred_funcs))

            file_5 = _acc_at_k(pred_files, task.gt_files, 5)
            func_10 = _acc_at_k(pred_funcs, set(task.edit_functions), 10)
            any_hit = bool(set(pred_funcs[:top_k]) & set(task.edit_functions))

            # Function-level Acc@10 is the headline metric, matching LocAgent.
            result.status = RESOLVED if func_10 else FAILED
            result.metrics = {
                "evaluated": True,
                "file_acc_at_5": file_5,
                "func_acc_at_10": func_10,
                "any_hit": any_hit,
                "n_gt": len(task.edit_functions),
                "category": task.category,
                "graph": graph.stats(),
                "predicted": pred_funcs[:top_k],
                "ground_truth": task.edit_functions,
            }
            print(
                f"    file@5={'Y' if file_5 else 'n'} func@10={'Y' if func_10 else 'n'} "
                f"any={'Y' if any_hit else 'n'} · {graph.stats()['symbols']} symbols",
                flush=True,
            )
        except Exception as e:
            if result.status != SKIPPED:
                result.status = ERROR
                result.error = f"{type(e).__name__}: {e}"[:1000]
            print(f"    {result.status}: {result.skip_reason or result.error}", flush=True)

        result.wall_ms = int((time.perf_counter() - started) * 1000)
        with session() as s:
            s.add(result)

    with session() as s:
        s.get(Run, run_id).finished_at = datetime.now(UTC)
    return str(run_id)
