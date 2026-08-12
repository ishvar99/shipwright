"""LLM-assisted localization on top of the retrieval floor.

Two techniques, both cheap (1-2 calls per task) and both taken from published results
rather than invented here:

- **extract**: pull concrete symbol names out of the issue prose first, then retrieve on
  those instead of the raw text. Reported as the single largest win for entity linking.
- **rerank**: retrieve wide, then have the model order the candidates.

Deliberately not an agentic traversal loop. At ~23 tok/s that costs minutes per task, and
the local 7B degenerates into repeating one action (FAILURES.md F8). Bounded calls with
schema-constrained output fail far more visibly.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass

from ..gateway.base import ModelProvider
from ..parsing import parse_json
from .build import CodeGraph
from .retrieve import Localizer, Ranked

log = logging.getLogger("shipwright.assisted")

EXTRACT_SCHEMA = {
    "type": "object",
    "properties": {
        "symbols": {"type": "array", "items": {"type": "string"}},
        "keywords": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["symbols", "keywords"],
    # additionalProperties: strict structured-output modes require it; Ollama ignores it.
    "additionalProperties": False,
}

# Indices, not ids: small models mangle long strings but handle integers reliably.
RERANK_SCHEMA = {
    "type": "object",
    "properties": {"ranked": {"type": "array", "items": {"type": "integer"}}},
    "required": ["ranked"],
    "additionalProperties": False,
}

MAX_ISSUE_CHARS = 3000
RERANK_CANDIDATES = 30


@dataclass
class Usage:
    calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    parse_failures: int = 0  # silent degradation, made countable

    def add(self, r) -> None:
        self.calls += 1
        self.input_tokens += r.input_tokens
        self.output_tokens += r.output_tokens


def _extract_query(model: ModelProvider, issue: str, usage: Usage) -> str:
    prompt = (
        "Extract the code identifiers and terms needed to find the buggy code.\n"
        "symbols: function, method, or class names mentioned or clearly implied.\n"
        "keywords: other distinctive technical terms.\n"
        "Return JSON only.\n\n"
        f"Issue:\n{issue[:MAX_ISSUE_CHARS]}"
    )
    r = model.generate([{"role": "user", "content": prompt}], schema=EXTRACT_SCHEMA, max_tokens=300)
    usage.add(r)
    data = parse_json(r.text)
    if data is None:
        usage.parse_failures += 1
        return ""
    terms = list(data.get("symbols") or []) + list(data.get("keywords") or [])
    # Symbols repeated so they outweigh generic prose in BM25.
    return " ".join([*(str(s) for s in data.get("symbols") or []), *(str(t) for t in terms)])


def _rerank(
    model: ModelProvider, issue: str, candidates: list[Ranked], graph: CodeGraph, usage: Usage
) -> list[Ranked]:
    lines = []
    for i, c in enumerate(candidates):
        sym = graph.symbols.get(c.symbol_id)
        sig = (sym.text.splitlines()[0][:100] if sym else "").strip()
        lines.append(f"{i}. {c.symbol_id} — {sig}")

    prompt = (
        "Which candidates most likely contain the code that must change?\n"
        "Return JSON: the candidate numbers ordered most to least likely. "
        "Include only plausible ones.\n\n"
        f"Issue:\n{issue[:MAX_ISSUE_CHARS]}\n\nCandidates:\n" + "\n".join(lines)
    )
    r = model.generate([{"role": "user", "content": prompt}], schema=RERANK_SCHEMA, max_tokens=300)
    usage.add(r)
    data = parse_json(r.text)
    if data is None:
        usage.parse_failures += 1
        return candidates
    order = data.get("ranked") or []

    picked: list[Ranked] = []
    seen: set[int] = set()
    for idx in order:
        if isinstance(idx, int) and 0 <= idx < len(candidates) and idx not in seen:
            seen.add(idx)
            picked.append(candidates[idx])
    # Anything the model dropped keeps its retrieval order behind the picks, so a lazy
    # or truncated response can never score worse than retrieval alone.
    picked.extend(c for i, c in enumerate(candidates) if i not in seen)
    return picked


def localize_assisted(
    graph: CodeGraph,
    issue: str,
    *,
    mode: str,
    model: ModelProvider,
    top_k: int = 10,
    base_mode: str = "hybrid",
    dense: tuple[list[str], object] | None = None,
    rerank_candidates: int = RERANK_CANDIDATES,
    notify: Callable[[str, dict], None] | None = None,
) -> tuple[list[Ranked], Usage]:
    """mode: extract | rerank | extract_rerank. `base_mode` picks the retrieval channels
    underneath, so recall and ranking improvements can be varied independently.

    `notify` narrates progress for the activity stream. The two model calls take seconds
    each; without these beats the UI shows dead air exactly where the work happens. Payloads
    carry counts only — never model names or prompt text."""
    loc = Localizer(graph, dense=dense)
    usage = Usage()

    def note(type_: str, **payload) -> None:
        if notify:
            notify(type_, payload)

    query = issue
    if mode in ("extract", "extract_rerank"):
        note("understand.started")
        try:
            extracted = _extract_query(model, issue, usage)
        except Exception:
            # A provider failure (sustained 429, auth) that survives the gateway's own
            # retries must not cost the whole job — the located results are still the
            # product. Degrade exactly like a parse failure: raw issue text as the query.
            log.exception("extract call failed; falling back to raw issue text")
            note("understand.failed")
            extracted = ""
        # Fall back to raw issue text if extraction produced nothing usable.
        query = f"{extracted} {issue[:500]}" if extracted else issue
        note("understand.done", terms=len(extracted.split()) if extracted else 0)

    if mode in ("rerank", "extract_rerank"):
        note("search.started", channels=base_mode)
        wide = loc.localize(query, mode=base_mode, top_k=rerank_candidates)
        note("candidates.found", count=len(wide))
        note("rank.started", pool=len(wide))
        try:
            ranked = _rerank(model, issue, wide, graph, usage)
        except Exception:
            # Same principle: a reranker call that raises degrades to retrieval order,
            # exactly like a parse failure, instead of erroring the whole job.
            log.exception("rerank call failed; falling back to retrieval order")
            note("rank.failed")
            ranked = wide
        return ranked[:top_k], usage

    note("search.started", channels=base_mode)
    res = loc.localize(query, mode=base_mode, top_k=top_k)
    note("candidates.found", count=len(res))
    return res, usage
