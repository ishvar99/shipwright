"""The review pipeline: fetch-shaped input in, structured review out.

`review_diff` is deliberately free of the database and of GitHub, so the evaluation harness
and the product job run exactly the same code over exactly the same inputs. If those
diverged, the published number would be measuring something other than what users get — the
same reason api/service.py reuses the localization path the benchmarks score.
"""

from __future__ import annotations

import logging
from pathlib import Path

from ..codegraph.build import build
from .checkers import CHECKERS, Usage, run_checker
from .context import assemble, changed_symbols
from .deterministic import run_ruff
from .diff import excerpt, parse_file_patch
from .merge import merge
from .stages import Stage, run_stage

log = logging.getLogger("shipwright.review")

MAX_CHUNKS = 12
ALL_CHECKERS: tuple[str, ...] = tuple(CHECKERS)


def _hunk_text(fd) -> str:
    return "\n".join("\n".join([f"@@ hunk at line {h.new_start} @@", *h.lines]) for h in fd.hunks)


def review_diff(
    *,
    root,
    files: list[dict],
    intent: str,
    model,
    checkers: tuple[str, ...] = ALL_CHECKERS,
    notify=None,
    max_chunks: int = MAX_CHUNKS,
) -> dict:
    """Review per-file patches against the repository at `root`. Never raises."""
    root = Path(root)
    reviewable = [f for f in files if f.get("reviewable") and f.get("patch")]
    unreviewed = [f["path"] for f in files if not (f.get("reviewable") and f.get("patch"))]

    parsed = [parse_file_patch(f["path"], f["patch"]) for f in reviewable]
    # Most-changed first, so a truncated review has already done the files worth reading.
    parsed.sort(key=lambda fd: (-fd.changed, fd.path))
    chunks = parsed[:max_chunks]
    if len(parsed) > max_chunks:
        unreviewed += [fd.path for fd in parsed[max_chunks:]]

    if notify:
        notify("review.chunked", {"units": len(chunks), "skipped": len(unreviewed)})

    findings: list[dict] = []
    degraded: set[str] = set()
    usage = Usage()

    # Deterministic first: it is the null hypothesis, and it still stands if every model
    # call fails.
    det = run_stage(
        Stage("deterministic", retries=0, degrade_to=[]),
        lambda: run_ruff(root, [fd.path for fd in chunks]),
        notify=notify,
    )
    if det.degraded:
        degraded.add("deterministic")
    findings += det.value or []

    graph = None
    if checkers:
        built = run_stage(
            Stage("graph", retries=0, degrade_to=None), lambda: build(root), notify=notify
        )
        graph = built.value
        if built.degraded:
            degraded.add("graph")

    grounded = False
    for chunk_index, fd in enumerate(chunks):
        context = ""
        if graph is not None:
            blocks = [assemble(graph, sid) for sid in changed_symbols(graph, fd)]
            context = "\n\n".join(b for b in blocks if b)
            grounded = grounded or bool(context)
        diff_text = _hunk_text(fd)
        for name in checkers:
            outcome = run_stage(
                Stage(name, retries=1, degrade_to=([], Usage())),
                lambda n=name, d=diff_text, c=context, p=fd.path: run_checker(
                    n, model, diff=d, context=c, path=p
                ),
                notify=notify,
            )
            got, used = outcome.value
            if outcome.degraded or used.provider_failures or used.parse_failures:
                degraded.add(name)
            findings += got
            usage.calls += used.calls
            usage.input_tokens += used.input_tokens
            usage.output_tokens += used.output_tokens
            usage.parse_failures += used.parse_failures
            usage.provider_failures += used.provider_failures

        if notify:
            notify("review.progress", {"done": chunk_index + 1, "total": len(chunks)})

    kept = merge(findings, chunks)
    by_path = {fd.path: fd for fd in chunks}
    for f in kept:
        fd = by_path.get(f["path"])
        # unreachable today (merge gates on these same chunks), kept as belt for future callers
        f["hunk"] = excerpt(fd, f["line"], f.get("side", "RIGHT")) if fd else ""
    if notify:
        notify("review.ready", {"findings": len(kept)})

    return {
        "findings": kept,
        "intent": intent,
        "complete": not degraded and not unreviewed,
        "coverage": {
            "files": len(files),
            "reviewed": len(chunks),
            "unreviewed": unreviewed,
            "degraded": sorted(degraded),
            # "none" when no model check ran at all: calling that "window" would render as
            # "no call graph for this language", which is false on a Python repo — the graph
            # was simply never asked for. build() also returns an EMPTY graph for a language
            # it cannot parse rather than failing, so "graph is not None" is not evidence
            # that any context was actually assembled.
            "tier": ("graph" if grounded else "window") if checkers else "none",
            # Names what actually ran, not what was configured — a ruff-only pass names
            # only "static analysis", never the model checkers it skipped.
            "checks": [*checkers, "static analysis"] if checkers else ["static analysis"],
        },
        "usage": {
            "calls": usage.calls,
            "input_tokens": usage.input_tokens,
            "output_tokens": usage.output_tokens,
            "parse_failures": usage.parse_failures,
            "provider_failures": usage.provider_failures,
        },
    }
