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

    with TestClient(app) as client:
        with db.session() as s:
            repo = _mk_repo(s, slug="t/repo", path="/tmp")
            parent_id = _review_job(
                s,
                repo,
                result={"triage": {"a.py:2:security": {"state": "kept", "reason": ""}}},
            )
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


def _review_job(s, repo, status=None, result=None):
    """A DONE review job with one finding. `result` shallow-merges OVER the defaults —
    callers can replace `findings` but cannot remove `target`."""
    from shipwright.models import DONE, REVIEW, Job

    job = Job(
        repo_id=repo.id,
        kind=REVIEW,
        issue="Review pull request #7",
        status=status or DONE,
        result={
            "findings": [
                {
                    "path": "a.py",
                    "line": 2,
                    "category": "security",
                    "severity": "high",
                    "title": "t",
                    "body": "b",
                    "side": "RIGHT",
                    "source": "llm",
                    "rule": "",
                    "end_line": 2,
                    "evidence": [],
                    "hunk": "",
                },
            ],
            "target": {"number": 7, "slug": "t/repo"},
            **(result or {}),
        },
    )
    s.add(job)
    s.flush()
    return str(job.id)


@requires_pg
def test_triage_saves_decisions_on_the_row(db):
    from fastapi.testclient import TestClient

    from shipwright.api.main import app
    from shipwright.models import Job

    with TestClient(app) as client:
        with db.session() as s:
            job_id = _review_job(s, _mk_repo(s, slug="t/repo", path="/tmp"))
        r = client.post(
            f"/api/jobs/{job_id}/triage",
            json={"decisions": {"a.py:2:security": {"state": "kept", "reason": ""}}},
        )
        assert r.status_code == 200
        assert r.json()["kept"] == 1
        with db.session() as s:
            row = s.get(Job, job_id)
            assert row.result["triage"]["a.py:2:security"]["state"] == "kept"


@requires_pg
def test_triage_rejects_a_key_not_in_the_review(db):
    from fastapi.testclient import TestClient

    from shipwright.api.main import app

    with TestClient(app) as client:
        with db.session() as s:
            job_id = _review_job(s, _mk_repo(s, slug="t/repo", path="/tmp"))
        r = client.post(
            f"/api/jobs/{job_id}/triage",
            json={"decisions": {"other.py:9:quality": {"state": "kept", "reason": ""}}},
        )
        assert r.status_code == 400
        assert "part of this review" in r.json()["detail"]


@requires_pg
def test_dismissal_requires_a_reason(db):
    from fastapi.testclient import TestClient

    from shipwright.api.main import app

    with TestClient(app) as client:
        with db.session() as s:
            job_id = _review_job(s, _mk_repo(s, slug="t/repo", path="/tmp"))
        r = client.post(
            f"/api/jobs/{job_id}/triage",
            json={"decisions": {"a.py:2:security": {"state": "dismissed", "reason": ""}}},
        )
        assert r.status_code == 400
        assert "reason" in r.json()["detail"].lower()


@requires_pg
def test_triage_on_a_localize_session_is_a_404(db):
    from fastapi.testclient import TestClient

    from shipwright.api.main import app
    from shipwright.models import DONE, Job

    with TestClient(app) as client:
        with db.session() as s:
            repo = _mk_repo(s, slug="t/repo", path="/tmp")
            job = Job(repo_id=repo.id, issue="x" * 12, status=DONE)
            s.add(job)
            s.flush()
            job_id = str(job.id)
        r = client.post(
            f"/api/jobs/{job_id}/triage",
            json={"decisions": {}},
        )
        assert r.status_code == 404


@requires_pg
def test_triage_before_the_review_finishes_is_a_409(db):
    from fastapi.testclient import TestClient

    from shipwright.api.main import app
    from shipwright.models import RUNNING

    with TestClient(app) as client:
        with db.session() as s:
            job_id = _review_job(s, _mk_repo(s, slug="t/repo", path="/tmp"), status=RUNNING)
        r = client.post(f"/api/jobs/{job_id}/triage", json={"decisions": {}})
        assert r.status_code == 409


@requires_pg
def test_a_kept_finding_carries_no_reason(db):
    from fastapi.testclient import TestClient

    from shipwright.api.main import app

    with TestClient(app) as client:
        with db.session() as s:
            job_id = _review_job(s, _mk_repo(s, slug="t/repo", path="/tmp"))
        r = client.post(
            f"/api/jobs/{job_id}/triage",
            json={"decisions": {"a.py:2:security": {"state": "kept", "reason": "not_real"}}},
        )
        assert r.status_code == 400
        assert "no reason" in r.json()["detail"].lower()


@requires_pg
def test_triage_is_a_whole_map_replace(db):
    """The docstring's headline claim: last write wins, including clearing."""
    from fastapi.testclient import TestClient

    from shipwright.api.main import app
    from shipwright.models import Job

    with TestClient(app) as client:
        with db.session() as s:
            job_id = _review_job(s, _mk_repo(s, slug="t/repo", path="/tmp"))
        first = client.post(
            f"/api/jobs/{job_id}/triage",
            json={"decisions": {"a.py:2:security": {"state": "kept", "reason": ""}}},
        )
        assert first.status_code == 200
        # Asserted between the posts: without this, the test passes vacuously if the
        # first write were a no-op.
        with db.session() as s:
            assert s.get(Job, job_id).result["triage"] == {
                "a.py:2:security": {"state": "kept", "reason": ""}
            }
        second = client.post(f"/api/jobs/{job_id}/triage", json={"decisions": {}})
        assert second.status_code == 200
        with db.session() as s:
            assert s.get(Job, job_id).result["triage"] == {}


@requires_pg
def test_one_bad_entry_refuses_the_whole_save(db):
    """All-or-nothing: a partial write would let a stale client post dismissed findings."""
    from fastapi.testclient import TestClient

    from shipwright.api.main import app
    from shipwright.models import Job

    with TestClient(app) as client:
        with db.session() as s:
            job_id = _review_job(s, _mk_repo(s, slug="t/repo", path="/tmp"))
        r = client.post(
            f"/api/jobs/{job_id}/triage",
            json={
                "decisions": {
                    "a.py:2:security": {"state": "kept", "reason": ""},
                    "ghost.py:9:quality": {"state": "kept", "reason": ""},
                }
            },
        )
        assert r.status_code == 400
        with db.session() as s:
            assert "triage" not in (s.get(Job, job_id).result or {})


@requires_pg
def test_triage_is_owner_scoped(db):
    """bob cannot triage alice's review — and cannot learn it exists."""
    from fastapi.testclient import TestClient

    from shipwright.api.main import app

    with TestClient(app) as client:
        with db.session() as s:
            repo = _mk_repo(s, slug="t/repo", path="/tmp")
            repo.owner = "gh:alice"
            job_id = _review_job(s, repo)
        with db.session() as s:
            from shipwright.models import Job

            s.get(Job, job_id).owner = "gh:alice"
        r = client.post(
            f"/api/jobs/{job_id}/triage",
            json={"decisions": {}},
            headers={"x-shipwright-owner": "gh:bob"},
        )
        assert r.status_code == 404


@requires_pg
def test_more_decisions_than_findings_is_refused(db):
    """The bound guard speaks in a curated sentence, not pydantic's generic 422 —
    the detail assertion below is what isolates it from the unknown-key 400."""
    from fastapi.testclient import TestClient

    from shipwright.api.main import app
    from shipwright.review.merge import MAX_FINDINGS

    with TestClient(app) as client:
        with db.session() as s:
            job_id = _review_job(s, _mk_repo(s, slug="t/repo", path="/tmp"))
        oversized = {
            f"a.py:{i}:security": {"state": "kept", "reason": ""} for i in range(MAX_FINDINGS + 1)
        }
        r = client.post(f"/api/jobs/{job_id}/triage", json={"decisions": oversized})
        assert r.status_code == 400
        assert "more decisions" in r.json()["detail"].lower()


@requires_pg
def test_post_review_requires_a_kept_finding(db):
    """Findings exist but none is kept: undecided never posts."""
    from fastapi.testclient import TestClient

    from shipwright.api.main import app

    with TestClient(app) as client:
        with db.session() as s:
            job_id = _review_job(s, _mk_repo(s, slug="t/repo", path="/tmp"))
        r = client.post(f"/api/jobs/{job_id}/actions", json={"kind": "post_review", "token": "t"})
        assert r.status_code == 409
        assert "keep at least one" in r.json()["detail"].lower()


@requires_pg
def test_post_review_payload_contains_only_kept_findings(db, monkeypatch):
    from shipwright.api.service import run_action, stash_token
    from shipwright.models import Job

    posted = {}

    def fake_post(slug, number, payload, token, **kw):
        posted.update(payload)
        return {"url": "https://gh/r/1", "id": 1}

    monkeypatch.setattr("shipwright.api.github_pr.post_review", fake_post)

    with db.session() as s:
        # A workspace-relative path, not "/tmp": _owned_clone (called by run_action for
        # every kind) short-circuits to this path unmaterialized when it already resolves
        # under workspaces/, which is all post_review needs — it never touches repo_dir.
        # "/tmp" would instead hit _materialize's `git archive HEAD`, which fails because
        # /tmp is not a git repository, and that failure has nothing to do with triage.
        repo = _mk_repo(s, slug="t/repo", path="workspaces/_test_post_review")
        parent_id = _review_job(
            s,
            repo,
            result={
                "findings": [
                    {
                        "path": "a.py",
                        "line": 2,
                        "category": "security",
                        "severity": "high",
                        "title": "keep me",
                        "body": "b",
                        "side": "RIGHT",
                        "source": "llm",
                        "rule": "",
                        "end_line": 2,
                        "evidence": [],
                        "hunk": "",
                    },
                    {
                        "path": "a.py",
                        "line": 3,
                        "category": "quality",
                        "severity": "low",
                        "title": "dismiss me",
                        "body": "b",
                        "side": "RIGHT",
                        "source": "llm",
                        "rule": "",
                        "end_line": 3,
                        "evidence": [],
                        "hunk": "",
                    },
                ],
                "triage": {
                    "a.py:2:security": {"state": "kept", "reason": ""},
                    "a.py:3:quality": {"state": "dismissed", "reason": "not_real"},
                },
                "coverage": {
                    "files": 1,
                    "reviewed": 1,
                    "unreviewed": [],
                    "degraded": [],
                    "tier": "graph",
                },
                "target": {"number": 7, "slug": "t/repo", "head_sha": "abc"},
            },
        )
        action = Job(
            repo_id=repo.id,
            kind="post_review",
            issue="x" * 12,
            status="queued",
            result={"parent": parent_id},
        )
        s.add(action)
        s.flush()
        action_id = action.id
    stash_token(action_id, "tok")
    run_action(action_id)

    bodies = [c["body"] for c in posted["comments"]]
    assert any("keep me" in b for b in bodies)
    assert not any("dismiss me" in b for b in bodies)
    with db.session() as s:
        parent = s.get(Job, parent_id)
        assert parent.result["review_url"] == "https://gh/r/1"


@requires_pg
def test_a_late_dismissal_fails_the_post_with_narration(db):
    """The race the worker re-check exists for: the request passed the kept precondition,
    then the user dismissed everything before the worker ran.

    review.post.started must precede the failure, or narrate() has no open beat to mark
    failed and the job fails with no line in the activity feed at all.
    """
    from sqlalchemy import select

    from shipwright.api.service import run_action, stash_token
    from shipwright.models import Event, Job

    with db.session() as s:
        repo = _mk_repo(s, slug="t/repo", path="workspaces/_test_post_review")
        parent_id = _review_job(
            s,
            repo,
            result={"triage": {"a.py:2:security": {"state": "dismissed", "reason": "not_real"}}},
        )
        action = Job(
            repo_id=repo.id,
            kind="post_review",
            issue="x" * 12,
            status="queued",
            result={"parent": parent_id},
        )
        s.add(action)
        s.flush()
        action_id = action.id
    stash_token(action_id, "tok")
    run_action(action_id)

    with db.session() as s:
        types = [
            e.type
            for e in s.scalars(select(Event).where(Event.job_id == action_id).order_by(Event.seq))
        ]
    assert "review.post.started" in types
    assert types.index("review.post.started") < types.index("review.post.failed")
    assert types[-1] == "job.failed"


@requires_pg
def test_a_second_review_of_the_same_pr_supersedes_the_first(db, monkeypatch):
    from fastapi.testclient import TestClient

    import shipwright.api.main as main
    from shipwright.api.main import app
    from shipwright.models import Job

    # The pool is stubbed, and that is not fastidiousness: reviews_create stashes a real
    # token, so a live worker would call api.github.com from a detached thread — and land
    # after the db fixture has restored SessionLocal to the developer's own database.
    # Asserting the dispatch instead pins the contract this endpoint actually owns.
    submitted: list[str] = []
    monkeypatch.setattr(main.POOL, "submit", lambda fn, *a: submitted.append(fn.__name__))

    with TestClient(app) as client:
        with db.session() as s:
            repo = _mk_repo(s, slug="t/repo", path="/tmp")
            first_id = _review_job(s, repo)
            repo_id = str(repo.id)
        r = client.post("/api/reviews", json={"repo_id": repo_id, "number": 7, "token": "tok"})
        assert r.status_code == 200
        second_id = r.json()["id"]
        assert submitted == ["run_review"]
        with db.session() as s:
            assert s.get(Job, first_id).result.get("superseded_by") == second_id


@requires_pg
def test_a_review_of_a_different_pr_does_not_supersede(db, monkeypatch):
    """Supersede is per pull request: reviewing #8 must not retire #7's session."""
    from fastapi.testclient import TestClient

    import shipwright.api.main as main
    from shipwright.api.main import app
    from shipwright.models import Job

    # Stubbed for the same reason as the test above: a live worker would reach GitHub.
    monkeypatch.setattr(main.POOL, "submit", lambda fn, *a: None)

    with TestClient(app) as client:
        with db.session() as s:
            repo = _mk_repo(s, slug="t/repo", path="/tmp")
            first_id = _review_job(s, repo)  # target number 7
            repo_id = str(repo.id)
        r = client.post("/api/reviews", json={"repo_id": repo_id, "number": 8, "token": "tok"})
        assert r.status_code == 200
        with db.session() as s:
            assert "superseded_by" not in (s.get(Job, first_id).result or {})
