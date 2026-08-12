"""OpenAI-compatible chat-completions tier (Groq, Cerebras, OpenRouter, ...).

Mirrors OllamaProvider.generate's ACTUAL signature — on_delta and per-call timeout — not
the ModelProvider Protocol, which understates the contract (base.py omits on_delta while
real call sites pass it).

Two deliberate branches:
- schema'd calls run NON-streaming: Groq structured outputs reject stream=true, and no
  call site passes schema and on_delta together.
- free-text calls stream, with stream_options.include_usage so token counts land in the
  final chunk instead of silently recording as zero.

429/5xx get bounded retry-after-aware backoff HERE, before any bytes stream, so every
consumer (extract/rerank/intent/fix/answer) inherits it — none of them catches provider
errors, and on the free tier a single unretried 429 would error the whole job.
"""

from __future__ import annotations

import json
import time
from typing import Any

import httpx

from ..config import settings
from .base import GenResult, Message

RETRIES = 3
MAX_BACKOFF_S = 20.0
RETRYABLE = {429, 500, 502, 503, 504}


class OpenAICompatProvider:
    tier = "cheap"

    def __init__(
        self,
        model: str | None = None,
        base_url: str | None = None,
        api_key: str | None = None,
        transport: httpx.BaseTransport | None = None,
    ):
        self.model = model or settings.loc_model
        self.base_url = (base_url or settings.model_api_url).rstrip("/")
        self.api_key = api_key if api_key is not None else settings.model_api_key
        self._transport = transport  # injected by tests (httpx.MockTransport)

    def generate(
        self,
        messages: list[Message],
        *,
        schema: dict[str, Any] | None = None,
        temperature: float = 0.0,
        max_tokens: int | None = None,
        timeout: float = 300.0,
        on_delta=None,
    ) -> GenResult:
        for attempt in range(RETRIES + 1):
            try:
                if schema:
                    return self._complete(messages, schema, temperature, max_tokens, timeout)
                return self._stream(messages, temperature, max_tokens, timeout, on_delta)
            except httpx.HTTPStatusError as e:
                # raise_for_status fires before any delta reaches on_delta, so a retry can
                # never duplicate streamed text. Mid-stream transport errors are NOT
                # retried, deliberately.
                if e.response.status_code in RETRYABLE and attempt < RETRIES:
                    time.sleep(self._backoff(e.response, attempt))
                    continue
                raise
        raise RuntimeError("unreachable")  # pragma: no cover

    def _backoff(self, resp: httpx.Response, attempt: int) -> float:
        try:
            # max(0, …) so a negative or NaN retry-after degrades to "retry now",
            # never to a ValueError from time.sleep.
            return max(0.0, min(float(resp.headers.get("retry-after", "")), MAX_BACKOFF_S))
        except ValueError:
            return min(2.0**attempt, MAX_BACKOFF_S)

    def _headers(self) -> dict[str, str]:
        h = {"content-type": "application/json"}
        if self.api_key:
            h["authorization"] = f"Bearer {self.api_key}"
        return h

    def _payload(
        self,
        messages: list[Message],
        schema: dict[str, Any] | None,
        temperature: float,
        max_tokens: int | None,
        stream: bool,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "stream": stream,
        }
        if max_tokens:
            payload["max_completion_tokens"] = max_tokens
        if schema:
            payload["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": "output", "schema": schema, "strict": True},
            }
            if settings.model_reasoning_effort:
                # Reasoning models (gpt-oss) draw thinking tokens from max_completion_tokens;
                # low effort keeps small structured budgets (intent's 64) from being eaten
                # before any JSON is emitted. Scoped to schema'd calls: fix/answer quality
                # may want the default effort.
                payload["reasoning_effort"] = settings.model_reasoning_effort
        if stream:
            payload["stream_options"] = {"include_usage": True}
        return payload

    def _complete(self, messages, schema, temperature, max_tokens, timeout) -> GenResult:
        started = time.perf_counter()
        with httpx.Client(timeout=timeout, transport=self._transport) as client:
            r = client.post(
                f"{self.base_url}/chat/completions",
                headers=self._headers(),
                json=self._payload(messages, schema, temperature, max_tokens, stream=False),
            )
            r.raise_for_status()
            body = r.json()
        text = ((body.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
        usage = body.get("usage") or {}
        latency = int((time.perf_counter() - started) * 1000)
        return GenResult(
            text=text,
            model=self.model,
            input_tokens=usage.get("prompt_tokens", 0),
            output_tokens=usage.get("completion_tokens", 0),
            latency_ms=latency,
            ttft_ms=latency,  # non-streaming: first token IS the whole body
            raw=body,
        )

    def _stream(self, messages, temperature, max_tokens, timeout, on_delta) -> GenResult:
        started = time.perf_counter()
        ttft_ms = 0
        chunks: list[str] = []
        usage: dict[str, Any] = {}
        final: dict[str, Any] = {}
        with httpx.Client(timeout=timeout, transport=self._transport) as client:
            with client.stream(
                "POST",
                f"{self.base_url}/chat/completions",
                headers=self._headers(),
                json=self._payload(messages, None, temperature, max_tokens, stream=True),
            ) as r:
                r.raise_for_status()
                for line in r.iter_lines():
                    if not line.startswith("data: "):
                        continue
                    data = line[len("data: ") :]
                    if data == "[DONE]":
                        break
                    event = json.loads(data)
                    final = event
                    choices = event.get("choices") or []
                    piece = (choices[0].get("delta") or {}).get("content") if choices else None
                    if piece:
                        if not ttft_ms:
                            ttft_ms = int((time.perf_counter() - started) * 1000)
                        chunks.append(piece)
                        if on_delta:
                            on_delta(piece)
                    # Groq puts usage on the final chunk (x_groq) or, with
                    # stream_options.include_usage, in a bare `usage` field.
                    u = event.get("usage") or (event.get("x_groq") or {}).get("usage")
                    if u:
                        usage = u
        return GenResult(
            text="".join(chunks),
            model=self.model,
            input_tokens=usage.get("prompt_tokens", 0),
            output_tokens=usage.get("completion_tokens", 0),
            latency_ms=int((time.perf_counter() - started) * 1000),
            ttft_ms=ttft_ms,
            raw=final,
        )
