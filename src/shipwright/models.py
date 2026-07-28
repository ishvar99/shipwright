"""Evidence spine: every benchmark number in this project traces to these rows."""

import uuid
from datetime import UTC, datetime

from sqlalchemy import ForeignKey, Index, String, Uuid
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

# TaskResult.status
RESOLVED, FAILED, ERROR, SKIPPED = "resolved", "failed", "error", "skipped"


def _now() -> datetime:
    return datetime.now(UTC)


def _uuid() -> uuid.UUID:
    return uuid.uuid4()


class Base(DeclarativeBase):
    pass


class Run(Base):
    """One benchmark batch under one exact config. The config fingerprint is the point."""

    __tablename__ = "runs"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=_uuid)
    suite: Mapped[str] = mapped_column(String(64))  # locbench | swebench_live | webgen | smoke
    split: Mapped[str] = mapped_column(String(64), default="")
    # Encodes mode + retrieval base + pool size, so two runs that differ in
    # configuration cannot look identical in the results table.
    scaffold: Mapped[str] = mapped_column(String(96))
    model: Mapped[str] = mapped_column(String(128))
    model_tier: Mapped[str] = mapped_column(String(16))  # local | cheap | frontier
    temperature: Mapped[float] = mapped_column(default=0.0)
    git_commit: Mapped[str] = mapped_column(String(40), default="")
    config: Mapped[dict] = mapped_column(JSONB, default=dict)
    notes: Mapped[str] = mapped_column(String(512), default="")
    started_at: Mapped[datetime] = mapped_column(default=_now)
    finished_at: Mapped[datetime | None] = mapped_column(default=None)

    results: Mapped[list["TaskResult"]] = relationship(back_populates="run")


class TaskResult(Base):
    """One task attempt. `metrics` holds suite-specific numbers (e.g. Loc-Bench acc@k)."""

    __tablename__ = "task_results"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=_uuid)
    run_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("runs.id"))
    task_id: Mapped[str] = mapped_column(String(256))
    status: Mapped[str] = mapped_column(String(16))
    skip_reason: Mapped[str] = mapped_column(String(128), default="")
    wall_ms: Mapped[int] = mapped_column(default=0)
    input_tokens: Mapped[int] = mapped_column(default=0)
    output_tokens: Mapped[int] = mapped_column(default=0)
    steps: Mapped[int] = mapped_column(default=0)
    tool_calls: Mapped[int] = mapped_column(default=0)
    tool_errors: Mapped[int] = mapped_column(default=0)
    patch_lines: Mapped[int] = mapped_column(default=0)
    metrics: Mapped[dict] = mapped_column(JSONB, default=dict)
    error: Mapped[str] = mapped_column(String(1024), default="")
    created_at: Mapped[datetime] = mapped_column(default=_now)

    run: Mapped[Run] = relationship(back_populates="results")

    __table_args__ = (Index("ix_task_results_run_task", "run_id", "task_id"),)


class ModelCall(Base):
    """Per-call latency and tokens. Feeds cost attribution and the TTFT numbers."""

    __tablename__ = "model_calls"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=_uuid)
    run_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("runs.id"), default=None)
    task_result_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("task_results.id"), default=None
    )
    model: Mapped[str] = mapped_column(String(128))
    input_tokens: Mapped[int] = mapped_column(default=0)
    output_tokens: Mapped[int] = mapped_column(default=0)
    latency_ms: Mapped[int] = mapped_column(default=0)
    ttft_ms: Mapped[int] = mapped_column(default=0)
    ok: Mapped[bool] = mapped_column(default=True)
    error: Mapped[str] = mapped_column(String(1024), default="")
    created_at: Mapped[datetime] = mapped_column(default=_now)
