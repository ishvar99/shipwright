import json

from sqlalchemy import select

from shipwright.models import DONE, ERRORED, QUEUED, RUNNING, Event, Job, Repo
from tests.conftest import requires_pg

pytestmark = requires_pg


def _mk_repo(s, **kw):
    defaults = dict(owner="", slug="o/r", source="github", status="ready", path="")
    r = Repo(**{**defaults, **kw})
    s.add(r)
    s.flush()
    return r


def test_reaper_errors_stale_jobs_and_emits_terminal_event(db):
    from shipwright.api.boot import reap_stale_jobs

    with db.session() as s:
        repo = _mk_repo(s, path="/tmp")
        stale = Job(repo_id=repo.id, issue="x" * 12, status=RUNNING)
        queued = Job(repo_id=repo.id, issue="q" * 12, status=QUEUED)
        done = Job(repo_id=repo.id, issue="y" * 12, status=DONE)
        s.add_all([stale, queued, done])
        s.flush()
        stale_id, queued_id, done_id = stale.id, queued.id, done.id

    assert reap_stale_jobs() == 2
    with db.session() as s:
        assert s.get(Job, stale_id).status == ERRORED
        assert s.get(Job, queued_id).status == ERRORED
        assert s.get(Job, done_id).status == DONE
        ev = s.scalars(select(Event).where(Event.job_id == stale_id)).all()
        # The SSE stream reads Event types for terminal state, never Job.status —
        # without this event a reconnecting client polls keepalives forever.
        assert [e.type for e in ev] == ["job.failed"] and ev[0].seq == 1


def test_heal_eventless_terminals(db):
    from shipwright.api.boot import heal_eventless_terminals
    from shipwright.api.service import emit

    with db.session() as s:
        repo = _mk_repo(s, path="/tmp")
        done_orphan = Job(
            repo_id=repo.id,
            issue="d" * 12,
            status=DONE,
            wall_ms=1234,
            result={"locations": [{"symbol": "s"}, {"symbol": "t"}]},
        )
        err_orphan = Job(repo_id=repo.id, issue="e" * 12, status=ERRORED, error="ConnectError")
        done_ok = Job(repo_id=repo.id, issue="k" * 12, status=DONE)
        running = Job(repo_id=repo.id, issue="r" * 12, status=RUNNING)
        s.add_all([done_orphan, err_orphan, done_ok, running])
        s.flush()
        ids = (done_orphan.id, err_orphan.id, done_ok.id, running.id)
    emit(ids[2], "job.done", wall_ms=1)  # done_ok already has its terminal event

    assert heal_eventless_terminals() == 2
    with db.session() as s:
        events = {
            job_id: list(s.scalars(select(Event).where(Event.job_id == job_id))) for job_id in ids
        }
    types = {job_id: [e.type for e in evs] for job_id, evs in events.items()}
    assert types[ids[0]] == ["job.done"]
    assert types[ids[1]] == ["job.failed"]
    assert types[ids[2]] == ["job.done"]  # not duplicated
    assert types[ids[3]] == []  # running jobs are the reaper's business, not the healer's

    # Healed events must carry real payloads — the frontend reducer reads e.locations and
    # classifies on the error name, so a healed stream cannot just say "0 locations".
    assert events[ids[0]][0].payload["wall_ms"] == 1234
    assert events[ids[0]][0].payload["locations"] == 2
    assert events[ids[1]][0].payload["error"] == "ConnectError"

    assert heal_eventless_terminals() == 0  # idempotent


def test_reconciler_fails_wedged_importing_and_missing_paths(db, tmp_path):
    from shipwright.api.boot import reconcile_repos

    with db.session() as s:
        wedged = _mk_repo(s, slug="a/wedged", status="importing", path="")
        gone = _mk_repo(s, slug="b/gone", status="ready", path=str(tmp_path / "nope"))
        alive = _mk_repo(s, slug="c/alive", status="ready", path=str(tmp_path))
        failed = _mk_repo(s, slug="d/failed", status="failed", path="")
        ids = (wedged.id, gone.id, alive.id, failed.id)

    assert reconcile_repos() == 2
    with db.session() as s:
        assert s.get(Repo, ids[0]).status == "failed"
        assert "re-import" in s.get(Repo, ids[0]).error
        assert s.get(Repo, ids[1]).status == "failed"
        assert s.get(Repo, ids[2]).status == "ready"
        assert s.get(Repo, ids[3]).status == "failed"  # untouched, still failed


def test_seeder_upserts_and_repairs(db, tmp_path):
    from shipwright.api import boot

    ws = tmp_path / "demo"
    ws.mkdir()
    manifest = tmp_path / "demos.json"
    manifest.write_text(
        json.dumps(
            [
                {
                    "slug": "demo/repo",
                    "url": "https://github.com/demo/repo",
                    "path": str(ws),
                    "import_ref": "a" * 40,
                    "default_ref": "abc1234",
                    "symbols": 42,
                    "files": 7,
                }
            ]
        )
    )

    assert boot.seed_demos(manifest) == 1
    assert "demo/repo" in boot.DEMO_SLUGS
    with db.session() as s:
        row = s.scalars(select(Repo).where(Repo.slug == "demo/repo")).first()
        assert row.status == "ready" and row.symbols == 42 and row.import_ref == "a" * 40

    # Second boot after the reconciler failed it: seeding repairs, not duplicates.
    with db.session() as s:
        row = s.scalars(select(Repo).where(Repo.slug == "demo/repo")).first()
        row.status, row.error = "failed", "workspace expired"
    assert boot.seed_demos(manifest) == 1
    with db.session() as s:
        rows = s.scalars(select(Repo).where(Repo.slug == "demo/repo")).all()
        assert len(rows) == 1 and rows[0].status == "ready"


def test_seeder_no_manifest_is_noop(db, tmp_path):
    from shipwright.api.boot import seed_demos

    assert seed_demos(tmp_path / "absent.json") == 0


def test_guarded_init_schema_is_idempotent(db):
    from shipwright.api.boot import guarded_init_schema

    guarded_init_schema()
    guarded_init_schema()  # second run must not raise


def test_demo_delete_guard(db):
    from fastapi.testclient import TestClient

    from shipwright.api import boot
    from shipwright.api.main import app

    with TestClient(app) as client:  # lifespan runs against the patched scratch DB
        with db.session() as s:
            demo = _mk_repo(s, slug="demo/protected", path="/tmp")
            other = _mk_repo(s, slug="user/own", path="/tmp")
            demo_id, other_id = str(demo.id), str(other.id)
        boot.DEMO_SLUGS.add("demo/protected")
        try:
            assert client.delete(f"/api/repos/{demo_id}").status_code == 403
            assert client.delete(f"/api/repos/{other_id}").status_code == 200
        finally:
            boot.DEMO_SLUGS.discard("demo/protected")
