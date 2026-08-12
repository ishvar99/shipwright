"""Provider failures at the extract/rerank seams must degrade to the retrieval floor, not
error the whole job — "the located results are still the product" (assisted.py's module
docstring). Parse failures already fall back this way; these tests pin the same fallback
for a provider call that raises (sustained 429, auth failure — anything that survives the
gateway's own retries).

Builds a tiny real CodeGraph via codegraph.build.build over a tmp_path repo so these tests
exercise the actual localize_assisted orchestration end to end, not a reimplementation of it.
"""

from __future__ import annotations

from pathlib import Path

from shipwright.codegraph.assisted import RERANK_CANDIDATES, localize_assisted
from shipwright.codegraph.build import build
from shipwright.codegraph.retrieve import Localizer

ISSUE = "calculate_total returns the wrong total when the cart is empty"


class RaisingModel:
    """Stands in for a provider whose retries are exhausted: every call blows up."""

    tier = "fake"
    model = "fake"

    def __init__(self) -> None:
        self.calls = 0

    def generate(self, messages, **kwargs):
        self.calls += 1
        raise RuntimeError("provider unavailable")


def _tiny_repo(tmp_path: Path) -> Path:
    (tmp_path / "cart.py").write_text(
        "def calculate_total(items):\n"
        '    """Sum the price of every item in the cart."""\n'
        "    return sum(item.price for item in items)\n"
    )
    (tmp_path / "checkout.py").write_text(
        "from cart import calculate_total\n\n\n"
        "class Checkout:\n"
        "    def total(self, items):\n"
        "        return calculate_total(items)\n"
    )
    return tmp_path


def test_extract_and_rerank_failures_degrade_to_retrieval_order(tmp_path):
    graph = build(_tiny_repo(tmp_path))
    model = RaisingModel()

    results, usage = localize_assisted(graph, ISSUE, mode="extract_rerank", model=model, top_k=5)

    assert results, "a provider outage must not empty out the retrieval floor"
    assert model.calls == 2  # extract, then rerank — both raised and were both caught
    assert usage.calls == 0  # neither call succeeded far enough to record usage


def test_rerank_failure_returns_retrieval_order(tmp_path):
    graph = build(_tiny_repo(tmp_path))
    model = RaisingModel()

    results, _ = localize_assisted(graph, ISSUE, mode="rerank", model=model, top_k=5)

    expected = Localizer(graph).localize(ISSUE, mode="hybrid", top_k=RERANK_CANDIDATES)[:5]
    assert results == expected
    assert model.calls == 1  # only the rerank call is made in "rerank" mode
