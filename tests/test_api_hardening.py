import pytest
from pydantic import ValidationError

from shipwright.api.main import CreateJob
from tests.conftest import _mk_repo, requires_pg


def test_dense_base_mode_is_rejected():
    with pytest.raises(ValidationError):
        CreateJob(repo_id="a" * 8, issue="x" * 12, base_mode="dense")


def test_unknown_mode_is_rejected():
    with pytest.raises(ValidationError):
        CreateJob(repo_id="a" * 8, issue="x" * 12, mode="agentic")


def test_defaults_still_valid():
    j = CreateJob(repo_id="a" * 8, issue="x" * 12)
    assert (j.mode, j.base_mode) == ("extract_rerank", "hybrid")


@requires_pg
def test_health_is_key_exempt_and_blank(db, monkeypatch):
    from fastapi.testclient import TestClient

    from shipwright.api.main import app

    monkeypatch.setattr("shipwright.config.settings.shipwright_api_key", "sekrit")
    with TestClient(app) as client:
        # Health: no key needed, and no engine identity on the wire.
        r = client.get("/api/health")
        assert r.status_code == 200
        assert r.json() == {"ok": True}
        # Everything else still requires the key.
        assert client.get("/api/repos").status_code == 401
        assert client.get("/api/repos", headers={"x-shipwright-key": "sekrit"}).status_code == 200


@requires_pg
def test_disabled_test_action_returns_409(db, monkeypatch):
    from fastapi.testclient import TestClient

    from shipwright.api.main import app
    from shipwright.models import DONE, Job

    monkeypatch.setattr("shipwright.config.settings.enable_test_action", False)
    with TestClient(app) as client:
        with db.session() as s:
            repo = _mk_repo(s, slug="t/repo", path="/tmp")
            parent = Job(
                repo_id=repo.id,
                issue="x" * 12,
                status=DONE,
                result={"fix": {"patch": "diff", "applied_branch": "b"}},
            )
            s.add(parent)
            s.flush()
            parent_id = str(parent.id)
        r = client.post(f"/api/jobs/{parent_id}/actions", json={"kind": "test"})
        assert r.status_code == 409
        assert "disabled on this hosted demo" in r.json()["detail"]
        # The 409 must leave zero residue: no action Job row was created.
        with db.session() as s:
            from sqlalchemy import func, select

            assert s.scalar(select(func.count()).select_from(Job)) == 1  # only the parent
