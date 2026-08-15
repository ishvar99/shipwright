"""Failure policy as data.

The recovery behaviour the reviewer needs — retry a flaky call, then carry on without that
check rather than losing the whole review — is the same shape for every stage. Writing it
once, as a declared policy, keeps run.py readable and makes "how often did recovery fire?" a
number the evaluation can report instead of a claim.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

log = logging.getLogger("shipwright.review")


@dataclass(frozen=True)
class Stage:
    name: str
    retries: int = 0
    degrade_to: Any = None


@dataclass(frozen=True)
class StageOutcome:
    name: str
    ok: bool
    value: Any
    attempts: int
    degraded: bool = False
    error: str = ""


def _tell(notify: Callable[[str, dict], None] | None, type_: str, **payload) -> None:
    """A broken listener must never take down the work it is narrating."""
    if notify is None:
        return
    try:
        notify(type_, payload)
    except Exception:  # noqa: BLE001 - narration is not the product
        log.exception("review stage notify failed")


def run_stage(
    stage: Stage,
    work: Callable[[], Any],
    *,
    notify: Callable[[str, dict], None] | None = None,
) -> StageOutcome:
    """Run `work`, retrying on any exception, then degrading. Never raises."""
    _tell(notify, "review.stage.started", stage=stage.name)
    for attempt in range(stage.retries + 1):
        try:
            value = work()
        except Exception as e:  # noqa: BLE001 - degrading is the entire point
            # NAME only, here and on the wire: a repr can embed a provider URL or a path.
            last = type(e).__name__
            log.exception("review stage %s attempt %s failed", stage.name, attempt + 1)
            if attempt < stage.retries:
                _tell(
                    notify,
                    "review.stage.retried",
                    stage=stage.name,
                    attempt=attempt + 1,
                    error=last,
                )
                continue
            _tell(notify, "review.stage.degraded", stage=stage.name, error=last)
            return StageOutcome(
                name=stage.name,
                ok=False,
                value=stage.degrade_to,
                attempts=attempt + 1,
                degraded=True,
                error=last,
            )
        _tell(notify, "review.stage.finished", stage=stage.name, attempt=attempt + 1)
        return StageOutcome(name=stage.name, ok=True, value=value, attempts=attempt + 1)
    raise AssertionError("unreachable")  # pragma: no cover
