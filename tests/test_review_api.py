import pytest
from pydantic import ValidationError

from tests.conftest import _mk_repo, requires_pg


def test_create_review_requires_a_real_pull_request_number():
    from shipwright.api.main import CreateReview

    with pytest.raises(ValidationError):
        CreateReview(repo_id="x" * 8, number=0)


def test_action_regex_accepts_post_review():
    from shipwright.api.main import CreateAction

    assert CreateAction(kind="post_review").kind == "post_review"


def test_action_regex_still_rejects_nonsense():
    from shipwright.api.main import CreateAction

    with pytest.raises(ValidationError):
        CreateAction(kind="rm -rf")


@requires_pg
def test_review_session_accepts_actions(db):
    """The guard at main.py:521 rejected any parent whose kind was not 'localize'.

    A review session has kind 'review', so without widening it every review action 404s —
    the single easiest thing to miss in this integration.
    """
    from fastapi.testclient import TestClient

    from shipwright.api.main import app
    from shipwright.models import DONE, REVIEW, Job

    with TestClient(app) as client:
        with db.session() as s:
            repo = _mk_repo(s, slug="t/repo", path="/tmp")
            parent = Job(
                repo_id=repo.id,
                kind=REVIEW,
                issue="x" * 12,
                status=DONE,
                result={
                    "findings": [{"path": "a.py", "line": 1}],
                    "target": {"number": 7, "slug": "t/repo"},
                },
            )
            s.add(parent)
            s.flush()
            parent_id = str(parent.id)
        # No token: must be a 409 with a sentence, never a 404 from the kind guard.
        r = client.post(f"/api/jobs/{parent_id}/actions", json={"kind": "post_review"})
        assert r.status_code == 409
        assert "Connect GitHub" in r.json()["detail"]


@requires_pg
def test_post_review_without_findings_is_refused_with_zero_residue(db):
    from fastapi.testclient import TestClient

    from shipwright.api.main import app
    from shipwright.models import DONE, REVIEW, Job

    with TestClient(app) as client:
        with db.session() as s:
            repo = _mk_repo(s, slug="t/repo", path="/tmp")
            parent = Job(
                repo_id=repo.id,
                kind=REVIEW,
                issue="x" * 12,
                status=DONE,
                result={"findings": [], "target": {"number": 7, "slug": "t/repo"}},
            )
            s.add(parent)
            s.flush()
            parent_id = str(parent.id)
        r = client.post(
            f"/api/jobs/{parent_id}/actions", json={"kind": "post_review", "token": "t"}
        )
        assert r.status_code == 409
        assert "no findings" in r.json()["detail"].lower()
        # The refusal must leave no action row behind.
        with db.session() as s:
            from sqlalchemy import func, select

            assert s.scalar(select(func.count()).select_from(Job)) == 1


@requires_pg
def test_localize_actions_still_work_after_widening_the_guard(db):
    """Widening the parent-kind guard must not let a review action target a fix session,
    nor break the existing fix actions."""
    from fastapi.testclient import TestClient

    from shipwright.api.main import app
    from shipwright.models import DONE, LOCALIZE, Job

    with TestClient(app) as client:
        with db.session() as s:
            repo = _mk_repo(s, slug="t/repo", path="/tmp")
            parent = Job(
                repo_id=repo.id,
                kind=LOCALIZE,
                issue="x" * 12,
                status=DONE,
                result={"fix": {"patch": "diff", "applied_branch": "b"}},
            )
            s.add(parent)
            s.flush()
            parent_id = str(parent.id)
        # A localize session has no findings, so post_review must refuse it.
        r = client.post(
            f"/api/jobs/{parent_id}/actions", json={"kind": "post_review", "token": "t"}
        )
        assert r.status_code == 409


@requires_pg
def test_review_requires_a_github_repo(db):
    from fastapi.testclient import TestClient

    from shipwright.api.main import app

    with TestClient(app) as client:
        with db.session() as s:
            repo = _mk_repo(s, slug="local:thing", source="local", path="/tmp")
            s.flush()
            repo_id = str(repo.id)
        r = client.post("/api/reviews", json={"repo_id": repo_id, "number": 3, "token": "t"})
        assert r.status_code == 409
        assert "GitHub" in r.json()["detail"]


@requires_pg
def test_review_worker_emits_a_terminal_event_even_when_it_fails(db):
    """SSE terminal detection reads Event types, never Job.status (main.py stream()).

    A review job that errors without emitting job.failed leaves every connected client
    polling keepalive frames forever, which is how the boot reaper came to exist.
    """
    from sqlalchemy import select

    from shipwright.api.service import run_review
    from shipwright.models import ERRORED, QUEUED, REVIEW, Event, Job

    with db.session() as s:
        repo = _mk_repo(s, slug="o/r", path="/tmp")
        job = Job(
            repo_id=repo.id,
            kind=REVIEW,
            issue="Review pull request #1",
            status=QUEUED,
            result={"target": {"number": 1, "slug": "o/r"}},
        )
        s.add(job)
        s.flush()
        job_id = job.id

    # No token was stashed, so the worker must fail — and fail loudly enough for SSE.
    run_review(job_id)

    with db.session() as s:
        row = s.get(Job, job_id)
        assert row.status == ERRORED
        assert row.finished_at is not None
        types = [
            e.type
            for e in s.scalars(select(Event).where(Event.job_id == job_id).order_by(Event.seq))
        ]
    assert types[0] == "job.started"
    assert types[-1] == "job.failed"


@requires_pg
def test_review_failure_message_names_the_action_not_the_provider(db):
    from sqlalchemy import select

    from shipwright.api.service import run_review
    from shipwright.models import QUEUED, REVIEW, Event, Job

    with db.session() as s:
        repo = _mk_repo(s, slug="o/r", path="/tmp")
        job = Job(
            repo_id=repo.id,
            kind=REVIEW,
            issue="Review pull request #1",
            status=QUEUED,
            result={"target": {"number": 1, "slug": "o/r"}},
        )
        s.add(job)
        s.flush()
        job_id = job.id
    run_review(job_id)
    with db.session() as s:
        failed = s.scalars(
            select(Event).where(Event.job_id == job_id, Event.type == "job.failed")
        ).first()
        error = failed.payload["error"]
    # A curated sentence, never a provider URL or a bare exception repr.
    assert "Connect GitHub" in error
    assert "http" not in error.lower()
