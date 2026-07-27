"""SWE-bench-Live task loading.

The `lite` split (300 tasks) is frozen upstream, which is why it is the comparable
target. Task images are linux/amd64 only, so on Apple Silicon they run emulated.
"""

import json
import random
from dataclasses import dataclass
from pathlib import Path

DATASET = "SWE-bench-Live/SWE-bench-Live"
IMAGE_NAMESPACE = "starryzhang"
CACHE = Path("evals/data")


@dataclass
class Task:
    instance_id: str
    repo: str
    base_commit: str
    problem_statement: str
    fail_to_pass: list[str]
    pass_to_pass: list[str]
    test_cmds: list[str]
    lines_changed: int

    @property
    def image(self) -> str:
        # SWE-bench tag convention: `__` becomes `_1776_`.
        slug = self.instance_id.replace("__", "_1776_")
        return f"{IMAGE_NAMESPACE}/sweb.eval.x86_64.{slug}:latest"


def _to_task(row: dict) -> Task:
    return Task(
        instance_id=row["instance_id"],
        repo=row["repo"],
        base_commit=row["base_commit"],
        problem_statement=row["problem_statement"],
        fail_to_pass=list(row.get("FAIL_TO_PASS") or []),
        pass_to_pass=list(row.get("PASS_TO_PASS") or []),
        test_cmds=list(row.get("test_cmds") or []),
        lines_changed=(row.get("difficulty") or {}).get("lines", 0),
    )


def fetch(split: str = "lite") -> list[Task]:
    """Download once, then serve from a local JSONL cache."""
    CACHE.mkdir(parents=True, exist_ok=True)
    cached = CACHE / f"{split}.jsonl"

    if not cached.exists():
        from datasets import load_dataset

        ds = load_dataset(DATASET, split=split)
        with cached.open("w") as f:
            for row in ds:
                f.write(json.dumps(row, default=str) + "\n")

    with cached.open() as f:
        return [_to_task(json.loads(line)) for line in f]


def subset(tasks: list[Task], n: int, *, seed: int = 0, order: str = "shuffle") -> list[Task]:
    """Deterministic selection. Default is a seeded shuffle so nothing is cherry-picked;
    `easiest` sorts by patch size and is for smoke-testing the pipeline only."""
    ordered = sorted(tasks, key=lambda t: t.instance_id)
    if order == "easiest":
        ordered.sort(key=lambda t: t.lines_changed)
    else:
        random.Random(seed).shuffle(ordered)
    return ordered[:n]
