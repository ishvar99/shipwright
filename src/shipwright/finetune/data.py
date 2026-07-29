"""Training data for the localization reranker, labelled from Loc-Bench ground truth.

Why the reranker and not agent trajectories: reranking is the step this project actually
measures, its labels are free and exact (ground truth says which symbols must change), and
a 1.5-3B model has a real chance at "order these 30 candidates" where it has none at
multi-step agentic repair.

**Train/eval split is disjoint by construction.** Every published number so far used the
first 100 tasks sorted by instance_id. Training data therefore starts at index 100. Without
this the fine-tune would be scored on its own training set.

Candidate pool stays at 30 to match the measured baseline exactly. Raising it is a separate
change with its own measurement — one variable at a time (see FAILURES.md F12).
"""

from __future__ import annotations

import json
import random
from pathlib import Path

from ..codegraph.assisted import MAX_ISSUE_CHARS, RERANK_CANDIDATES
from ..codegraph.build import build
from ..codegraph.retrieve import Localizer
from ..evals.locbench import checkout, fetch

OUT = Path("evals/finetune")
EVAL_HELDOUT = 100  # indices [0, 100) are the evaluation set — never trained on


def _rerank_prompt(issue: str, candidates: list[str], graph) -> str:
    """Byte-identical to the production prompt in codegraph/assisted.py. If these drift,
    the model is trained on one distribution and used on another."""
    lines = []
    for i, cid in enumerate(candidates):
        sym = graph.symbols.get(cid)
        sig = (sym.text.splitlines()[0][:100] if sym else "").strip()
        lines.append(f"{i}. {cid} — {sig}")
    return (
        "Which candidates most likely contain the code that must change?\n"
        "Return JSON: the candidate numbers ordered most to least likely. "
        "Include only plausible ones.\n\n"
        f"Issue:\n{issue[:MAX_ISSUE_CHARS]}\n\nCandidates:\n" + "\n".join(lines)
    )


def build_dataset(
    n_train: int = 250, base_mode: str = "hybrid", valid_frac: float = 0.1
) -> dict[str, int]:
    """Generates train/valid JSONL in the prompt/completion format mlx_lm.lora expects."""
    tasks = fetch()[EVAL_HELDOUT : EVAL_HELDOUT + n_train]
    OUT.mkdir(parents=True, exist_ok=True)

    # Append as we go: repo cloning dominates runtime, so a crash at task 200 must not
    # discard 200 tasks of work.
    raw = OUT / "examples.jsonl"
    seen = set()
    if raw.exists():
        for line in raw.open():
            seen.add(json.loads(line)["instance_id"])
    sink = raw.open("a")

    examples: list[dict[str, str]] = []
    skipped = {"checkout": 0, "no_gt_in_graph": 0, "cached": 0}
    injected = 0

    for i, task in enumerate(tasks, 1):
        if task.instance_id in seen:
            skipped["cached"] += 1
            continue
        repo = checkout(task)
        if repo is None:
            skipped["checkout"] += 1
            continue
        graph = build(repo)
        ranked = Localizer(graph).localize(
            task.problem_statement, mode=base_mode, top_k=RERANK_CANDIDATES
        )
        candidates = [r.symbol_id for r in ranked]

        # Positive injection. At pool=30 on a 20k-symbol repo, retrieval usually misses the
        # ground truth entirely — so keeping only naturally-hit tasks would train the model
        # exclusively on cases where retrieval already worked, i.e. the ones needing no help.
        # Instead, ground truth present in the graph is injected at a deterministic position
        # and the rest of the pool serves as hard negatives.
        missing = [g for g in task.edit_functions if g not in candidates and g in graph.symbols]
        if missing:
            rng = random.Random(task.instance_id)  # deterministic per task, not per run
            for g in missing:
                candidates.insert(rng.randrange(len(candidates) + 1), g)
            injected += len(missing)

        gt_idx = [candidates.index(g) for g in task.edit_functions if g in candidates]
        if not gt_idx:
            # Ground truth is not even in the graph — nothing to learn or inject.
            skipped["no_gt_in_graph"] += 1
            print(
                f"  [{i}/{len(tasks)}] {task.instance_id[:44]} skip (gt not in graph)", flush=True
            )
            continue

        row = {
            "prompt": _rerank_prompt(task.problem_statement, candidates, graph),
            "completion": json.dumps({"ranked": sorted(gt_idx)}),
        }
        sink.write(json.dumps({"instance_id": task.instance_id, **row}) + "\n")
        sink.flush()
        print(f"  [{i}/{len(tasks)}] {task.instance_id[:44]} ok ({len(gt_idx)} gt)", flush=True)

    sink.close()
    # Split from everything accumulated on disk, not just this invocation.
    examples = [
        {k: v for k, v in json.loads(line).items() if k != "instance_id"} for line in raw.open()
    ]
    cut = max(1, int(len(examples) * valid_frac))
    valid, train = examples[:cut], examples[cut:]
    for name, rows in (("train", train), ("valid", valid)):
        with (OUT / f"{name}.jsonl").open("w") as f:
            for row in rows:
                f.write(json.dumps(row) + "\n")

    return {"train": len(train), "valid": len(valid), "injected_positives": injected, **skipped}
