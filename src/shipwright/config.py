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

    # Per-run safety caps. Tightened per-benchmark at call sites.
    max_steps: int = 30
    max_wall_seconds: int = 900
    max_output_bytes: int = 200_000


settings = Settings()
