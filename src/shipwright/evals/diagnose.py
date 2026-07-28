"""Why did a localization run fail?

73.3% file@5 held across two retrieval bases 13 points apart, which says the remaining
failures are not a ranking problem. This splits them into causes that need different
fixes — or that cannot be fixed at all.

Categories, checked in order per ground-truth location:
  file_absent_at_base  the file does not exist at base_commit — the fix creates it,
                       so no retriever over the pre-fix tree can ever find it
  file_unparsed        file exists but produced no symbols (parse failure, or not .py)
  symbol_missing       file parsed but the symbol id is absent — a parser gap
  not_retrieved        symbol is in the graph but never entered the candidate pool
  ranked_out           retrieved, ranked outside top-k (a genuine ranking miss)
"""

from __future__ import annotations

from collections import Counter

from rich.console import Console
from rich.table import Table
from sqlalchemy import String, cast, select

from ..codegraph.build import build
from ..codegraph.retrieve import Localizer
from ..db import session
from ..models import SKIPPED, Run, TaskResult
from .locbench import checkout, fetch

console = Console()

CAUSES = (
    "file_absent_at_base",
    "file_unparsed",
    "symbol_missing",
    "not_retrieved",
    "ranked_out",
)


def _classify(gt: str, graph, repo, predicted: list[str]) -> str:
    path, _, name = gt.partition(":")
    if not (repo / path).exists():
        return "file_absent_at_base"
    if path not in graph.files:
        return "file_unparsed"
    if gt not in graph.symbols:
        return "symbol_missing"
    if gt in predicted:
        return "ranked_out"  # present in top-k but the task still failed on another gt
    return "not_retrieved"


def _gt_depth(graph, issue: str, gts: list[str], base_mode: str, depth: int) -> list[int | None]:
    """How deep in the full ranking does each ground-truth symbol actually sit?
    `not_retrieved` alone cannot distinguish rank 11 from rank 5000, and those need
    completely different fixes."""
    ranked = Localizer(graph).localize(issue, mode=base_mode, top_k=depth)
    order = {r.symbol_id: i + 1 for i, r in enumerate(ranked)}
    return [order.get(gt) for gt in gts]


def diagnose(run_id: str, limit: int | None = None, depth: int = 0) -> None:
    tasks = {t.instance_id: t for t in fetch()}

    with session() as s:
        run = s.scalars(select(Run).where(cast(Run.id, String).like(f"{run_id}%"))).first()
        if not run:
            console.print(f"[red]no run matching {run_id}[/]")
            return
        rows = s.scalars(
            select(TaskResult).where(TaskResult.run_id == run.id).order_by(TaskResult.task_id)
        ).all()

    failed = [
        r for r in rows if r.status != SKIPPED and not (r.metrics or {}).get("func_acc_at_10")
    ]
    if limit:
        failed = failed[:limit]

    console.print(
        f"\n[bold]{run.scaffold}[/] · {run.model} · run {str(run.id)[:8]}\n"
        f"diagnosing {len(failed)} failed of {len(rows)} tasks\n"
    )

    counts: Counter[str] = Counter()
    per_task: list[tuple[str, str, int]] = []
    depths: list[tuple[str, list[int], int]] = []

    for r in failed:
        task = tasks.get(r.task_id)
        if task is None:
            counts["unknown_task"] += 1
            continue
        repo = checkout(task)
        if repo is None:
            counts["checkout_failed"] += 1
            continue
        graph = build(repo)
        predicted = (r.metrics or {}).get("predicted") or []
        gts = (r.metrics or {}).get("ground_truth") or []

        if depth:
            base = (run.config or {}).get("base_mode") or "hybrid"
            ranks = _gt_depth(graph, task.problem_statement, gts, base, depth)
            found = [r for r in ranks if r]
            depths.append((r.task_id, sorted(found), len(gts) - len(found)))

        causes = [_classify(gt, graph, repo, predicted) for gt in gts]
        # Report the most fundamental cause per task: earlier in CAUSES == more upstream.
        worst = min(causes, key=lambda c: CAUSES.index(c) if c in CAUSES else 99)
        counts[worst] += 1
        per_task.append((r.task_id, worst, len(gts)))
        print(f"  {r.task_id[:46]:48} {worst}", flush=True)

    t = Table("cause", "tasks", "share of failures")
    total = sum(counts.values()) or 1
    for cause, n in sorted(counts.items(), key=lambda kv: -kv[1]):
        t.add_row(cause, str(n), f"{100 * n / total:.0f}%")
    console.print(t)

    if depths:
        dt = Table("task", "gt ranks in full ranking", "beyond depth")
        reachable = 0
        for tid, found, missing in depths:
            dt.add_row(tid[:40], ", ".join(map(str, found[:6])) or "none", str(missing))
            if found and max(found) <= 50 and missing == 0:
                reachable += 1
        console.print(dt)
        console.print(
            f"[bold]{reachable}/{len(depths)}[/] failures have all ground truth within "
            f"top-50 — i.e. recoverable by better ranking rather than a new signal.\n"
        )

    unfixable = counts["file_absent_at_base"]
    if unfixable:
        console.print(
            f"[yellow]{unfixable} of {total} failures are unreachable by construction[/] — "
            "the fix creates the file, so it does not exist in the tree being searched."
        )
