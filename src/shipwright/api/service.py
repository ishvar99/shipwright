"""Job execution for the product surface.

Reuses the same code graph, retrieval and assisted-localization path the benchmarks score,
so what a user sees in the UI is the configuration whose numbers are published. If these
diverged, the demo would be measuring something other than the results page.

Events are persisted before they are streamed, with a monotonic per-job `seq`, so a browser
that reconnects can resume from Last-Event-ID instead of losing the timeline.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import os
import re
import shutil
import subprocess
import threading
import time
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import func, select

from ..codegraph.assisted import localize_assisted
from ..codegraph.build import SKIP_DIRS, build
from ..codegraph.retrieve import Localizer
from ..config import settings
from ..db import session
from ..fix import FixError, generate_fix
from ..intent import CHANGE, OTHER, QUESTION, classify
from ..models import DONE, ERRORED, RUNNING, Event, Job, Repo
from . import github

WORKSPACES = Path("workspaces")

log = logging.getLogger("shipwright.jobs")

# One lock per repo id serialises every git-mutating operation (apply, test, save) so they
# never collide on .git/index.lock and a save's read-hash→write→commit stays atomic.
_REPO_LOCKS: dict[str, threading.Lock] = defaultdict(threading.Lock)

_DENY_TOP = {".git", ".shipwright-venv"}
MAX_EDIT_BYTES = 2_000_000
MAX_TREE_ENTRIES = 20_000
MAX_COMPRESSED_UPLOAD = 150 * 1024 * 1024


class RepoBusy(Exception):
    """An action holds the repo lock; the save is refused rather than queued."""


class SaveConflict(Exception):
    """The file changed since the editor loaded it. Carries the current sha so the client
    can offer Overwrite without a second read and a second race."""

    def __init__(self, current_sha: str) -> None:
        super().__init__("The file changed on disk since you opened it.")
        self.current_sha = current_sha


class FileTooLarge(Exception):
    pass


def repo_lock(repo_id) -> threading.Lock:
    return _REPO_LOCKS[str(repo_id)]


# A GitHub token for one open_pr job, in memory only for the hop from the request thread to
# the worker. Never on the job row: `result` is echoed back to the caller and stored in Postgres.
_TOKENS: dict[str, str] = {}


def stash_token(job_id, token: str) -> None:
    _TOKENS[str(job_id)] = token


def _take_token(job_id) -> str:
    return _TOKENS.pop(str(job_id), "")


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _scrub_creds(text: str) -> str:
    """Strip //user:token@ userinfo so a token in git stderr never reaches repo.error."""
    return re.sub(r"//[^/@\s]+@", "//***@", text)


def _fail_repo(repo_id, message: str) -> None:
    with session() as s:
        r = s.get(Repo, repo_id)
        r.status = "failed"
        r.error = _scrub_creds(message)[:500]


def _resolve_in_repo(repo_path: str, path: str) -> Path:
    """Containment + deny-list. read_symbol allows .git/config; repo-level endpoints must not."""
    root = Path(repo_path).resolve()
    target = (root / path).resolve()
    try:
        rel = target.relative_to(root)
    except ValueError as e:
        raise ValueError("path escapes repository") from e
    if rel.parts and rel.parts[0] in _DENY_TOP:
        raise ValueError("path is not accessible")
    return target


def emit(job_id, type_: str, **payload) -> None:
    with session() as s:
        seq = (
            s.scalar(select(func.coalesce(func.max(Event.seq), 0)).where(Event.job_id == job_id))
            or 0
        ) + 1
        s.add(Event(job_id=job_id, seq=seq, type=type_, payload=payload))


def _run_git(
    args: list[str],
    cwd: Path | None = None,
    timeout: int = 1800,
    env: dict[str, str] | None = None,
) -> tuple[bool, str]:
    r = subprocess.run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=timeout,
        env={**os.environ, **env} if env else None,
    )
    return r.returncode == 0, (r.stderr or r.stdout)[-400:]


def workspace_dir(owner: str, name: str) -> Path:
    """Owner-scoped only when there is an owner, so a single-user install keeps exactly the
    layout already on disk and nothing is orphaned. Two owners importing the same repository
    get two directories instead of silently sharing one.

    `name` is already the on-disk-safe form: each caller keeps the transform it has always
    used. Normalising them here looked tidier and silently moved every `local:`/`zip:` slug to
    a new path, which a retry would then re-materialize from scratch.
    """
    return WORKSPACES / owner.replace("/", "_") / name if owner else WORKSPACES / name


def import_repo(repo_id, token: str = "") -> None:
    """Clone (or adopt a local path) and index. Runs off the request thread. A token, when
    given, is used for exactly one clone and never persisted."""
    with session() as s:
        repo = s.get(Repo, repo_id)
        slug, source, url, path = repo.slug, repo.source, repo.url, repo.path
        owner = repo.owner

    try:
        if source == "local":
            src = Path(path).expanduser().resolve()
            if not src.exists():
                raise RuntimeError(f"path does not exist: {src}")
            if not (src / ".git").exists():
                raise RuntimeError("that folder is not a git repository")
            # Shipwright works on its own copy: applying a fix must never mutate the
            # user's checkout.
            dest = workspace_dir(owner, slug.replace("/", "__"))
            dest.parent.mkdir(parents=True, exist_ok=True)
            import_sha = _materialize(src, dest) if not (dest / ".git").exists() else ""
        else:
            dest = workspace_dir(owner, slug.replace("/", "__"))
            dest.parent.mkdir(parents=True, exist_ok=True)
            if not (dest / ".git").exists():
                ok, err = _clone(url, dest, token)
                if not ok:
                    raise RuntimeError(f"clone failed: {_scrub_creds(err)}")
                _enforce_clone_bound(dest)
            ok, import_sha = _run_git(["rev-parse", "HEAD"], cwd=dest, timeout=60)
            import_sha = import_sha.strip() if ok else ""

        graph = build(dest)
        stats = graph.stats()
        with session() as s:
            r = s.get(Repo, repo_id)
            r.path = str(dest)
            r.import_ref = import_sha
            r.symbols = stats["symbols"]
            r.files = stats["files"]
            r.status = "ready"
            ok, ref = _run_git(["rev-parse", "--short", "HEAD"], cwd=dest, timeout=60)
            r.default_ref = ref.strip() if ok else ""
    except Exception as e:
        _fail_repo(repo_id, f"{type(e).__name__}: {e}")


def import_zip(repo_id, zip_path: str) -> None:
    """Uploaded archive → owned workspace. Runs on IMPORT_POOL, off the request thread and
    off the job pool, so an extraction never queues behind two inference sessions."""
    from .importer import ZipRejected, extract, validate

    zp = Path(zip_path)
    try:
        with session() as s:
            row = s.get(Repo, repo_id)
            slug, owner = row.slug, row.owner
        dest = workspace_dir(owner, slug.replace("/", "__").replace(":", "_"))
        dest.parent.mkdir(parents=True, exist_ok=True)
        validate(zp)
        extract(zp, dest)
        import_sha = _git_init_owned(dest)
        graph = build(dest)
        stats = graph.stats()
        with session() as s:
            r = s.get(Repo, repo_id)
            r.path = str(dest)
            r.import_ref = import_sha
            r.symbols = stats["symbols"]
            r.files = stats["files"]
            r.status = "ready"
            ok, ref = _run_git(["rev-parse", "--short", "HEAD"], cwd=dest, timeout=60)
            r.default_ref = ref.strip() if ok else ""
        zp.unlink(missing_ok=True)
    except ZipRejected as e:
        _fail_repo(repo_id, str(e))  # curated copy, stored verbatim
        zp.unlink(missing_ok=True)
    except Exception as e:
        _fail_repo(repo_id, f"Import failed while reading the archive ({type(e).__name__}).")
        zp.unlink(missing_ok=True)


def reindex_repo(repo_id) -> None:
    """Rebuild the code graph for a workspace we already own. Deliberately does not fetch: the
    index is a snapshot of what is on disk, and what changes on disk is the fixes Shipwright
    applies. Pulling new commits is a different action with different failure modes."""
    try:
        with session() as s:
            dest = Path(s.get(Repo, repo_id).path)
        if not dest.is_dir():
            raise RuntimeError("the workspace for this repository is gone")
        graph = build(dest)
        stats = graph.stats()
        with session() as s:
            r = s.get(Repo, repo_id)
            r.symbols = stats["symbols"]
            r.files = stats["files"]
            r.status = "ready"
            ok, ref = _run_git(["rev-parse", "--short", "HEAD"], cwd=dest, timeout=60)
            r.default_ref = ref.strip() if ok else ""
    except Exception as e:
        # Back to ready, not failed. The previous index is still on disk and still correct —
        # marking the row failed would take the file browser, saves and new sessions down over
        # a refresh that was optional in the first place.
        with session() as s:
            r = s.get(Repo, repo_id)
            r.status = "ready"
            r.error = _scrub_creds(f"Re-index failed: {type(e).__name__}: {e}")[:500]


def _clone(url: str, dest: Path, token: str) -> tuple[bool, str]:
    """Credentials travel in an auth header supplied through git's environment config, never
    in the URL (which would land in .git/config and in clone's stderr) and never in argv
    (which any process on the box can read, base64 or not)."""
    env = None
    if token:
        basic = base64.b64encode(f"x-access-token:{token}".encode()).decode()
        env = {
            "GIT_CONFIG_COUNT": "1",
            "GIT_CONFIG_KEY_0": "http.extraHeader",
            "GIT_CONFIG_VALUE_0": f"Authorization: Basic {basic}",
        }
    ok, err = _run_git(["clone", "--depth", "1", url, str(dest)], env=env)
    if ok and token:
        # The workspace never needs the remote again, and keeping it would keep the
        # credential path alive.
        _run_git(["remote", "remove", "origin"], cwd=dest, timeout=60)
    return ok, err


def _enforce_clone_bound(dest: Path) -> None:
    """Reject working trees above the hosted size cap, removing what was cloned.

    lstat, not stat: a symlink's cost on disk is the link itself — following it would
    let a malicious repo inflate the sum (or point at /dev/zero-sized targets)."""
    if not settings.max_clone_mb:
        return
    used = sum(f.lstat().st_size for f in dest.rglob("*") if f.is_file())
    if used > settings.max_clone_mb * 1024 * 1024:
        shutil.rmtree(dest, ignore_errors=True)
        raise RuntimeError(
            f"repository is larger than the hosted limit "
            f"({settings.max_clone_mb} MB) — run Shipwright locally for big repos"
        )


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
        provider = None
        if mode in ("extract", "rerank", "extract_rerank"):
            from ..gateway.factory import make_provider

            provider = make_provider(model_name)

        # Route before working. Retrieval always returns its top-k and the fused score is
        # rank-derived, so nothing downstream can tell a question from a change request —
        # which is how a question ended up proposing an edit.
        emit(job_id, "intent.started")
        intent, reason = classify(issue, provider)
        emit(job_id, "intent.ready", intent=intent, reason=reason)

        if intent == OTHER:
            wall = int((time.perf_counter() - started) * 1000)
            with session() as s:
                j = s.get(Job, job_id)
                j.status = DONE
                j.model = ""
                # The reason travels with the result so the card can answer the subclass:
                # a capability question gets capabilities, not "nothing to work on".
                j.result = {
                    "locations": [],
                    "graph": {},
                    "fix": None,
                    "intent": intent,
                    "reason": reason,
                }
                j.wall_ms = wall
                j.finished_at = datetime.now(UTC)
            emit(job_id, "job.done", wall_ms=wall, locations=0)
            return

        if mode in ("extract", "rerank", "extract_rerank"):
            emit(job_id, "engine.started")
            ranked, usage = localize_assisted(
                graph,
                issue,
                mode=mode,
                model=provider,
                top_k=10,
                base_mode=base_mode,
                notify=lambda t, p: emit(job_id, t, **p),
            )
            emit(job_id, "engine.finished")
        else:
            usage = None
            model_name = ""
            emit(job_id, "search.started", channels=mode)
            ranked = Localizer(graph).localize(issue, mode=mode, top_k=10)
            emit(job_id, "candidates.found", count=len(ranked))

        results = []
        for i, r in enumerate(ranked, 1):
            sym = graph.symbols.get(r.symbol_id)
            results.append(
                {
                    "rank": i,
                    # Where retrieval put it before the model reordered. Without this, rank
                    # movement can only be reconstructed within the rows shown, which is a
                    # permutation and so can never show net gain.
                    "base_rank": r.base_rank,
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

        # Only a change request may end in an edit. A question gets the same search, and
        # stops there.
        fix_info = None
        answer = ""
        if intent == CHANGE and mode in ("rerank", "extract_rerank") and results:
            fix_info = _fix_stage(job_id, repo_path, issue, results, provider)
        elif intent == QUESTION and results:
            answer = _answer_stage(job_id, repo_path, issue, results, provider)

        wall = int((time.perf_counter() - started) * 1000)
        with session() as s:
            j = s.get(Job, job_id)
            j.status = DONE
            j.model = model_name
            j.result = {
                "locations": results,
                "graph": stats,
                "fix": fix_info,
                "intent": intent,
                "answer": answer,
            }
            j.input_tokens = usage.input_tokens if usage else 0
            j.output_tokens = usage.output_tokens if usage else 0
            j.wall_ms = wall
            j.finished_at = datetime.now(UTC)
        emit(job_id, "job.done", wall_ms=wall, locations=len(results))

    except Exception as e:
        # NAME only on the row and the wire (web/lib/errors.ts classifies on it); the full
        # repr can embed the provider URL via httpx, so it goes to server logs instead.
        log.exception("job %s failed", job_id)
        msg = type(e).__name__
        with session() as s:
            j = s.get(Job, job_id)
            j.status = ERRORED
            j.error = msg[:1000]
            j.wall_ms = int((time.perf_counter() - started) * 1000)
            j.finished_at = datetime.now(UTC)
        emit(job_id, "job.failed", error=type(e).__name__)


def run_review(job_id) -> None:
    """Review one pull request.

    Same terminal contract as run_localize: set the status and finished_at, then emit a
    terminal event — SSE detection reads Event types and never Job.status, so a kind that
    never emits one leaves every client polling keepalives forever.
    """
    started = time.perf_counter()
    # First statement, before any row lookup: an exception in the prelude would otherwise
    # strand a live GitHub token in _TOKENS for the life of the process.
    token = _take_token(job_id)
    with session() as s:
        job = s.get(Job, job_id)
        job.status = RUNNING
        target = dict((job.result or {}).get("target") or {})
        repo = s.get(Repo, job.repo_id)
        repo_path, slug = repo.path, repo.slug

    try:
        from ..gateway.factory import make_provider
        from ..review.run import review_diff
        from . import github_pr

        emit(job_id, "job.started", repo=slug, mode="review", base="")
        if not token:
            raise github.PullRequestError("Connect GitHub before reviewing a pull request.")

        pr = github_pr.fetch_pull_request(slug, int(target["number"]), token)
        emit(job_id, "review.fetched", files=len(pr["files"]), truncated=bool(pr["truncated"]))

        out = review_diff(
            root=Path(repo_path),
            files=pr["files"],
            intent=f"{pr['title']}\n\n{pr['body']}"[:4000],
            model=make_provider(settings.loc_model),
            notify=lambda t, p: emit(job_id, t, **p),
        )

        wall = int((time.perf_counter() - started) * 1000)
        with session() as s:
            j = s.get(Job, job_id)
            j.status = DONE
            j.model = settings.loc_model
            j.result = {
                **(j.result or {}),
                "target": {**target, "head_sha": pr["head_sha"], "title": pr["title"]},
                "findings": out["findings"],
                "coverage": out["coverage"],
                "complete": out["complete"],
            }
            j.input_tokens = out["usage"]["input_tokens"]
            j.output_tokens = out["usage"]["output_tokens"]
            j.wall_ms = wall
            j.finished_at = datetime.now(UTC)
        emit(job_id, "job.done", wall_ms=wall, locations=len(out["findings"]))

    except github.PullRequestError as e:
        # Already a sentence for the user and already free of credentials, so unlike the
        # generic handler this one is safe on the wire verbatim.
        msg = f"PullRequestError: {e}"
        with session() as s:
            j = s.get(Job, job_id)
            j.status = ERRORED
            j.error = msg[:400]
            j.wall_ms = int((time.perf_counter() - started) * 1000)
            j.finished_at = datetime.now(UTC)
        emit(job_id, "job.failed", error=msg[:400])
    except Exception as e:  # noqa: BLE001 - NAME only, see run_localize
        log.exception("review job %s failed", job_id)
        with session() as s:
            j = s.get(Job, job_id)
            j.status = ERRORED
            j.error = type(e).__name__[:1000]
            j.wall_ms = int((time.perf_counter() - started) * 1000)
            j.finished_at = datetime.now(UTC)
        emit(job_id, "job.failed", error=type(e).__name__)


def _answer_stage(job_id, repo_path: str, issue: str, results: list[dict], model) -> str:
    """A question deserves an answer, not just a list of files. Grounded in the code we
    actually found, so it cannot invent an architecture the repository does not have."""
    if not results or model is None:
        return ""
    context = []
    for r in results[:5]:
        try:
            window = read_symbol(repo_path, r["path"], r["start_line"], r["end_line"], pad=0)
        except ValueError:
            continue
        body = "\n".join(window["lines"][:40])
        context.append(f"--- {r['path']}:{r['start_line']} ({r['name']})\n{body}")
    if not context:
        return ""

    emit(job_id, "answer.started")
    prompt = (
        "Answer the question using only the code below. Be concrete and brief (3-5 "
        "sentences). Name the files and functions you rely on. If the code shown does not "
        "answer it, say so plainly. Never mention which AI model or provider you are — you "
        "are simply Shipwright.\n\n"
        f"Question: {issue}\n\nCode:\n" + "\n\n".join(context)[:12000]
    )
    try:
        result = model.generate(
            [{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=400,
            timeout=120.0,
            on_delta=lambda t: emit(job_id, "answer.delta", text=t),
        )
        emit(job_id, "answer.ready")
        return result.text.strip()[:2000]
    except Exception:  # noqa: BLE001 - the located results are still the product
        log.exception("answer stage failed for job %s", job_id)
        emit(job_id, "answer.failed")
        return ""


def _fix_stage(job_id, repo_path: str, issue: str, results: list[dict], model) -> dict | None:
    """Generate the fix for the top-ranked function, streaming the rewrite. Failure is a
    narrated state, not an exception: the located results are still the product."""
    target = next((r for r in results if r["kind"] == "function" and r["start_line"] > 0), None)
    if target is None:
        emit(job_id, "fix.skipped")
        return None
    emit(job_id, "fix.started", attempt=1)
    try:
        fix, _ = generate_fix(
            repo_path=repo_path,
            issue=issue,
            target=target,
            model=model,
            on_delta=lambda t: emit(job_id, "fix.delta", text=t),
        )
        emit(
            job_id,
            "fix.ready",
            files=fix["files"],
            additions=fix["additions"],
            deletions=fix["deletions"],
            attempt=fix["attempt"],
        )
        return fix
    except FixError as e:
        emit(job_id, "fix.failed", reason=str(e))
        return {"failed": str(e)}
    except Exception as e:  # noqa: BLE001 - the located results are still the product
        # Provider failures (429 after retries, timeouts) must not error the whole job:
        # localization already succeeded and is worth showing.
        log.exception("fix stage failed for job %s", job_id)
        emit(job_id, "fix.failed", reason=type(e).__name__)
        return {"failed": type(e).__name__}


def _git_init_owned(dest: Path) -> str:
    """Fresh git identity over an already-populated tree; returns the import commit sha.
    Shared by _materialize (git sources) and zip import (which has no source git)."""
    for args in (
        ["init", "-q"],
        ["config", "user.email", "fix@shipwright.local"],
        ["config", "user.name", "Shipwright"],
        ["add", "-A"],
        ["commit", "-q", "-m", "shipwright import"],
    ):
        ok, err = _run_git(args, cwd=dest, timeout=120)
        if not ok:
            raise RuntimeError(f"workspace setup failed: {err[-120:]}")
    # Repo-local, uncommitted ignore: `git add -A` during apply must never sweep the test
    # environment into a fix commit.
    exclude = dest / ".git" / "info" / "exclude"
    exclude.parent.mkdir(parents=True, exist_ok=True)
    exclude.write_text(".shipwright-venv/\n")
    ok, sha = _run_git(["rev-parse", "HEAD"], cwd=dest, timeout=60)
    return sha.strip() if ok else ""


def _materialize(src: Path, dest: Path) -> str:
    """A fully-owned copy of the checkout: `git archive` of HEAD into a fresh `git init`.
    Survives shallow and partial sources (`clone --local` does not), and carries no remotes,
    so a token-bearing origin URL never travels into our copy. Returns the import sha."""
    dest.mkdir(parents=True, exist_ok=True)
    archive = subprocess.Popen(["git", "archive", "HEAD"], cwd=src, stdout=subprocess.PIPE)
    extract = subprocess.run(["tar", "-x", "-C", str(dest)], stdin=archive.stdout, timeout=300)
    archive.wait(timeout=300)
    if archive.returncode != 0 or extract.returncode != 0:
        raise RuntimeError("could not copy the repository")
    return _git_init_owned(dest)


def _owned_clone(repo_id) -> Path:
    """Actions mutate; mutation happens only in a clone Shipwright owns. Legacy rows imported
    before this rule point at external checkouts (including the eval corpus) — migrate them
    on first action rather than trusting every historical path."""
    with session() as s:
        repo = s.get(Repo, repo_id)
        current = Path(repo.path).resolve()
        workspace = WORKSPACES.resolve()
        if current.is_relative_to(workspace):
            return current
        dest = workspace_dir(repo.owner, repo.slug.replace("/", "__"))
        if not (dest / ".git").exists():
            _materialize(current, dest)
        repo.path = str(dest)
        return dest


def _venv_python(repo: Path) -> Path:
    return repo / ".shipwright-venv" / "bin" / "python"


def _ensure_test_env(job_id, repo: Path) -> Path:
    py = _venv_python(repo)
    # A missing interpreter raises before any returncode exists.
    if py.exists():
        probe = subprocess.run([str(py), "-c", "import pytest"], capture_output=True)
        if probe.returncode == 0:
            return py
    emit(job_id, "env.started")
    venv = repo / ".shipwright-venv"
    for cmd in (
        ["uv", "venv", str(venv), "-q"],
        ["uv", "pip", "install", "-q", "-p", str(py), "-e", str(repo), "pytest"],
    ):
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if r.returncode != 0:
            raise RuntimeError(f"test environment setup failed: {r.stderr[-300:]}")
    emit(job_id, "env.ready")
    return py


def _test_targets(repo: Path, touched: str) -> list[str]:
    """tests/test_<module>.py when it exists, else the tests directory."""
    module = Path(touched).stem
    candidate = repo / "tests" / f"test_{module}.py"
    if candidate.exists():
        return [str(candidate.relative_to(repo))]
    return ["tests"] if (repo / "tests").is_dir() else ["."]


def run_action(job_id) -> None:
    """Apply / test / fix-again, each its own job so the session stream's terminal semantics
    stay intact. Outcomes are written back onto the parent's result.fix."""
    started = time.perf_counter()
    # First statement in the function, before any row lookup: the prelude below dereferences
    # rows that a concurrent unlink can delete, and an exception there would strand a live
    # GitHub token in _TOKENS for the life of the process.
    token = _take_token(job_id)
    with session() as s:
        job = s.get(Job, job_id)
        job.status = RUNNING
        kind = job.kind
        meta = dict(job.result or {})
        parent_id = meta.get("parent")
        parent = s.get(Job, parent_id)
        issue = parent.issue
        parent_result = dict(parent.result or {})
        repo_id = job.repo_id
    fix = dict(parent_result.get("fix") or {})

    def write_back(updated_fix: dict) -> None:
        with session() as s:
            p = s.get(Job, parent_id)
            p.result = {**(p.result or {}), "fix": updated_fix}

    try:
        # Inside the guard: an exception before the first emit would otherwise vanish into
        # the executor's unread Future and leave the job silently RUNNING forever.
        repo_dir = _owned_clone(repo_id)
        repo_path = str(repo_dir)
        if kind == "apply":
            emit(job_id, "apply.started")
            # The attempt is in the name from the second one on. `checkout -B` RESETS the
            # branch onto the import commit, so reusing the name after a retry would ask
            # GitHub to rewrite a branch it already has — rejected, permanently, with the
            # first attempt's pull request still open against it.
            attempt = int(fix.get("attempt") or 1)
            branch = f"shipwright/fix-{str(parent_id)[:8]}" + ("" if attempt < 2 else f"-{attempt}")
            with repo_lock(repo_id):
                with session() as s:
                    base = s.get(Repo, repo_id).import_ref or "HEAD"
                # Base on the import commit, not HEAD: the workspace may still be parked on
                # an earlier fix branch, and branching off it would fold that fix and every
                # editor commit into this one's history.
                ok, err = _run_git(["checkout", "-B", branch, base], cwd=repo_dir, timeout=60)
                if not ok:
                    raise RuntimeError(f"branch failed: {err}")
                r = subprocess.run(
                    ["git", "apply", "-"],
                    input=fix["patch"],
                    text=True,
                    capture_output=True,
                    cwd=repo_dir,
                )
                if r.returncode != 0:
                    raise RuntimeError(f"apply failed: {r.stderr[-200:]}")
                _run_git(["add", "-A"], cwd=repo_dir, timeout=60)
                title = issue.splitlines()[0][:60]
                ok, err = _run_git(
                    ["commit", "-m", f"shipwright: {title}"], cwd=repo_dir, timeout=60
                )
                if not ok:
                    raise RuntimeError(f"commit failed: {err}")
            fix["applied_branch"] = branch
            # Both belong to the previous state of this fix; leaving either would attach a
            # stale test result or a link to somebody's already-open PR to a new change.
            fix.pop("tests", None)
            fix.pop("pr_url", None)
            write_back(fix)
            emit(job_id, "apply.done", branch=branch)

        elif kind == "test":
            py = _ensure_test_env(job_id, repo_dir)
            targets = _test_targets(repo_dir, fix["target"]["path"])
            emit(job_id, "test.started")
            # Locked: a save landing mid-run would test a tree the user has since changed.
            with repo_lock(repo_id):
                proc = subprocess.run(
                    [str(py), "-m", "pytest", *targets, "--no-header", "-q"],
                    capture_output=True,
                    text=True,
                    cwd=repo_dir,
                    timeout=180,
                )
            out = (proc.stdout or "") + (proc.stderr or "")
            tail = out[-2000:]
            for i in range(0, min(len(tail), 2000), 700):
                emit(job_id, "test.output", text=tail[i : i + 700])
            passed = failed = 0
            m = re.search(r"(\d+) passed", out)
            passed = int(m.group(1)) if m else 0
            m = re.search(r"(\d+) failed", out)
            failed = int(m.group(1)) if m else 0
            m = re.search(r"(\d+) error", out)
            failed += int(m.group(1)) if m else 0
            fix["tests"] = {"passed": passed, "failed": failed, "tail": tail}
            write_back(fix)
            emit(job_id, "test.done", passed=passed, failed=failed)

        elif kind == "fix_retry":
            symbol = meta.get("symbol", "")
            locations = parent_result.get("locations") or []
            target = next(
                (loc for loc in locations if loc["symbol"] == symbol),
                None,
            ) or next(
                (loc for loc in locations if loc["kind"] == "function" and loc["start_line"] > 0),
                None,
            )
            if target is None:
                raise RuntimeError("no function to fix")
            feedback = "" if symbol else (fix.get("tests") or {}).get("tail", "")
            attempt = int(fix.get("attempt") or 1) + 1
            emit(job_id, "fix.started", attempt=attempt)
            from ..gateway.factory import make_provider

            new_fix, _ = generate_fix(
                repo_path=repo_path,
                issue=issue,
                target=target,
                model=make_provider(settings.loc_model),
                on_delta=lambda t: emit(job_id, "fix.delta", text=t),
                feedback=feedback,
            )
            new_fix["attempt"] = attempt
            write_back(new_fix)
            emit(
                job_id,
                "fix.ready",
                files=new_fix["files"],
                additions=new_fix["additions"],
                deletions=new_fix["deletions"],
                attempt=attempt,
            )
        elif kind == "open_pr":
            with session() as s:
                slug = s.get(Repo, repo_id).slug
            branch = fix["applied_branch"]
            emit(job_id, "pr.started", branch=branch, slug=slug)
            if not token:
                raise github.PullRequestError("Connect GitHub before opening a pull request.")
            # Locked: a test run mid-push would have the branch checked out from under us.
            with repo_lock(repo_id):
                github.push_branch(repo_dir, slug, branch, token)
            base = github.default_branch(slug, token)
            title = f"shipwright: {(issue.strip().splitlines() or ['fix'])[0][:60]}"
            pr = github.open_pull_request(
                slug, branch, base, title, github.pr_body(issue, fix), token
            )
            fix["pr_url"] = pr["url"]
            write_back(fix)
            emit(job_id, "pr.ready", url=pr["url"], number=pr["number"])

        elif kind == "post_review":
            from ..review.render import to_github_review
            from . import github_pr

            findings = parent_result.get("findings") or []
            target = parent_result.get("target") or {}
            with session() as s:
                slug = s.get(Repo, repo_id).slug
            emit(job_id, "pr.started", branch="", slug=slug)
            if not token:
                raise github.PullRequestError("Connect GitHub before posting a review.")
            payload = to_github_review(
                findings, target.get("head_sha", ""), parent_result.get("coverage") or {}
            )
            posted = github_pr.post_review(
                target.get("slug") or slug, int(target["number"]), payload, token
            )
            with session() as s:
                p = s.get(Job, parent_id)
                p.result = {**(p.result or {}), "review_url": posted["url"]}
            emit(job_id, "pr.ready", url=posted["url"], number=int(target["number"]))

        else:
            raise RuntimeError(f"unknown action: {kind}")

        wall = int((time.perf_counter() - started) * 1000)
        with session() as s:
            j = s.get(Job, job_id)
            j.status = DONE
            j.wall_ms = wall
            j.result = {**meta, "ok": True}
            j.finished_at = datetime.now(UTC)
        emit(job_id, "job.done", wall_ms=wall, locations=0)
    except FixError as e:
        with session() as s:
            j = s.get(Job, job_id)
            j.status = ERRORED
            j.error = str(e)[:400]
            j.finished_at = datetime.now(UTC)
        emit(job_id, "fix.failed", reason=str(e))
        emit(job_id, "job.failed", error=str(e)[:400])
    except github.PullRequestError as e:
        # Already a sentence for the user, and already free of git stderr, so unlike the
        # generic handler below this one is safe to put on the wire verbatim. The name is kept
        # in front of it so the client shows this sentence instead of its own generic copy.
        msg = f"PullRequestError: {e}"
        with session() as s:
            j = s.get(Job, job_id)
            j.status = ERRORED
            j.error = msg[:400]
            j.finished_at = datetime.now(UTC)
        emit(job_id, "pr.failed", reason=str(e))
        emit(job_id, "job.failed", error=msg[:400])
    except Exception as e:
        # NAME only — see run_localize's handler.
        log.exception("job %s failed", job_id)
        msg = type(e).__name__
        with session() as s:
            j = s.get(Job, job_id)
            j.status = ERRORED
            j.error = msg[:1000]
            j.finished_at = datetime.now(UTC)
        emit(job_id, "job.failed", error=type(e).__name__)


def read_symbol(repo_path: str, path: str, start: int, end: int, pad: int = 8) -> dict:
    """Source for the detail pane. Bounded, and refuses to escape the repo."""
    root = Path(repo_path).resolve()
    target = (root / path).resolve()
    try:
        # relative_to, not a string prefix: a sibling directory named "<root>-x" passes
        # startswith while living outside the repo.
        target.relative_to(root)
    except ValueError as e:
        raise ValueError("path escapes repository") from e
    # An empty path resolves to the root directory, which read_text would raise on.
    if not target.is_file():
        raise ValueError("not a file")
    if target.stat().st_size > 2_000_000:
        raise ValueError("file too large")

    lines = target.read_text(errors="replace").splitlines()
    lo = max(0, (start or 1) - 1 - pad)
    hi = min(len(lines), (end or start or 1) + pad)
    return {"path": path, "start": lo + 1, "lines": lines[lo:hi]}


def read_whole_file(repo_path: str, path: str) -> dict:
    """The editor's read. Strict decoding: errors="replace" would turn a cp1252 file into
    U+FFFD characters that a later save writes back as permanent corruption."""
    target = _resolve_in_repo(repo_path, path)
    if not target.is_file():
        raise ValueError("not a file")
    if target.stat().st_size > MAX_EDIT_BYTES:
        return {"path": path, "content": "", "sha": "", "reason": "too_large"}
    raw = target.read_bytes()
    if b"\x00" in raw[:8192]:
        return {"path": path, "content": "", "sha": "", "reason": "binary"}
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return {"path": path, "content": "", "sha": "", "reason": "binary"}
    return {"path": path, "content": text, "sha": _sha(raw), "reason": None}


def build_tree(repo_path: str) -> dict:
    """Every file the editor may open, plus the branch actually checked out — after an apply
    the workspace sits on shipwright/fix-*, and the UI has to say so rather than guess."""
    root = Path(repo_path).resolve()
    entries: list[dict] = []
    truncated = False
    for file in sorted(root.rglob("*")):
        if len(entries) >= MAX_TREE_ENTRIES:
            truncated = True
            break
        rel = file.relative_to(root)
        # Same exclusions the graph build uses, so the tree can't show .git or the test venv.
        if any(p.startswith(".") for p in rel.parts[:-1]) or rel.parts[0].startswith("."):
            continue
        if any(p in SKIP_DIRS for p in rel.parts):
            continue
        if file.is_symlink() or not file.is_file():
            continue
        entries.append({"path": str(rel), "size": file.stat().st_size})
    branch = head = ""
    ok, out = _run_git(["rev-parse", "--abbrev-ref", "HEAD"], cwd=root, timeout=30)
    if ok:
        branch = out.strip()
    ok, out = _run_git(["rev-parse", "--short", "HEAD"], cwd=root, timeout=30)
    if ok:
        head = out.strip()
    return {"entries": entries, "truncated": truncated, "branch": branch, "head": head}


def save_file(repo_id, path: str, content: str, base_sha: str) -> dict:
    """Write + commit, atomically per repo. Auto-committing keeps the working tree clean so
    apply's `git add -A` can never sweep a manual edit into a fix commit."""
    if len(content.encode("utf-8")) > MAX_EDIT_BYTES:
        raise FileTooLarge("That file is too large to save (limit 2 MB).")
    lock = repo_lock(repo_id)
    # Non-blocking: an apply holding this lock is a "busy", not a queue to wait in.
    if not lock.acquire(blocking=False):
        raise RepoBusy("A fix job is running on this repository. Try again in a moment.")
    try:
        # Mutation happens only in a clone we own — repo.path may still be the user's own
        # checkout for rows imported before that rule.
        root = _owned_clone(repo_id)
        target = _resolve_in_repo(str(root), path)
        if not target.is_file():
            raise ValueError("not a file")
        raw = target.read_bytes()
        current = _sha(raw)
        if current != base_sha:
            raise SaveConflict(current)
        had_bom = raw.startswith(b"\xef\xbb\xbf")
        new_raw = (b"\xef\xbb\xbf" if had_bom else b"") + content.encode("utf-8")
        if new_raw == raw:
            return {"sha": current, "commit": None}  # no-op: git commit would exit 1
        target.write_bytes(new_raw)
        new_sha = _sha(new_raw)
        _run_git(["add", "--", path], cwd=root, timeout=60)
        ok, err = _run_git(
            ["commit", "-m", f"edit: {path} (Shipwright editor)"], cwd=root, timeout=60
        )
        if not ok:
            raise RuntimeError(f"commit failed: {err[-200:]}")
        ok, short = _run_git(["rev-parse", "--short", "HEAD"], cwd=root, timeout=30)
        return {"sha": new_sha, "commit": short.strip() if ok else None}
    finally:
        lock.release()
