from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://shipwright:shipwright@localhost:55432/shipwright"
    redis_url: str = "redis://localhost:56379/0"

    # Shared secret between the web BFF and this process. Empty means open, which is the right
    # default for a loopback-only dev box; set it anywhere the port could be reached otherwise.
    shipwright_api_key: str = ""

    ollama_base_url: str = "http://localhost:11434"
    # 16k-context build (see infra/ollama/). Stock qwen2.5-coder:7b loads at 4096,
    # which silently truncates agent history mid-run.
    local_model: str = "qwen2.5-coder-7b-16k"
    # Same build as the agent, deliberately. A 3B saved 2.9GB but scored no better than
    # free retrieval (docs/EVALS.md), and a second 7B variant would just mean two copies
    # resident. One model, one 5GB footprint.
    loc_model: str = "qwen2.5-coder-7b-16k"
    embed_model: str = "nomic-embed-text"
    # Release model memory when idle instead of holding 5GB indefinitely.
    keep_alive: str = "2m"

    # Which tier serves the product surface: "ollama" (local default) or "openai_compat"
    # (any OpenAI-chat-completions endpoint — Groq, Cerebras, OpenRouter). The model name
    # stays loc_model, so the hosted deploy sets LOC_MODEL=openai/gpt-oss-120b.
    # Named MODEL_API_* rather than OPENAI_* so a developer's real OPENAI_API_KEY in the
    # shell can never leak into a Groq-pointed deployment.
    # Literal, not str: a typo'd MODEL_PROVIDER must fail at boot, not silently dial Ollama.
    model_provider: Literal["ollama", "openai_compat"] = "ollama"
    model_api_url: str = "https://api.groq.com/openai/v1"
    model_api_key: str = ""

    # The hosted demo disables the action that executes the imported repo's own code.
    enable_test_action: bool = True
    # Background job concurrency: 2 fits the dev laptop; 1 on a 512 MB host — two
    # concurrent CodeGraph + BM25 builds can OOM the free container.
    job_workers: int = Field(2, ge=1)
    # SSE DB poll cadence: 0.4s locally; 1.0s hosted (Supabase egress is metered).
    sse_poll_seconds: float = Field(0.4, gt=0)
    # Reject clones whose working tree exceeds this many MB (0 = no limit, local default).
    # The hosted disk is ephemeral AND shared; one huge clone can ENOSPC every job.
    max_clone_mb: int = Field(0, ge=0)

    # Per-run safety caps. Tightened per-benchmark at call sites.
    max_steps: int = 30
    max_wall_seconds: int = 900
    max_output_bytes: int = 200_000


settings = Settings()
