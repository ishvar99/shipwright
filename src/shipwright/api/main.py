"""FastAPI control plane.

The browser talks only to this. It never reaches Postgres, Ollama or the filesystem
directly, and job execution happens on a worker thread so a graph build cannot block the
event loop.
"""

from __future__ import annotations

import asyncio
import json
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import String, cast, func, select

from ..config import settings
from ..db import session
from ..models import QUEUED, SKIPPED, Event, Job, Repo, Run, TaskResult
from .service import import_repo, read_symbol, run_localize

app = FastAPI(title="Shipwright", version="0.1.0")

# Dev-only: the Vite dev server runs on another port.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Graph builds are CPU-bound; keep them off the event loop and bounded so two heavy
# imports cannot exhaust a 16GB machine.
POOL = ThreadPoolExecutor(max_workers=2, thread_name_prefix="sw-job")


class ImportRepo(BaseModel):
    url: str = Field("", description="https://github.com/owner/name")
    path: str = Field("", description="local directory")


class CreateJob(BaseModel):
    repo_id: str
    issue: str = Field(min_length=8, max_length=20000)
    mode: str = "extract_rerank"
    base_mode: str = "hybrid"


def _repo_json(r: Repo) -> dict[str, Any]:
    return {
        "id": str(r.id),
        "slug": r.slug,
        "source": r.source,
        "status": r.status,
        "symbols": r.symbols,
        "files": r.files,
        "ref": r.default_ref,
        "error": r.error,
        "created_at": r.created_at.isoformat(),
    }


def _job_json(j: Job) -> dict[str, Any]:
    return {
        "id": str(j.id),
        "repo_id": str(j.repo_id),
        "kind": j.kind,
        "status": j.status,
        "mode": j.mode,
        "base_mode": j.base_mode,
        "model": j.model,
        "issue": j.issue[:400],
        "result": j.result or {},
        "error": j.error,
        "input_tokens": j.input_tokens,
        "output_tokens": j.output_tokens,
        "wall_ms": j.wall_ms,
        "created_at": j.created_at.isoformat(),
    }


@app.get("/api/health")
def health() -> dict[str, Any]:
    with session() as s:
        s.execute(select(func.count()).select_from(Repo))
    return {"ok": True, "loc_model": settings.loc_model}


@app.post("/api/repos/import")
def repos_import(body: ImportRepo, background: BackgroundTasks) -> dict[str, Any]:
    if not body.url and not body.path:
        raise HTTPException(400, "provide url or path")
    if body.url:
        clean = body.url.strip().removesuffix(".git")
        if "github.com/" not in clean:
            raise HTTPException(400, "only github.com URLs are supported")
        slug, source, url, path = clean.split("github.com/", 1)[1], "github", clean, ""
    else:
        slug, source, url, path = (
            f"local:{body.path.rstrip('/').split('/')[-1]}",
            "local",
            "",
            body.path,
        )

    with session() as s:
        existing = s.scalars(select(Repo).where(Repo.slug == slug)).first()
        if existing and existing.status != "failed":
            return _repo_json(existing)
        repo = existing or Repo(slug=slug, source=source, url=url, path=path)
        repo.status, repo.error = "importing", ""
        s.add(repo)
        s.flush()
        out, repo_id = _repo_json(repo), repo.id

    background.add_task(POOL.submit, import_repo, repo_id)
    return out


@app.get("/api/repos")
def repos_list() -> list[dict[str, Any]]:
    with session() as s:
        return [_repo_json(r) for r in s.scalars(select(Repo).order_by(Repo.created_at.desc()))]


@app.post("/api/jobs")
def jobs_create(body: CreateJob, background: BackgroundTasks) -> dict[str, Any]:
    with session() as s:
        repo = s.scalars(select(Repo).where(cast(Repo.id, String).like(f"{body.repo_id}%"))).first()
        if not repo:
            raise HTTPException(404, "repo not found")
        if repo.status != "ready":
            raise HTTPException(409, f"repo is {repo.status}")
        job = Job(
            repo_id=repo.id,
            issue=body.issue,
            mode=body.mode,
            base_mode=body.base_mode,
            status=QUEUED,
        )
        s.add(job)
        s.flush()
        out, job_id = _job_json(job), job.id

    background.add_task(POOL.submit, run_localize, job_id)
    return out


@app.get("/api/jobs")
def jobs_list(limit: int = 25) -> list[dict[str, Any]]:
    with session() as s:
        rows = s.scalars(select(Job).order_by(Job.created_at.desc()).limit(limit)).all()
        return [_job_json(j) for j in rows]


@app.get("/api/jobs/{job_id}")
def jobs_get(job_id: str) -> dict[str, Any]:
    with session() as s:
        job = s.scalars(select(Job).where(cast(Job.id, String).like(f"{job_id}%"))).first()
        if not job:
            raise HTTPException(404, "job not found")
        return _job_json(job)


@app.get("/api/jobs/{job_id}/source")
def jobs_source(job_id: str, path: str, start: int = 1, end: int = 1) -> dict[str, Any]:
    with session() as s:
        job = s.scalars(select(Job).where(cast(Job.id, String).like(f"{job_id}%"))).first()
        if not job:
            raise HTTPException(404, "job not found")
        repo = s.get(Repo, job.repo_id)
        repo_path = repo.path
    try:
        return read_symbol(repo_path, path, start, end)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.get("/api/jobs/{job_id}/events")
async def jobs_events(job_id: str, request: Request) -> StreamingResponse:
    """SSE with replay. Honours Last-Event-ID so a refresh does not lose the timeline."""
    with session() as s:
        job = s.scalars(select(Job).where(cast(Job.id, String).like(f"{job_id}%"))).first()
        if not job:
            raise HTTPException(404, "job not found")
        real_id = job.id

    try:
        cursor = int(request.headers.get("last-event-id", 0))
    except ValueError:
        cursor = 0

    async def stream():
        nonlocal cursor
        terminal = {"job.done", "job.failed"}
        while True:
            if await request.is_disconnected():
                return
            with session() as s:
                rows = s.scalars(
                    select(Event)
                    .where(Event.job_id == real_id, Event.seq > cursor)
                    .order_by(Event.seq)
                ).all()
                batch = [(e.seq, e.type, e.payload or {}, e.created_at) for e in rows]
                last_type = (
                    None
                    if batch
                    else s.scalar(
                        select(Event.type)
                        .where(Event.job_id == real_id)
                        .order_by(Event.seq.desc())
                        .limit(1)
                    )
                )
            if not batch:
                # Caught up. A reconnect resumes from past the terminal event, so on a
                # finished job nothing more is coming: close instead of polling forever.
                if last_type in terminal:
                    return
                # Bare comment frame: proves liveness through a long silent graph build,
                # and keeps the connection off undici's 300s body-inactivity timeout.
                # No id:, or it would clobber the client's Last-Event-ID.
                yield ":\n\n"
                await asyncio.sleep(0.4)
                continue
            for seq, type_, payload, created in batch:
                cursor = seq
                # Envelope keys last: a payload key must never shadow the discriminators.
                data = json.dumps({**payload, "seq": seq, "type": type_, "ts": created.isoformat()})
                yield f"id: {seq}\nevent: {type_}\ndata: {data}\n\n"
                if type_ in terminal:
                    return
            await asyncio.sleep(0.4)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/analytics/summary")
def analytics_summary() -> dict[str, Any]:
    """Benchmark rows, so the product surface shows the same numbers as the results page."""
    with session() as s:
        out = []
        for run in s.scalars(select(Run).where(Run.suite == "locbench")).all():
            rows = s.scalars(select(TaskResult).where(TaskResult.run_id == run.id)).all()
            att = [r for r in rows if r.status != SKIPPED]
            if not att:
                continue
            m = [r.metrics or {} for r in att]
            n = len(att)
            out.append(
                {
                    "run": str(run.id)[:8],
                    "scaffold": run.scaffold.removeprefix("retrieval_"),
                    "model": "—" if run.model == "none" else run.model.split("/")[-1][:30],
                    "n": n,
                    "file5": round(100 * sum(1 for x in m if x.get("file_acc_at_5")) / n, 1),
                    "func10": round(100 * sum(1 for x in m if x.get("func_acc_at_10")) / n, 1),
                    "commit": run.git_commit,
                    "date": run.started_at.strftime("%Y-%m-%d"),
                }
            )
        out.sort(key=lambda d: (-d["n"], -d["func10"]))
        return {"runs": out, "noise_floor_pp": 3.3}
