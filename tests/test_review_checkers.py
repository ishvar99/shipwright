import json

from shipwright.gateway.base import GenResult
from shipwright.review.checkers import CHECKERS, FINDING_SCHEMA, run_checker


class FakeModel:
    """Duck-typed provider, matching the style of tests/test_intent.py."""

    tier = "local"
    model = "fake"

    def __init__(self, text: str = '{"findings": []}'):
        self.text = text
        self.calls = 0
        self.kwargs: dict = {}
        self.prompt = ""

    def generate(self, messages, **kwargs):
        self.calls += 1
        self.kwargs = kwargs
        self.prompt = messages[0]["content"]
        return GenResult(text=self.text, model="fake", input_tokens=10, output_tokens=5)


class RaisingModel:
    tier = "local"
    model = "fake"

    def __init__(self):
        self.calls = 0

    def generate(self, messages, **kwargs):
        self.calls += 1
        raise RuntimeError("provider down")


def _reply(findings):
    return json.dumps({"findings": findings})


def test_returns_parsed_findings():
    model = FakeModel(
        _reply([{"line": 12, "severity": "high", "title": "Token logged", "body": "why"}])
    )
    out, usage = run_checker("security", model, diff="@@", context="ctx", path="a.py")
    assert len(out) == 1
    assert out[0]["path"] == "a.py"
    assert out[0]["category"] == "security"
    assert out[0]["source"] == "llm"
    assert usage.parse_failures == 0


def test_sends_the_schema_so_decoding_is_constrained():
    model = FakeModel()
    run_checker("security", model, diff="@@", context="ctx", path="a.py")
    assert model.kwargs["schema"] == FINDING_SCHEMA


def test_unparseable_reply_counts_a_parse_failure_and_yields_nothing():
    model = FakeModel("I could not find anything useful to say.")
    out, usage = run_checker("quality", model, diff="@@", context="", path="a.py")
    assert out == []
    assert usage.parse_failures == 1
    # The call still happened and its tokens still count.
    assert usage.calls == 1


def test_provider_failure_degrades_and_records_no_call():
    model = RaisingModel()
    out, usage = run_checker("security", model, diff="@@", context="", path="a.py")
    assert out == []
    assert usage.calls == 0
    assert usage.provider_failures == 1


def test_findings_missing_a_line_are_dropped():
    model = FakeModel(_reply([{"severity": "high", "title": "no line", "body": "x"}]))
    out, _ = run_checker("security", model, diff="@@", context="", path="a.py")
    assert out == []


def test_unknown_severity_falls_back_to_low():
    model = FakeModel(_reply([{"line": 3, "severity": "catastrophic", "title": "t", "body": "b"}]))
    out, _ = run_checker("security", model, diff="@@", context="", path="a.py")
    assert out[0]["severity"] == "low"


def test_every_checker_has_a_distinct_prompt():
    instructions = [spec.instruction for spec in CHECKERS.values()]
    assert len(set(instructions)) == len(CHECKERS)
    assert set(CHECKERS) == {"security", "error_handling", "test_coverage", "quality"}


def test_prompt_carries_the_diff_and_the_context():
    model = FakeModel()
    run_checker("security", model, diff="DIFF-MARKER", context="CTX-MARKER", path="a.py")
    assert "DIFF-MARKER" in model.prompt
    assert "CTX-MARKER" in model.prompt


def test_non_list_findings_field_is_a_parse_failure():
    model = FakeModel('{"findings": "lots"}')
    out, usage = run_checker("quality", model, diff="@@", context="", path="a.py")
    assert out == []
    assert usage.parse_failures == 1
