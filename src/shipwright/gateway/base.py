from dataclasses import dataclass, field
from typing import Any, Protocol

Message = dict[str, str]


@dataclass
class GenResult:
    text: str
    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    latency_ms: int = 0
    ttft_ms: int = 0
    raw: dict[str, Any] = field(default_factory=dict)


class ModelProvider(Protocol):
    """Tier 0 is Ollama; cheap-API and Bedrock tiers implement the same surface."""

    tier: str
    model: str

    def generate(
        self,
        messages: list[Message],
        *,
        schema: dict[str, Any] | None = None,
        temperature: float = 0.0,
        max_tokens: int | None = None,
        timeout: float = 300.0,
    ) -> GenResult: ...
