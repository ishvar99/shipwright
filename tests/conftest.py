"""Shared fixtures. DB tests need the dev Postgres from `make up`; they create their own
scratch database (shipwright_test) so they never touch dev rows, and skip cleanly when
Postgres is down."""

from __future__ import annotations

import os

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

ADMIN_URL = os.environ.get(
    "SHIPWRIGHT_TEST_ADMIN_URL",
    "postgresql+psycopg://shipwright:shipwright@localhost:55432/shipwright",
)
TEST_DB = "shipwright_test"


def _pg_available() -> bool:
    try:
        eng = create_engine(ADMIN_URL, connect_args={"connect_timeout": 2})
        with eng.connect():
            return True
    except Exception:
        return False


requires_pg = pytest.mark.skipif(
    not _pg_available(), reason="dev Postgres not running (make up)"
)


@pytest.fixture(scope="session")
def test_database_url() -> str:
    admin = create_engine(ADMIN_URL, isolation_level="AUTOCOMMIT")
    with admin.connect() as c:
        exists = c.execute(
            text("SELECT 1 FROM pg_database WHERE datname = :n"), {"n": TEST_DB}
        ).scalar()
        if not exists:
            c.execute(text(f'CREATE DATABASE "{TEST_DB}"'))
    admin.dispose()
    return ADMIN_URL.rsplit("/", 1)[0] + f"/{TEST_DB}"


@pytest.fixture()
def db(test_database_url):
    """Patch shipwright.db's engine/SessionLocal to the scratch database, with a clean
    schema per test. session() and init_schema() resolve these module globals at call
    time, so patching the attributes is enough — no reload gymnastics."""
    import shipwright.db as dbm
    from shipwright.models import Base

    test_engine = create_engine(test_database_url, pool_pre_ping=True)
    old_engine, old_sm = dbm.engine, dbm.SessionLocal
    dbm.engine = test_engine
    dbm.SessionLocal = sessionmaker(test_engine, expire_on_commit=False)
    Base.metadata.drop_all(test_engine)
    dbm.init_schema()
    yield dbm
    dbm.engine, dbm.SessionLocal = old_engine, old_sm
    test_engine.dispose()
