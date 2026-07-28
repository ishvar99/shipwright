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

import json
import re
from dataclasses import dataclass

from ..gateway.base import ModelProvider
from .build import CodeGraph
from .retrieve import Localizer, Ranked

EXTRACT_SCHEMA = {
    "type": "object",
    "properties": {
        "symbols": {"type": "array", "items": {"type": "string"}},
        "keywords": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["symbols", "keywords"],
}

# Indices, not ids: small models mangle long strings but handle integers reliably.
RERANK_SCHEMA = {
    "type": "object",
    "properties": {"ranked": {"type": "array", "items": {"type": "integer"}}},
    "required": ["ranked"],
}

MAX_ISSUE_CHARS = 3000
RERANK_CANDIDATES = 30
_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.S)


def _parse_json(text: str) -> dict | None:
    """Models wrap JSON in markdown fences and trailing chat tokens. A bare json.loads
    fails on that and the caller silently falls back to retrieval order — which would make
    a fine-tune look like it changed nothing. Parse failures must be rare and visible."""
    if not text:
        return None
    raw = text.strip()
    for token in ("<|im_end|>", "<|endoftext|>", "</s>"):
        raw = raw.replace(token, "")
    m = _FENCE.search(raw)
    if m:
        raw = m.group(1).strip()
    else:
        start, end = raw.find("{"), raw.rfind("}")
        if start != -1 and end > start:
            raw = raw[start : end + 1]
    try:
        out = json.loads(raw)
        return out if isinstance(out, dict) else None
    except json.JSONDecodeError:
        return None


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
    data = _parse_json(r.text)
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
    data = _parse_json(r.text)
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
) -> tuple[list[Ranked], Usage]:
    """mode: extract | rerank | extract_rerank. `base_mode` picks the retrieval channels
    underneath, so recall and ranking improvements can be varied independently."""
    loc = Localizer(graph, dense=dense)
    usage = Usage()

    query = issue
    if mode in ("extract", "extract_rerank"):
        extracted = _extract_query(model, issue, usage)
        # Fall back to raw issue text if extraction produced nothing usable.
        query = f"{extracted} {issue[:500]}" if extracted else issue

    if mode in ("rerank", "extract_rerank"):
        wide = loc.localize(query, mode=base_mode, top_k=rerank_candidates)
        return _rerank(model, issue, wide, graph, usage)[:top_k], usage

    return loc.localize(query, mode=base_mode, top_k=top_k), usage
