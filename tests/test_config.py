from shipwright.config import Settings


def test_new_deployment_settings_have_local_defaults(monkeypatch):
    for var in (
        "MODEL_PROVIDER", "MODEL_API_URL", "MODEL_API_KEY",
        "ENABLE_TEST_ACTION", "JOB_WORKERS", "SSE_POLL_SECONDS", "MAX_CLONE_MB",
    ):
        monkeypatch.delenv(var, raising=False)
    s = Settings(_env_file=None)
    assert s.model_provider == "ollama"
    assert s.model_api_url == "https://api.groq.com/openai/v1"
    assert s.model_api_key == ""
    assert s.enable_test_action is True
    assert s.job_workers == 2
    assert s.sse_poll_seconds == 0.4
    assert s.max_clone_mb == 0


def test_settings_read_env(monkeypatch):
    monkeypatch.setenv("MODEL_PROVIDER", "openai_compat")
    monkeypatch.setenv("JOB_WORKERS", "1")
    monkeypatch.setenv("SSE_POLL_SECONDS", "1.0")
    s = Settings(_env_file=None)
    assert s.model_provider == "openai_compat"
    assert s.job_workers == 1
    assert s.sse_poll_seconds == 1.0
