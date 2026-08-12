import pytest
from pydantic import ValidationError

from shipwright.api.main import CreateJob


def test_dense_base_mode_is_rejected():
    with pytest.raises(ValidationError):
        CreateJob(repo_id="a" * 8, issue="x" * 12, base_mode="dense")


def test_unknown_mode_is_rejected():
    with pytest.raises(ValidationError):
        CreateJob(repo_id="a" * 8, issue="x" * 12, mode="agentic")


def test_defaults_still_valid():
    j = CreateJob(repo_id="a" * 8, issue="x" * 12)
    assert (j.mode, j.base_mode) == ("extract_rerank", "hybrid")
