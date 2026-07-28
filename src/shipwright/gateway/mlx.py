"""MLX provider — serves a locally fine-tuned adapter through the same interface as Ollama.

This is what the ModelProvider abstraction was for. Rather than fusing weights and
converting to GGUF to get the adapter into Ollama, the fine-tuned model is served in-process
and the rest of the pipeline does not change.

No constrained decoding here, unlike Ollama's `format`. The rerank call already tolerates
unparseable output by falling back to retrieval order, so a malformed response degrades to
the baseline rather than crashing — and the malformed-output rate becomes a measurable
quality signal of the fine-tune itself.
"""

from __future__ import annotations

import time
from typing import Any

from .base import GenResult, Message


class MlxProvider:
    tier = "local"

    def __init__(self, model: str, adapter_path: str | None = None):
        from mlx_lm import load

        self.model_id = model
        self.adapter_path = adapter_path
        self._model, self._tokenizer = load(model, adapter_path=adapter_path)

    @property
    def model(self) -> str:
        return f"mlx:{self.model_id}" + (f"+{self.adapter_path}" if self.adapter_path else "")

    def generate(
        self,
        messages: list[Message],
        *,
        schema: dict[str, Any] | None = None,
        temperature: float = 0.0,
        max_tokens: int | None = None,
        timeout: float = 300.0,
    ) -> GenResult:
        from mlx_lm import generate as mlx_generate
        from mlx_lm.sample_utils import make_sampler

        prompt = self._tokenizer.apply_chat_template(
            messages, add_generation_prompt=True, tokenize=False
        )
        started = time.perf_counter()
        text = mlx_generate(
            self._model,
            self._tokenizer,
            prompt=prompt,
            max_tokens=max_tokens or 300,
            sampler=make_sampler(temp=temperature),
            verbose=False,
        )
        elapsed = int((time.perf_counter() - started) * 1000)

        return GenResult(
            text=text,
            model=self.model,
            input_tokens=len(self._tokenizer.encode(prompt)),
            output_tokens=len(self._tokenizer.encode(text)) if text else 0,
            latency_ms=elapsed,
            ttft_ms=0,  # mlx_lm.generate is not streamed here; TTFT is not measured
        )
