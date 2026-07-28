import json
import time
from typing import Any

import httpx

from ..config import settings
from .base import GenResult, Message


class OllamaProvider:
    """Local tier. Streams so we can measure time-to-first-token honestly."""

    tier = "local"

    def __init__(self, model: str | None = None, base_url: str | None = None):
        self.model = model or settings.local_model
        self.base_url = (base_url or settings.ollama_base_url).rstrip("/")

    def generate(
        self,
        messages: list[Message],
        *,
        schema: dict[str, Any] | None = None,
        temperature: float = 0.0,
        max_tokens: int | None = None,
        timeout: float = 300.0,
    ) -> GenResult:
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "stream": True,
            "keep_alive": settings.keep_alive,
            "options": {"temperature": temperature},
        }
        if max_tokens:
            payload["options"]["num_predict"] = max_tokens
        if schema:
            payload["format"] = schema  # Ollama constrains decoding to the JSON schema

        started = time.perf_counter()
        ttft_ms = 0
        chunks: list[str] = []
        final: dict[str, Any] = {}

        with httpx.Client(timeout=timeout) as client:
            with client.stream("POST", f"{self.base_url}/api/chat", json=payload) as r:
                r.raise_for_status()
                for line in r.iter_lines():
                    if not line:
                        continue
                    event = json.loads(line)
                    piece = event.get("message", {}).get("content", "")
                    if piece:
                        if not ttft_ms:
                            ttft_ms = int((time.perf_counter() - started) * 1000)
                        chunks.append(piece)
                    if event.get("done"):
                        final = event

        return GenResult(
            text="".join(chunks),
            model=self.model,
            input_tokens=final.get("prompt_eval_count", 0),
            output_tokens=final.get("eval_count", 0),
            latency_ms=int((time.perf_counter() - started) * 1000),
            ttft_ms=ttft_ms,
            raw=final,
        )

    def list_models(self, timeout: float = 10.0) -> list[str]:
        r = httpx.get(f"{self.base_url}/api/tags", timeout=timeout)
        r.raise_for_status()
        return [m["name"] for m in r.json().get("models", [])]
