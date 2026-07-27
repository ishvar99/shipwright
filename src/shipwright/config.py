from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://shipwright:shipwright@localhost:55432/shipwright"
    redis_url: str = "redis://localhost:56379/0"

    ollama_base_url: str = "http://localhost:11434"
    local_model: str = "qwen2.5-coder:7b"
    # Fallback when the 7B contends with Docker for the 16GB budget.
    local_model_small: str = "qwen2.5-coder:3b"

    # Per-run safety caps. Tightened per-benchmark at call sites.
    max_steps: int = 30
    max_wall_seconds: int = 900
    max_output_bytes: int = 200_000


settings = Settings()
