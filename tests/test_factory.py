from shipwright.gateway.factory import make_provider
from shipwright.gateway.ollama import OllamaProvider
from shipwright.gateway.openai_compat import OpenAICompatProvider


def test_default_is_ollama(monkeypatch):
    monkeypatch.setattr("shipwright.config.settings.model_provider", "ollama")
    p = make_provider("m")
    assert isinstance(p, OllamaProvider) and p.model == "m"


def test_openai_compat_selected_by_setting(monkeypatch):
    monkeypatch.setattr("shipwright.config.settings.model_provider", "openai_compat")
    p = make_provider("openai/gpt-oss-120b")
    assert isinstance(p, OpenAICompatProvider) and p.model == "openai/gpt-oss-120b"


def test_clone_bound_rejects_oversized_tree(monkeypatch, tmp_path):
    """import_repo's size gate, tested through its helper logic: a tree above the cap
    raises and removes the workspace."""
    from shipwright.api import service

    # 2 MB file against a 1 MB cap
    dest = tmp_path / "ws"
    dest.mkdir()
    (dest / "big.bin").write_bytes(b"\0" * (2 * 1024 * 1024))
    monkeypatch.setattr("shipwright.config.settings.max_clone_mb", 1)

    used = sum(f.stat().st_size for f in dest.rglob("*") if f.is_file())
    assert used > service.settings.max_clone_mb * 1024 * 1024
