import dataclasses

import pytest

from shipwright.review.stages import Stage, run_stage


def test_success_records_one_attempt():
    out = run_stage(Stage("s", retries=2), lambda: "value")
    assert out.ok is True
    assert out.value == "value"
    assert out.attempts == 1
    assert out.degraded is False


def test_retries_then_succeeds():
    calls = []

    def flaky():
        calls.append(1)
        if len(calls) < 3:
            raise RuntimeError("transient")
        return "ok"

    out = run_stage(Stage("s", retries=2), flaky)
    assert out.ok is True
    assert out.attempts == 3


def test_exhausted_retries_degrade_rather_than_raise():
    def always():
        raise RuntimeError("down")

    out = run_stage(Stage("s", retries=1, degrade_to=[]), always)
    assert out.ok is False
    assert out.degraded is True
    assert out.value == []
    assert out.attempts == 2
    assert out.error == "RuntimeError"


def test_notify_reports_each_transition():
    events = []

    def flaky():
        if len([e for e in events if e[0] == "review.stage.retried"]) < 2:
            raise RuntimeError("x")
        return 1

    run_stage(Stage("chk", retries=2), flaky, notify=lambda t, p: events.append((t, p)))
    kinds = [t for t, _ in events]
    assert kinds[0] == "review.stage.started"
    assert "review.stage.retried" in kinds
    assert kinds[-1] == "review.stage.finished"


def test_degraded_stage_notifies_degraded_not_finished():
    events = []

    def always():
        raise RuntimeError("down")

    run_stage(Stage("chk", retries=0), always, notify=lambda t, p: events.append((t, p)))
    assert events[-1][0] == "review.stage.degraded"


def test_notify_payload_carries_no_free_text():
    events = []

    def always():
        raise RuntimeError("a secret path /Users/someone/x")

    run_stage(Stage("chk", retries=0), always, notify=lambda t, p: events.append((t, p)))
    payload = events[-1][1]
    # The exception NAME only, never its message — the same rule service.py applies, because
    # a repr can embed a provider URL or a home directory.
    assert payload.get("error") == "RuntimeError"
    assert "secret" not in repr(payload)


def test_notify_failure_never_breaks_the_stage():
    def boom(_t, _p):
        raise ValueError("bad listener")

    out = run_stage(Stage("s", retries=0), lambda: 1, notify=boom)
    assert out.ok is True


def test_outcome_is_frozen():
    out = run_stage(Stage("s"), lambda: 1)
    with pytest.raises(dataclasses.FrozenInstanceError):
        out.value = 2


def test_degrade_to_defaults_to_none():
    def always():
        raise RuntimeError("down")

    assert run_stage(Stage("s"), always).value is None
