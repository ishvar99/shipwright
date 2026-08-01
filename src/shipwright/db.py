from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, sessionmaker

from .config import settings
from .models import Base

engine = create_engine(settings.database_url, pool_pre_ping=True)
SessionLocal = sessionmaker(engine, expire_on_commit=False)


def init_schema() -> None:
    """create_all is deliberate: no migrations until the schema stops churning."""
    Base.metadata.create_all(engine)
    _reconcile_owner()


def _reconcile_owner() -> None:
    """Bring an existing database in line with owner scoping.

    `create_all` only ever CREATEs — it will not add a column or drop a constraint on a table
    that already exists, so a database predating owner scoping would keep the global unique on
    slug and every query naming `owner` would fail. Idempotent, so it is safe on every boot,
    and additive: existing rows get owner '', which is exactly what a single-user install is.

    The old constraint is looked up in the catalog rather than assumed to be called
    `repos_slug_key` — guessing a name and using IF EXISTS would silently do nothing.
    """
    with engine.begin() as c:
        c.execute(text("ALTER TABLE repos ADD COLUMN IF NOT EXISTS owner VARCHAR(128) DEFAULT ''"))
        c.execute(text("ALTER TABLE jobs  ADD COLUMN IF NOT EXISTS owner VARCHAR(128) DEFAULT ''"))
        c.execute(text("UPDATE repos SET owner = '' WHERE owner IS NULL"))
        c.execute(text("UPDATE jobs  SET owner = '' WHERE owner IS NULL"))

        stale = c.execute(
            text("""
                SELECT con.conname FROM pg_constraint con
                JOIN pg_class rel ON rel.oid = con.conrelid
                WHERE rel.relname = 'repos' AND con.contype = 'u'
                  AND pg_get_constraintdef(con.oid) = 'UNIQUE (slug)'
            """)
        ).scalars().all()
        for name in stale:
            c.execute(text(f'ALTER TABLE repos DROP CONSTRAINT "{name}"'))

        c.execute(
            text("""
                DO $$ BEGIN
                    ALTER TABLE repos ADD CONSTRAINT repos_owner_slug_key UNIQUE (owner, slug);
                EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
                END $$
            """)
        )

        # A migrated database and a fresh `create_all` one must end up the same shape. Without
        # these two steps `owner` stays nullable and unindexed here while the model declares it
        # NOT NULL and indexed — so every owner-scoped query would seq-scan on exactly the
        # installs that have the most rows.
        c.execute(text("ALTER TABLE repos ALTER COLUMN owner SET NOT NULL"))
        c.execute(text("ALTER TABLE jobs  ALTER COLUMN owner SET NOT NULL"))
        c.execute(text("CREATE INDEX IF NOT EXISTS ix_repos_owner ON repos (owner)"))
        c.execute(text("CREATE INDEX IF NOT EXISTS ix_jobs_owner  ON jobs  (owner)"))


@contextmanager
def session() -> Iterator[Session]:
    s = SessionLocal()
    try:
        yield s
        s.commit()
    except Exception:
        s.rollback()
        raise
    finally:
        s.close()
