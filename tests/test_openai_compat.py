import json

import httpx
import pytest

from shipwright.gateway.openai_compat import OpenAICompatProvider

SCHEMA = {"type": "object", "properties": {"a": {"type": "integer"}}, "required": ["a"]}


def _provider(handler):
    return OpenAICompatProvider(
        model="test-model",
        base_url="https://api.example.test/openai/v1",
        api_key="k",
        transport=httpx.MockTransport(handler),
    )


def test_schema_call_is_non_streaming_json_schema():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        seen["auth"] = request.headers.get("authorization")
        return httpx.Response(200, json={
            "choices": [{"message": {"content": '{"a": 1}'}}],
            "usage": {"prompt_tokens": 11, "completion_tokens": 3},
        })

    r = _provider(handler).generate(
        [{"role": "user", "content": "hi"}], schema=SCHEMA, max_tokens=50
    )
    assert seen["stream"] is False
    assert seen["response_format"]["type"] == "json_schema"
    assert seen["response_format"]["json_schema"]["schema"] == SCHEMA
    assert seen["max_completion_tokens"] == 50
    assert seen["auth"] == "Bearer k"
    assert r.text == '{"a": 1}'
    assert (r.input_tokens, r.output_tokens) == (11, 3)


def test_free_text_streams_deltas_and_usage():
    sse = (
        'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n'
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n'
        'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n'
        "data: [DONE]\n\n"
    )
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        return httpx.Response(
            200, content=sse.encode(), headers={"content-type": "text/event-stream"}
        )

    deltas: list[str] = []
    r = _provider(handler).generate(
        [{"role": "user", "content": "hi"}], on_delta=deltas.append
    )
    assert seen["stream"] is True
    assert seen["stream_options"] == {"include_usage": True}
    assert r.text == "hello" and deltas == ["hel", "lo"]
    assert (r.input_tokens, r.output_tokens) == (5, 2)
    assert r.ttft_ms >= 0


def test_429_retries_with_retry_after(monkeypatch):
    sleeps: list[float] = []
    monkeypatch.setattr(
        "shipwright.gateway.openai_compat.time.sleep", sleeps.append
    )
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(429, headers={"retry-after": "2"}, json={})
        return httpx.Response(200, json={
            "choices": [{"message": {"content": "ok"}}], "usage": {},
        })

    r = _provider(handler).generate([{"role": "user", "content": "hi"}], schema=SCHEMA)
    assert calls["n"] == 2 and r.text == "ok" and sleeps == [2.0]


def test_non_retryable_raises_httpstatuserror():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": {"message": "bad"}})

    with pytest.raises(httpx.HTTPStatusError):
        _provider(handler).generate([{"role": "user", "content": "hi"}], schema=SCHEMA)


def test_reasoning_effort_sent_on_schema_calls_only(monkeypatch):
    monkeypatch.setattr("shipwright.config.settings.model_reasoning_effort", "low")
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.clear()
        seen.update(json.loads(request.content))
        if seen.get("stream"):
            return httpx.Response(
                200, content=b"data: [DONE]\n\n",
                headers={"content-type": "text/event-stream"},
            )
        return httpx.Response(200, json={
            "choices": [{"message": {"content": "{}"}}], "usage": {},
        })

    p = _provider(handler)
    p.generate([{"role": "user", "content": "hi"}], schema=SCHEMA)
    assert seen["reasoning_effort"] == "low"
    p.generate([{"role": "user", "content": "hi"}])
    assert "reasoning_effort" not in seen


def test_retries_exhaust_then_raise(monkeypatch):
    monkeypatch.setattr("shipwright.gateway.openai_compat.time.sleep", lambda s: None)
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(429, json={})

    with pytest.raises(httpx.HTTPStatusError):
        _provider(handler).generate([{"role": "user", "content": "hi"}], schema=SCHEMA)
    assert calls["n"] == 4  # 1 try + 3 retries
