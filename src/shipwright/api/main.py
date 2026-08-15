"""FastAPI control plane.

The browser talks only to this. It never reaches Postgres, Ollama or the filesystem
directly, and job execution happens on a worker thread so a graph build cannot block the
event loop.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, or_, select

from ..config import settings
from ..db import session
from ..models import LOCALIZE, QUEUED, REVIEW, SKIPPED, Event, Job, Repo, Run, TaskResult
from . import github, github_pr
from .service import (
    MAX_COMPRESSED_UPLOAD,
    WORKSPACES,
    FileTooLarge,
    RepoBusy,
    SaveConflict,
    _fail_repo,
    build_tree,
    import_repo,
    import_zip,
    read_symbol,
    read_whole_file,
    reindex_repo,
    run_action,
    run_localize,
    run_review,
    save_file,
    stash_token,
)

# The app's own loggers (shipwright.boot, shipwright.jobs) emit INFO for boot
# reconciliation counts and ERROR w/ tracebacks for job failures. Nothing else
# configures logging (uvicorn only configures its own), so without this the INFO
# lines never reach Render's log capture.
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(_: FastAPI):
    """Bring the schema up to date on boot, then reconcile state the previous process left
    behind.

    This project uses `create_all` rather than migrations, which only ever CREATEs — so
    pulling a change that adds a column left the API answering 500s until somebody
    remembered to run `sw db-init` by hand. On the hosted free tier, restarts also wipe
    the disk and kill mid-flight jobs, so boot is where the database is made honest
    again. All steps are idempotent, so doing this here costs a few milliseconds and
    removes every manual step.
    """
    from . import boot

    boot.guarded_init_schema()
    boot.reap_stale_jobs()
    boot.heal_eventless_terminals()
    boot.reconcile_repos()
    boot.seed_demos()
    yield


app = FastAPI(title="Shipwright", version="0.1.0", lifespan=lifespan)

# Dev-only: the Vite dev server runs on another port.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def require_key(request: Request, call_next):
    """One shared secret between the BFF and this process.

    Thirteen of the fifteen endpoints below carry no caller identity of any kind — the only
    thing standing between two people was that uvicorn binds loopback. This closes all of them
    in one place rather than per route, so a new endpoint is covered by default instead of by
    remembering. Off when unset, which is correct for a single-user dev box.
    """
    if (
        settings.shipwright_api_key
        and request.method != "OPTIONS"  # a preflight carries no custom headers to check
        and request.url.path != "/api/health"  # keepalive monitors; returns liveness only
        and request.headers.get("x-shipwright-key") != settings.shipwright_api_key
    ):
        return JSONResponse({"detail": "Not authorised."}, status_code=401)
    return await call_next(request)


# Graph builds are CPU-bound; keep them off the event loop and bounded so two heavy
# imports cannot exhaust a 16GB machine.
POOL = ThreadPoolExecutor(max_workers=settings.job_workers, thread_name_prefix="sw-job")
# Imports get a separate single worker so a zip extraction never queues behind two
# inference sessions on POOL (extraction is zlib-bound and releases the GIL).
IMPORT_POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix="sw-import")


class ImportRepo(BaseModel):
    url: str = Field("", description="https://github.com/owner/name")
    path: str = Field("", description="local directory")
    # Used once, for the clone, then discarded. Never stored on the repo row.
    token: str = Field("", description="GitHub access token for a private repository")


class CreateAction(BaseModel):
    kind: str = Field(pattern="^(apply|test|fix_retry|open_pr|post_review)$")
    symbol: str = ""
    # Supplied per call by the BFF for `open_pr` only, and never stored: the one action that
    # writes to somebody else's account is the one action that needs a credential.
    token: str = Field("", description="GitHub access token, for open_pr")


class CreateReview(BaseModel):
    repo_id: str = Field(min_length=8)
    number: int = Field(ge=1)
    # Per call and never stored, like open_pr's: the only credential this feature needs.
    token: str = Field("", description="GitHub access token, for reading the pull request")


class CreateJob(BaseModel):
    # Matched exactly against a UUID now, so a malformed id is a 404 rather than a silent
    # prefix hit on somebody else's repository.
    repo_id: str = Field(min_length=8)
    issue: str = Field(min_length=8, max_length=20000)
    mode: str = Field(
        "extract_rerank", pattern="^(bm25|graph|path|hybrid|extract|rerank|extract_rerank)$"
    )
    base_mode: str = Field("hybrid", pattern="^(bm25|graph|path|hybrid)$")
    client: str = ""


def caller_owner(request: Request) -> str:
    """Who the BFF says is calling, as a GitHub provider id. Trusted only because the shared
    secret gates this port — the header means nothing on its own, and that is the whole design:
    identity is resolved once, at the BFF, where the session cookie actually lives.

    "" is the single-user local install, and it owns everything that predates this column.
    """
    return (request.headers.get("x-shipwright-owner") or "").strip()[:128]


OwnerDep = Annotated[str, Depends(caller_owner)]


def _owned(column, owner: str):
    """Rows this caller may reach.

    A signed-in caller also reaches rows with no owner. Those can only have been created by
    whoever runs this install, back when it had no accounts — the alternative is that
    connecting GitHub makes your own existing repositories and sessions disappear.

    That leniency is a migration window, not a resting state: `_claim` below takes ownership of
    every unowned row the caller touches, so the set shrinks to empty and the model converges
    on strict per-owner isolation. Import and upload are strict from the start, because a
    global slug lookup is the path the cross-user workspace handoff actually took.
    """
    return column.in_(("", owner)) if owner else column == ""


def _claim(owner: str, *rows) -> None:
    """First authenticated touch of a pre-ownership row takes ownership of it.

    Without this the choice is between losing your work when you sign in (strict) and leaving
    every legacy row writable by anyone who signs in (lenient). Claiming is the third option:
    one-time, per row, and it converges. Rows are attached to the caller's session, so the
    write lands on commit.
    """
    if not owner:
        return
    for row in rows:
        if row is not None and not row.owner:
            row.owner = owner


def _uuid_or_404(value: str) -> uuid.UUID:
    """Ids are matched exactly. A `LIKE '<prefix>%'` lookup turns an opaque UUID into a
    guessable namespace and can match more than one row."""
    try:
        return uuid.UUID(value)
    except ValueError:
        raise HTTPException(404, "Not found.") from None


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


def _job_json(j: Job, slug: str = "") -> dict[str, Any]:
    return {
        "id": str(j.id),
        "repo_id": str(j.repo_id),
        # Carried on the job so session lists render a repo name without a client-side join
        # against the repos list, which is empty in the recorded demo.
        "repo_slug": slug,
        "kind": j.kind,
        "status": j.status,
        "mode": j.mode,
        "base_mode": j.base_mode,
        "client": j.client,
        # Aliased: the engine is an implementation detail behind this API. Benchmark
        # reporting reads the Run table, which keeps the real name.
        "model": "shipwright-engine" if j.model else "",
        "issue": j.issue[:400],
        "result": j.result or {},
        # How the request was routed: change | question | other.
        "intent": (j.result or {}).get("intent", ""),
        "answer": (j.result or {}).get("answer", ""),
        "error": j.error,
        "input_tokens": j.input_tokens,
        "output_tokens": j.output_tokens,
        "wall_ms": j.wall_ms,
        "created_at": j.created_at.isoformat(),
    }


@app.get("/api/health")
def health() -> dict[str, Any]:
    """Key-exempt (see require_key) and deliberately blank about what runs behind it:
    the engine name stays off open endpoints. The DB probe is load-bearing — it is what
    makes an external keepalive count as Supabase activity."""
    with session() as s:
        s.execute(select(func.count()).select_from(Repo))
    return {"ok": True}


@app.post("/api/repos/import")
def repos_import(body: ImportRepo, background: BackgroundTasks, owner: OwnerDep) -> dict[str, Any]:
    if not body.url and not body.path:
        raise HTTPException(400, "Enter a GitHub URL or a local folder path.")
    if body.url:
        clean = body.url.strip().removesuffix(".git")
        if "github.com/" not in clean:
            raise HTTPException(400, "Only GitHub repositories are supported right now.")
        slug, source, url, path = clean.split("github.com/", 1)[1], "github", clean, ""
    else:
        # read_symbol's sandbox root is this path, so "/" or $HOME would make the whole disk
        # readable through the source endpoint. A 400 now beats a failed row 30s later.
        dest = Path(body.path).expanduser().resolve()
        if dest == Path("/") or dest == Path.home() or not dest.is_dir():
            raise HTTPException(
                400,
                "That folder can't be imported — choose a project folder, not your home directory.",
            )
        slug, source, url, path = (
            f"local:{body.path.rstrip('/').split('/')[-1]}",
            "local",
            "",
            body.path,
        )

    with session() as s:
        # Scoped to the caller. Globally, this returned whoever imported it first — handing the
        # second person that workspace, private clone and all.
        existing = s.scalars(select(Repo).where(Repo.owner == owner, Repo.slug == slug)).first()
        if existing and existing.status != "failed":
            return _repo_json(existing)
        repo = existing or Repo(owner=owner, slug=slug, source=source, url=url, path=path)
        repo.status, repo.error = "importing", ""
        s.add(repo)
        s.flush()
        out, repo_id = _repo_json(repo), repo.id

    background.add_task(IMPORT_POOL.submit, import_repo, repo_id, body.token)
    return out


@app.get("/api/repos")
def repos_list(owner: OwnerDep) -> list[dict[str, Any]]:
    with session() as s:
        q = select(Repo).where(_owned(Repo.owner, owner)).order_by(Repo.created_at.desc())
        rows = list(s.scalars(q))
        # The list is the first call the app makes, so this is where the migration happens.
        _claim(owner, *rows)
        return [_repo_json(r) for r in rows]


def _unique_slug(s, owner: str, base: str) -> str:
    """zip:name, zip:name-2, … Re-uploading while one is still importing reuses that row
    (as /import does) rather than minting a second copy of the same project."""
    taken = set(
        s.scalars(
            select(Repo.slug).where(
                Repo.owner == owner, or_(Repo.slug == base, Repo.slug.like(f"{base}-%"))
            )
        ).all()
    )
    if base not in taken:
        return base
    n = 2
    while f"{base}-{n}" in taken:
        n += 1
    return f"{base}-{n}"


@app.post("/api/repos/upload")
def repos_upload(background: BackgroundTasks, file: UploadFile, owner: OwnerDep) -> dict[str, Any]:
    """Zip import. Sync def so FastAPI threadpools the copy: Starlette closes the spooled
    upload at request teardown, and the worker runs after the response, so the bytes must
    land somewhere durable first."""
    name = (file.filename or "upload.zip").rsplit("/", 1)[-1]
    if not name.lower().endswith(".zip"):
        raise HTTPException(400, "Upload a .zip archive.")
    base = f"zip:{name[:-4][:80] or 'project'}"

    with session() as s:
        existing = s.scalars(select(Repo).where(Repo.owner == owner, Repo.slug == base)).first()
        if existing and existing.status == "importing":
            return _repo_json(existing)
        repo = Repo(
            owner=owner, slug=_unique_slug(s, owner, base), source="zip", status="importing"
        )
        s.add(repo)
        s.flush()
        out, repo_id = _repo_json(repo), repo.id

    uploads = WORKSPACES / "_uploads"
    uploads.mkdir(parents=True, exist_ok=True)
    zip_path = uploads / f"{repo_id}.zip"
    size = 0
    try:
        with open(zip_path, "wb") as w:
            while chunk := file.file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_COMPRESSED_UPLOAD:
                    raise HTTPException(413, "That archive is too large (limit 150 MB).")
                w.write(chunk)
    except HTTPException:
        zip_path.unlink(missing_ok=True)
        _fail_repo(repo_id, "That archive is too large (limit 150 MB).")
        raise

    background.add_task(IMPORT_POOL.submit, import_zip, repo_id, str(zip_path))
    return out


@app.post("/api/repos/{repo_id}/reindex")
def repo_reindex(repo_id: str, background: BackgroundTasks, owner: OwnerDep) -> dict[str, Any]:
    """Rebuild the graph for an already-imported repository. The row goes back to `importing`,
    which is what the client already knows how to poll and render."""
    with session() as s:
        repo = s.scalars(
            select(Repo).where(Repo.id == _uuid_or_404(repo_id), _owned(Repo.owner, owner))
        ).first()
        if not repo:
            raise HTTPException(404, "That repository no longer exists.")
        _claim(owner, repo)
        if repo.status == "importing":
            raise HTTPException(409, "This repository is already indexing.")
        if not repo.path:
            raise HTTPException(409, "This repository never imported — retry the import instead.")
        repo.status, repo.error = "importing", ""
        s.flush()
        out, rid = _repo_json(repo), repo.id

    background.add_task(IMPORT_POOL.submit, reindex_repo, rid)
    return out


@app.delete("/api/repos/{repo_id}")
def repo_delete(repo_id: str, owner: OwnerDep) -> dict[str, Any]:
    """Unlink a repository: its rows and its sessions leave Shipwright.

    Nothing is removed from disk. For `local` sources `path` IS the user's own checkout, so
    deleting it would destroy their working copy; a github/zip clone under `workspaces/` is
    left too, because re-importing the same slug reuses it and a stale directory costs only
    space. "Unlink" is the honest word for what this does.
    """
    with session() as s:
        repo = s.scalars(
            select(Repo).where(Repo.id == _uuid_or_404(repo_id), _owned(Repo.owner, owner))
        ).first()
        if not repo:
            raise HTTPException(404, "That repository no longer exists.")
        # Seeded demos are shared by every anonymous visitor; deleting one would remove the
        # default experience for everyone until the next boot reseeds it. Checked before
        # _claim, which rewrites repo.owner from "" to a signed-in caller in memory — after
        # that rewrite this check would see the claimed owner, not the true stored one, and
        # a signed-in user could claim-and-delete a demo.
        from . import boot

        if repo.owner == "" and repo.slug in boot.DEMO_SLUGS:
            raise HTTPException(403, "This demo repository is part of the public deployment.")
        _claim(owner, repo)
        # Sessions go with it: a job whose repository is gone can neither open its source nor
        # be re-run, and its rows would keep appearing in every list.
        jobs = s.scalars(select(Job).where(Job.repo_id == repo.id)).all()
        for job in jobs:
            s.execute(delete(Event).where(Event.job_id == job.id))
            s.delete(job)
        s.delete(repo)
    return {"ok": True}


def _ready_repo(repo_id: str, owner: str) -> Repo:
    """Repo-scoped file access needs a workspace we own. Importing local rows still point at
    the user's own checkout, and a failed row's path can be "" — which resolves to the
    server's working directory."""
    with session() as s:
        # Owner is part of the lookup, not a check after it: a 404 for someone else's row
        # says nothing about whether it exists.
        repo = s.scalars(
            select(Repo).where(Repo.id == _uuid_or_404(repo_id), _owned(Repo.owner, owner))
        ).first()
        if not repo:
            raise HTTPException(404, "That repository no longer exists.")
        _claim(owner, repo)
        if repo.status != "ready":
            raise HTTPException(
                409,
                "This repository is still importing."
                if repo.status == "importing"
                else "This repository failed to import.",
            )
        s.expunge(repo)
        return repo


@app.get("/api/repos/{repo_id}/tree")
def repo_tree(repo_id: str, owner: OwnerDep) -> dict[str, Any]:
    return build_tree(_ready_repo(repo_id, owner).path)


@app.get("/api/repos/{repo_id}/file")
def repo_file(repo_id: str, path: str, owner: OwnerDep) -> dict[str, Any]:
    try:
        return read_whole_file(_ready_repo(repo_id, owner).path, path)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


class SaveFile(BaseModel):
    path: str
    content: str
    # Required: an absent token would make every save an unconditional overwrite, and the
    # Overwrite path always has the sha the 409 handed back.
    base_sha: str = Field(min_length=64, max_length=64)


@app.put("/api/repos/{repo_id}/file")
def repo_save(repo_id: str, body: SaveFile, owner: OwnerDep) -> Any:
    repo = _ready_repo(repo_id, owner)
    try:
        return save_file(repo.id, body.path, body.content, body.base_sha)
    except SaveConflict as e:
        # Two different 409s: the client offers Overwrite for this one only, and the
        # returned sha lets it do that in a single request.
        return JSONResponse(
            status_code=409,
            content={"reason": "conflict", "detail": str(e), "current_sha": e.current_sha},
        )
    except RepoBusy as e:
        return JSONResponse(status_code=409, content={"reason": "busy", "detail": str(e)})
    except FileTooLarge as e:
        raise HTTPException(413, str(e)) from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.post("/api/jobs")
def jobs_create(body: CreateJob, background: BackgroundTasks, owner: OwnerDep) -> dict[str, Any]:
    with session() as s:
        repo = s.scalars(
            select(Repo).where(Repo.id == _uuid_or_404(body.repo_id), _owned(Repo.owner, owner))
        ).first()
        if not repo:
            raise HTTPException(404, "That repository no longer exists. Refresh and try again.")
        _claim(owner, repo)
        if repo.status != "ready":
            raise HTTPException(
                409,
                "This repository is still importing."
                if repo.status == "importing"
                else "This repository failed to import.",
            )
        job = Job(
            repo_id=repo.id,
            owner=owner,
            issue=body.issue,
            mode=body.mode,
            base_mode=body.base_mode,
            client=body.client,
            status=QUEUED,
        )
        s.add(job)
        s.flush()
        out, job_id = _job_json(job, repo.slug), job.id

    background.add_task(POOL.submit, run_localize, job_id)
    return out


@app.get("/api/repos/{repo_id}/pulls")
def repo_pulls(repo_id: str, owner: OwnerDep, token: str = "") -> list[dict[str, Any]]:
    """Open pull requests, for the review picker. The token is per call and never stored."""
    repo = _ready_repo(repo_id, owner)
    if repo.source != "github":
        raise HTTPException(409, "Only a GitHub-imported repository has pull requests.")
    if not token:
        raise HTTPException(409, "Connect GitHub to list pull requests.")
    try:
        return github_pr.list_pull_requests(repo.slug, token)
    except github.PullRequestError as e:
        # Already a sentence for the user and already free of credentials.
        raise HTTPException(502, str(e)) from e


@app.post("/api/reviews")
def reviews_create(
    body: CreateReview, background: BackgroundTasks, owner: OwnerDep
) -> dict[str, Any]:
    """Review one pull request. A sibling of jobs_create, not an action: a review is a
    session in its own right and owns the post_review action underneath it."""
    repo = _ready_repo(body.repo_id, owner)
    if repo.source != "github":
        raise HTTPException(409, "Only a GitHub-imported repository has pull requests.")
    if not body.token:
        raise HTTPException(409, "Connect GitHub before reviewing a pull request.")
    with session() as s:
        job = Job(
            repo_id=repo.id,
            owner=owner,
            kind=REVIEW,
            issue=f"Review pull request #{body.number}",
            client="web",
            status=QUEUED,
            result={"target": {"number": body.number, "slug": repo.slug}},
        )
        s.add(job)
        s.flush()
        out, job_id = _job_json(job, repo.slug), job.id
    # In memory only, never on the row: `result` is echoed back to the caller.
    stash_token(job_id, body.token)
    background.add_task(POOL.submit, run_review, job_id)
    return out


@app.post("/api/jobs/{job_id}/actions")
def actions_create(
    job_id: str, body: CreateAction, background: BackgroundTasks, owner: OwnerDep
) -> dict[str, Any]:
    """Apply / test / fix-again as their own jobs, so each streams its own events and the
    session stream's terminal semantics stay intact."""
    with session() as s:
        parent = s.scalars(
            select(Job).where(Job.id == _uuid_or_404(job_id), _owned(Job.owner, owner))
        ).first()
        # Both kinds, because a review session owns the post_review action. Kept as an
        # explicit tuple rather than dropping the check: a child action job must never be
        # able to parent another one.
        if not parent or parent.kind not in (LOCALIZE, REVIEW):
            raise HTTPException(404, "That session no longer exists.")
        _claim(owner, parent)
        fix = (parent.result or {}).get("fix") or {}
        if body.kind == "test" and not settings.enable_test_action:
            raise HTTPException(
                409,
                "Running the repo's test suite is disabled on this hosted demo — "
                "run Shipwright locally for that.",
            )
        if body.kind in ("apply", "test") and not fix.get("patch"):
            raise HTTPException(409, "There is no fix to apply yet.")
        if body.kind == "test" and not fix.get("applied_branch"):
            raise HTTPException(409, "Apply the fix before running the tests.")
        if body.kind == "open_pr":
            repo = s.get(Repo, parent.repo_id)
            if not fix.get("applied_branch"):
                raise HTTPException(409, "Apply the fix before opening a pull request.")
            if not repo or repo.source != "github":
                raise HTTPException(409, "Only a GitHub-imported repository has somewhere to push.")
            if not body.token:
                raise HTTPException(409, "Connect GitHub before opening a pull request.")
        if body.kind == "post_review":
            repo = s.get(Repo, parent.repo_id)
            if not (parent.result or {}).get("findings"):
                raise HTTPException(409, "There are no findings to post.")
            if not repo or repo.source != "github":
                raise HTTPException(409, "Only a GitHub-imported repository has a pull request.")
            if not body.token:
                raise HTTPException(409, "Connect GitHub before posting a review.")
        meta: dict[str, Any] = {"parent": str(parent.id)}
        if body.symbol:
            meta["symbol"] = body.symbol
        job = Job(
            repo_id=parent.repo_id,
            owner=owner,
            issue=parent.issue,
            mode=parent.mode,
            base_mode=parent.base_mode,
            kind=body.kind,
            status=QUEUED,
            result=meta,
        )
        s.add(job)
        s.flush()
        repo = s.get(Repo, parent.repo_id)
        out, action_id = _job_json(job, repo.slug if repo else ""), job.id

    # Handed to the worker in memory, never through the job row: `result` is echoed straight
    # back to the caller by _job_json and persisted in Postgres.
    if body.kind in ("open_pr", "post_review"):
        stash_token(action_id, body.token)
    background.add_task(POOL.submit, run_action, action_id)
    return out


@app.get("/api/jobs")
def jobs_list(
    owner: OwnerDep, limit: int = 25, kind: str = "", client: str = ""
) -> list[dict[str, Any]]:
    """Filters run in SQL, before the limit. Filtering after truncation would let a benchmark
    sweep fill the page and push every one of the user's own sessions off it."""
    with session() as s:
        q = select(Job).where(_owned(Job.owner, owner))
        if kind:
            q = q.where(Job.kind == kind)
        if client:
            q = q.where(Job.client == client)
        rows = s.scalars(q.order_by(Job.created_at.desc()).limit(limit)).all()
        _claim(owner, *rows)
        ids = {j.repo_id for j in rows}
        slugs = dict(s.execute(select(Repo.id, Repo.slug).where(Repo.id.in_(ids))).all())
        return [_job_json(j, slugs.get(j.repo_id, "")) for j in rows]


@app.get("/api/jobs/{job_id}")
def jobs_get(job_id: str, owner: OwnerDep) -> dict[str, Any]:
    with session() as s:
        job = s.scalars(
            select(Job).where(Job.id == _uuid_or_404(job_id), _owned(Job.owner, owner))
        ).first()
        if not job:
            raise HTTPException(404, "That session no longer exists.")
        _claim(owner, job)
        repo = s.get(Repo, job.repo_id)
        return _job_json(job, repo.slug if repo else "")


@app.delete("/api/jobs/{job_id}")
def jobs_delete(job_id: str, owner: OwnerDep) -> dict[str, Any]:
    """Removing a session removes its events and its action jobs: a job row without its event
    stream is unreadable, and an orphaned apply job points at a parent that is gone."""
    with session() as s:
        job = s.scalars(
            select(Job).where(Job.id == _uuid_or_404(job_id), _owned(Job.owner, owner))
        ).first()
        if not job:
            raise HTTPException(404, "That session no longer exists.")
        _claim(owner, job)
        children = s.scalars(
            select(Job).where(
                Job.result["parent"].as_string() == str(job.id), _owned(Job.owner, owner)
            )
        ).all()
        for child in [*children, job]:
            s.execute(delete(Event).where(Event.job_id == child.id))
            s.delete(child)
    return {"ok": True}


@app.get("/api/jobs/{job_id}/source")
def jobs_source(
    job_id: str, owner: OwnerDep, path: str, start: int = 1, end: int = 0
) -> dict[str, Any]:
    with session() as s:
        job = s.scalars(
            select(Job).where(Job.id == _uuid_or_404(job_id), _owned(Job.owner, owner))
        ).first()
        if not job:
            raise HTTPException(404, "That session no longer exists.")
        _claim(owner, job)
        repo = s.get(Repo, job.repo_id)
        repo_path = repo.path
    try:
        # end defaults to 0, not 1: otherwise a start without an end slices an empty range
        # and reports a non-zero start, which reads as a loaded-but-blank file.
        return read_symbol(repo_path, path, start, end or start)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.get("/api/jobs/{job_id}/events")
async def jobs_events(job_id: str, request: Request, owner: OwnerDep) -> StreamingResponse:
    """SSE with replay. Honours Last-Event-ID so a refresh does not lose the timeline."""
    with session() as s:
        job = s.scalars(
            select(Job).where(Job.id == _uuid_or_404(job_id), _owned(Job.owner, owner))
        ).first()
        if not job:
            raise HTTPException(404, "That session no longer exists.")
        _claim(owner, job)
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
                await asyncio.sleep(settings.sse_poll_seconds)
                continue
            for seq, type_, payload, created in batch:
                cursor = seq
                # Envelope keys last: a payload key must never shadow the discriminators.
                data = json.dumps({**payload, "seq": seq, "type": type_, "ts": created.isoformat()})
                yield f"id: {seq}\nevent: {type_}\ndata: {data}\n\n"
                if type_ in terminal:
                    return
            await asyncio.sleep(settings.sse_poll_seconds)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def _engine_alias(model: str) -> str:
    """Benchmark rows name engines, not vendors: the model behind the API is an
    implementation detail. Real configurations stay documented in the repo."""
    if model == "none":
        return "—"
    name = model.split("/")[-1].lower()
    if "7b" in name:
        return "Engine L"
    if "adapter" in name or "loc" in name:
        return "Engine S (tuned)"
    if "1.5b" in name or "3b" in name:
        return "Engine S"
    return "Engine"


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
                    "model": _engine_alias(run.model),
                    "n": n,
                    "file5": round(100 * sum(1 for x in m if x.get("file_acc_at_5")) / n, 1),
                    "func10": round(100 * sum(1 for x in m if x.get("func_acc_at_10")) / n, 1),
                    # The fine-tune's headline was parse failures, not accuracy, so the table
                    # has to carry it. Tokens are deliberately absent: model_calls is not
                    # populated per benchmark task, so a column would be mostly empty.
                    "parse_failures": sum(int(x.get("parse_failures") or 0) for x in m),
                    "commit": run.git_commit,
                    "date": run.started_at.strftime("%Y-%m-%d"),
                }
            )
        out.sort(key=lambda d: (-d["n"], -d["func10"]))
        return {"runs": out, "noise_floor_pp": 3.3}
