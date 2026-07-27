"""Hybrid localization: BM25 over symbols, expanded through the call graph, fused with
Reciprocal Rank Fusion.

Keeping the sparse channel is deliberate — published ablations find keyword matching gives
the most reliable grounding, and removing it from a graph-guided retriever hurts badly.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from rank_bm25 import BM25Okapi

from .build import CodeGraph

TOKEN = re.compile(r"[A-Za-z_][A-Za-z0-9_]+")
RRF_K = 60


def tokenize(text: str) -> list[str]:
    """Split identifiers on case and underscores so `segment2box` matches `segment`."""
    out: list[str] = []
    for word in TOKEN.findall(text):
        out.append(word.lower())
        out.extend(p.lower() for p in re.split(r"_|(?<=[a-z0-9])(?=[A-Z])", word) if len(p) > 2)
    return out


@dataclass
class Ranked:
    symbol_id: str
    score: float
    channels: tuple[str, ...]


class Localizer:
    def __init__(self, graph: CodeGraph):
        self.graph = graph
        self.ids = list(graph.symbols)
        corpus = []
        for sid in self.ids:
            sym = graph.symbols[sid]
            # Weight the identifier over the body: issues name symbols far more often
            # than they quote implementation lines.
            head = f"{sym.path} {sym.name} {sym.name} {sym.name} {sym.parent or ''}"
            corpus.append(tokenize(head) + tokenize(sym.text[:4000]))
        self.bm25 = BM25Okapi(corpus) if corpus else None

    def _bm25_rank(self, query: str, limit: int) -> list[str]:
        if not self.bm25:
            return []
        scores = self.bm25.get_scores(tokenize(query))
        order = sorted(range(len(scores)), key=lambda i: -scores[i])[:limit]
        return [self.ids[i] for i in order if scores[i] > 0]

    def localize(self, query: str, *, mode: str = "hybrid", top_k: int = 10) -> list[Ranked]:
        """mode: bm25 | graph | hybrid. `graph` expands BM25 seeds through call edges."""
        seeds = self._bm25_rank(query, limit=max(top_k * 5, 50))
        if mode == "bm25":
            return [Ranked(s, 1 / (RRF_K + i + 1), ("bm25",)) for i, s in enumerate(seeds[:top_k])]

        # Graph channel: rank seed neighbours by how many seeds reach them, so a function
        # touched by several suspicious callers rises even if it never matched the text.
        votes: dict[str, int] = {}
        for rank, sid in enumerate(seeds[:20]):
            for nb in self.graph.neighbors(sid, hops=1):
                votes[nb] = votes.get(nb, 0) + (20 - rank)
        graph_rank = [s for s, _ in sorted(votes.items(), key=lambda kv: -kv[1])]

        if mode == "graph":
            return [
                Ranked(s, 1 / (RRF_K + i + 1), ("graph",)) for i, s in enumerate(graph_rank[:top_k])
            ]

        fused: dict[str, float] = {}
        channels: dict[str, set[str]] = {}
        for name, ranking in (("bm25", seeds), ("graph", graph_rank)):
            for i, sid in enumerate(ranking):
                fused[sid] = fused.get(sid, 0.0) + 1 / (RRF_K + i + 1)
                channels.setdefault(sid, set()).add(name)

        best = sorted(fused.items(), key=lambda kv: -kv[1])[:top_k]
        return [Ranked(s, sc, tuple(sorted(channels[s]))) for s, sc in best]
