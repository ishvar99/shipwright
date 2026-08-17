from shipwright.gateway.base import GenResult
from shipwright.intent import CHANGE, QUESTION, SCHEMA, classify

ISSUE = "The token cache returns stale entries after the ttl expires in cache.py"


class FakeModel:
    def __init__(self, text: str):
        self.text_out = text
        self.kwargs: dict | None = None

    def generate(self, messages, **kwargs):
        self.kwargs = kwargs
        return GenResult(text=self.text_out, model="fake")


def test_fenced_reply_still_classifies():
    model = FakeModel('```json\n{"intent": "change"}\n```')
    assert classify(ISSUE, model) == (CHANGE, "classified")


def test_request_contract():
    model = FakeModel('{"intent": "question"}')
    classify(ISSUE, model)
    assert model.kwargs is not None and model.kwargs["max_tokens"] == 64
    assert model.kwargs["schema"] is SCHEMA


def test_garbage_falls_back_to_question():
    assert classify(ISSUE, FakeModel("I think this is a change request!"))[0] == QUESTION


def test_empty_reply_falls_back_to_question():
    # A provider can 200 with empty content (e.g. after retry exhaustion); the or-{} guard
    # must degrade this to QUESTION, not raise.
    assert classify(ISSUE, FakeModel(""))[0] == QUESTION
