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


def test_enforce_clone_bound(monkeypatch, tmp_path):
    from shipwright.api.service import _enforce_clone_bound

    dest = tmp_path / "ws"
    dest.mkdir()
    (dest / "big.bin").write_bytes(b"\0" * (2 * 1024 * 1024))

    # Disabled (0): no-op regardless of size.
    monkeypatch.setattr("shipwright.config.settings.max_clone_mb", 0)
    _enforce_clone_bound(dest)
    assert dest.exists()

    # Under the cap: untouched.
    monkeypatch.setattr("shipwright.config.settings.max_clone_mb", 3)
    _enforce_clone_bound(dest)
    assert dest.exists()

    # Over the cap: raises AND removes the workspace.
    monkeypatch.setattr("shipwright.config.settings.max_clone_mb", 1)
    import pytest

    with pytest.raises(RuntimeError, match="hosted limit"):
        _enforce_clone_bound(dest)
    assert not dest.exists()


def test_enforce_clone_bound_ignores_symlink_targets(monkeypatch, tmp_path):
    from shipwright.api.service import _enforce_clone_bound

    dest = tmp_path / "ws"
    dest.mkdir()
    big_outside = tmp_path / "outside.bin"
    big_outside.write_bytes(b"\0" * (2 * 1024 * 1024))
    (dest / "link.bin").symlink_to(big_outside)

    monkeypatch.setattr("shipwright.config.settings.max_clone_mb", 1)
    _enforce_clone_bound(dest)  # link costs ~bytes of path, not 2 MB — must not raise
    assert dest.exists()
