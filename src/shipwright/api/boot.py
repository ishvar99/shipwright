"""Boot-time reconciliation for hosts that restart or wipe the filesystem.

Render's free tier spins the service down after 15 idle minutes and discards the disk,
and "Render might restart a Free web service at any time" is documented behaviour. Every
function here is idempotent and runs in the FastAPI lifespan, in this order:

    guarded_init_schema() -> reap_stale_jobs() -> heal_eventless_terminals()
        -> reconcile_repos() -> seed_demos()

Reconcile before seed, so a demo row the reconciler failed is repaired by the seeder.
Paths are cwd-relative by repo convention; boot must run from the repo root (or the image
WORKDIR), or the reconciler will persist a wrong-cwd boot as failed rows.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import select, text

from .. import db
from ..db import init_schema, session
from ..models import DONE, ERRORED, QUEUED, RUNNING, Event, Job, Repo

log = logging.getLogger("shipwright.boot")

# Advisory lock: overlapping deploys (old + new instance) otherwise run create_all
# concurrently, which can crash one of them on a duplicate-object race.
_SCHEMA_LOCK = 0x53472026

DEMO_MANIFEST = Path("workspaces/_demo/demos.json")
# Slugs seeded from the image. The delete endpoint refuses these: with OAuth unset,
# owner "" is a shared namespace, and one visitor must not remove the demo for the next.
DEMO_SLUGS: set[str] = set()


def guarded_init_schema() -> None:
    with db.engine.connect() as c:
        c.execute(text("SELECT pg_advisory_lock(:k)"), {"k": _SCHEMA_LOCK})
        try:
            init_schema()
        finally:
            c.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": _SCHEMA_LOCK})
            c.commit()


def reap_stale_jobs() -> int:
    """Jobs that were queued or running when the process died. Flip the row AND emit the
    terminal event: SSE terminal detection reads Event types (main.py stream()), never
    Job.status — without job.failed, a reconnecting client polls keepalives forever.
    emit() owns the per-job seq; a raw INSERT that guessed seq would corrupt resume order."""
    from .service import emit  # late import: service pulls in the tree-sitter stack

    with session() as s:
        stale = list(s.scalars(select(Job).where(Job.status.in_((QUEUED, RUNNING)))))
        for job in stale:
            job.status = ERRORED
            job.error = "HostRestart: the host restarted mid-job — run it again."
            job.finished_at = datetime.now(UTC)
    for job in stale:
        emit(job.id, "job.failed", error="HostRestart")
    if stale:
        log.info("reaped %d stale job(s)", len(stale))
    return len(stale)


def heal_eventless_terminals() -> int:
    """Terminal rows whose event stream never got its terminal event.

    Two writers create this state by crashing between their status commit and their
    emit(): the reaper above, and run_localize's own completion path. Without the
    terminal event the SSE stream polls keepalives forever — the client is purely
    event-driven and never consults Job.status. Idempotent: emitting the missing
    event removes the row from the next boot's query."""
    from .service import emit  # late import: service pulls in the tree-sitter stack

    terminal_events = select(Event.job_id).where(Event.type.in_(("job.done", "job.failed")))
    with session() as s:
        orphans = list(
            s.scalars(
                select(Job).where(Job.status.in_((DONE, ERRORED)), Job.id.not_in(terminal_events))
            )
        )
    for job in orphans:
        if job.status == DONE:
            emit(
                job.id,
                "job.done",
                wall_ms=job.wall_ms,
                locations=len((job.result or {}).get("locations") or []),
            )
        else:
            # The row carries the true exception name (run_localize commits it before
            # emitting); older rows may still hold "Name: detail" — keep the name.
            emit(job.id, "job.failed", error=(job.error or "HostRestart").split(":")[0])
    if orphans:
        log.info("healed %d event-less terminal job(s)", len(orphans))
    return len(orphans)


def reconcile_repos() -> int:
    """Rows pointing at a filesystem that no longer exists.

    Two shapes: (a) status 'importing' whose pool task died with the process — path is ''
    until success, and Path('') resolves to cwd, which EXISTS, so a path check alone
    misses them and the (owner, slug) unique constraint wedges every re-import; (b) ready
    rows whose workspace was on the wiped disk."""
    fixed = 0
    with session() as s:
        for repo in s.scalars(select(Repo)):
            if repo.status == "importing":
                repo.status = "failed"
                repo.error = "Import interrupted by a host restart — re-import to continue."
                fixed += 1
            elif repo.status == "ready" and (not repo.path or not Path(repo.path).is_dir()):
                repo.status = "failed"
                repo.error = "Workspace expired on the free host — re-import to continue."
                fixed += 1
    if fixed:
        log.info("reconciled %d repo row(s)", fixed)
    return fixed


def seed_demos(manifest: Path = DEMO_MANIFEST) -> int:
    """Upsert demo Repo rows from the manifest baked into the image at build time.

    symbols/files/import_ref come from the manifest (computed by scripts/bake_demos.py on
    the BUILD machine) because computing them here would cost minutes of 0.1-CPU boot per
    wake. import_ref matters: apply() bases fix branches on it, and without it one
    visitor's applied fix silently becomes the next visitor's base."""
    if not manifest.is_file():
        return 0
    entries = json.loads(manifest.read_text())
    with session() as s:
        for e in entries:
            DEMO_SLUGS.add(e["slug"])
            repo = s.scalars(
                select(Repo).where(Repo.owner == "", Repo.slug == e["slug"])
            ).first() or Repo(owner="", slug=e["slug"])
            repo.source = "github"
            repo.url = e["url"]
            repo.path = e["path"]
            repo.import_ref = e["import_ref"]
            repo.default_ref = e["default_ref"]
            repo.symbols = e["symbols"]
            repo.files = e["files"]
            repo.status, repo.error = "ready", ""
            s.add(repo)
    if entries:
        log.info("seeded %d demo repo(s)", len(entries))
    return len(entries)
