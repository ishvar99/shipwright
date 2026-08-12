"""The product surface's model tier, selected by env. Exactly two call sites use this
(run_localize and run_action's fix_retry) — benchmarks and the CLI construct providers
explicitly and never come through here. model_provider is a validated Literal, so the
else-branch IS "ollama", not a fallback."""

from __future__ import annotations

from ..config import settings


def make_provider(model: str | None = None):
    name = model or settings.loc_model
    if settings.model_provider == "openai_compat":
        from .openai_compat import OpenAICompatProvider

        return OpenAICompatProvider(model=name)
    from .ollama import OllamaProvider

    return OllamaProvider(model=name)
