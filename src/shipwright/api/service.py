"""Job execution for the product surface.

Reuses the same code graph, retrieval and assisted-localization path the benchmarks score,
so what a user sees in the UI is the configuration whose numbers are published. If these
diverged, the demo would be measuring something other than the results page.

Events are persisted before they are streamed, with a monotonic per-job `seq`, so a browser
that reconnects can resume from Last-Event-ID instead of losing the timeline.
"""

from __future__ import annotations

import subprocess
import time
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import func, select

from ..codegraph.assisted import localize_assisted
from ..codegraph.build import build
from ..codegraph.retrieve import Localizer
from ..config import settings
from ..db import session
from ..models import DONE, ERRORED, RUNNING, Event, Job, Repo

WORKSPACES = Path("workspaces")


def emit(job_id, type_: str, **payload) -> None:
    with session() as s:
        seq = (
            s.scalar(select(func.coalesce(func.max(Event.seq), 0)).where(Event.job_id == job_id))
            or 0
        ) + 1
        s.add(Event(job_id=job_id, seq=seq, type=type_, payload=payload))


def _run_git(args: list[str], cwd: Path | None = None, timeout: int = 1800) -> tuple[bool, str]:
    r = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, timeout=timeout)
    return r.returncode == 0, (r.stderr or r.stdout)[-400:]


def import_repo(repo_id) -> None:
    """Clone (or adopt a local path) and index. Runs off the request thread."""
    with session() as s:
        repo = s.get(Repo, repo_id)
        slug, source, url, path = repo.slug, repo.source, repo.url, repo.path

    try:
        if source == "local":
            dest = Path(path).expanduser().resolve()
            if not dest.exists():
                raise RuntimeError(f"path does not exist: {dest}")
        else:
            dest = WORKSPACES / slug.replace("/", "__")
            dest.parent.mkdir(parents=True, exist_ok=True)
            if not (dest / ".git").exists():
                ok, err = _run_git(["clone", "--depth", "1", url, str(dest)])
                if not ok:
                    raise RuntimeError(f"clone failed: {err}")

        graph = build(dest)
        stats = graph.stats()
        with session() as s:
            r = s.get(Repo, repo_id)
            r.path = str(dest)
            r.symbols = stats["symbols"]
            r.files = stats["files"]
            r.status = "ready"
            ok, ref = _run_git(["rev-parse", "--short", "HEAD"], cwd=dest, timeout=60)
            r.default_ref = ref.strip() if ok else ""
    except Exception as e:
        with session() as s:
            r = s.get(Repo, repo_id)
            r.status = "failed"
            r.error = f"{type(e).__name__}: {e}"[:500]


def run_localize(job_id) -> None:
    """The measured pipeline, wired to the activity stream."""
    started = time.perf_counter()
    with session() as s:
        job = s.get(Job, job_id)
        job.status = RUNNING
        issue, mode, base_mode = job.issue, job.mode, job.base_mode
        repo = s.get(Repo, job.repo_id)
        repo_path, repo_slug = repo.path, repo.slug

    try:
        emit(job_id, "job.started", repo=repo_slug, mode=mode, base=base_mode)

        # No path: it is an absolute host path, it persists in the event row, and it is
        # re-served on every reconnect. The UI already has the repo slug from job.started.
        emit(job_id, "graph.building")
        graph = build(Path(repo_path))
        stats = graph.stats()
        emit(job_id, "graph.ready", **stats)

        model_name = settings.loc_model
        if mode in ("extract", "rerank", "extract_rerank"):
            from ..gateway.ollama import OllamaProvider

            emit(job_id, "model.selected", model=model_name, reason="assisted mode")
            provider = OllamaProvider(model=model_name)
            emit(job_id, "retrieval.started", channels=base_mode)
            ranked, usage = localize_assisted(
                graph, issue, mode=mode, model=provider, top_k=10, base_mode=base_mode
            )
            emit(
                job_id,
                "model.finished",
                calls=usage.calls,
                input_tokens=usage.input_tokens,
                output_tokens=usage.output_tokens,
                parse_failures=usage.parse_failures,
            )
        else:
            usage = None
            model_name = ""
            emit(job_id, "retrieval.started", channels=mode)
            ranked = Localizer(graph).localize(issue, mode=mode, top_k=10)

        results = []
        for i, r in enumerate(ranked, 1):
            sym = graph.symbols.get(r.symbol_id)
            results.append(
                {
                    "rank": i,
                    "symbol": r.symbol_id,
                    "path": sym.path if sym else r.symbol_id.split(":")[0],
                    "name": sym.name if sym else "",
                    "kind": sym.kind if sym else "",
                    "start_line": sym.start_line if sym else 0,
                    "end_line": sym.end_line if sym else 0,
                    "score": round(r.score, 6),
                    "channels": list(r.channels),
                    "signature": (sym.text.splitlines()[0][:160].strip() if sym else ""),
                }
            )
        emit(job_id, "localization.ready", count=len(results))

        wall = int((time.perf_counter() - started) * 1000)
        with session() as s:
            j = s.get(Job, job_id)
            j.status = DONE
            j.model = model_name
            j.result = {"locations": results, "graph": stats}
            j.input_tokens = usage.input_tokens if usage else 0
            j.output_tokens = usage.output_tokens if usage else 0
            j.wall_ms = wall
            j.finished_at = datetime.now(UTC)
        emit(job_id, "job.done", wall_ms=wall, locations=len(results))

    except Exception as e:
        msg = f"{type(e).__name__}: {e}"
        with session() as s:
            j = s.get(Job, job_id)
            j.status = ERRORED
            j.error = msg[:1000]
            j.finished_at = datetime.now(UTC)
        emit(job_id, "job.failed", error=msg[:400])


def read_symbol(repo_path: str, path: str, start: int, end: int, pad: int = 8) -> dict:
    """Source for the detail pane. Bounded, and refuses to escape the repo."""
    root = Path(repo_path).resolve()
    target = (root / path).resolve()
    if not str(target).startswith(str(root)):
        raise ValueError("path escapes repository")
    if not target.exists() or target.stat().st_size > 2_000_000:
        raise ValueError("file missing or too large")

    lines = target.read_text(errors="replace").splitlines()
    lo = max(0, (start or 1) - 1 - pad)
    hi = min(len(lines), (end or start or 1) + pad)
    return {"path": path, "start": lo + 1, "lines": lines[lo:hi]}
