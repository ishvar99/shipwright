"""Dense retrieval channel over symbol signatures.

Embedding a large repo costs ~170s (19k symbols, measured on Prefect), so the on-disk
cache is not an optimization — without it every ablation re-pays that per repo.

Signatures rather than bodies: measurably faster (170s vs 201s) and issues tend to name
symbols rather than quote implementation lines.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import httpx
import numpy as np

from ..config import settings
from .build import CodeGraph

CACHE = Path("evals/locbench/embcache")
BATCH = 64


def _signature(sym) -> str:
    first = sym.text.splitlines()[0][:120] if sym.text else ""
    return f"{sym.path} {sym.name} {sym.parent or ''} {first}"


def _embed(texts: list[str], model: str, timeout: float = 600.0) -> np.ndarray:
    out: list[list[float]] = []
    with httpx.Client(timeout=timeout) as client:
        for i in range(0, len(texts), BATCH):
            r = client.post(
                f"{settings.ollama_base_url}/api/embed",
                json={
                    "model": model,
                    "input": texts[i : i + BATCH],
                    "keep_alive": settings.keep_alive,
                },
            )
            r.raise_for_status()
            out.extend(r.json()["embeddings"])
    m = np.asarray(out, dtype=np.float32)
    # L2-normalise once so similarity is a plain dot product later.
    norms = np.linalg.norm(m, axis=1, keepdims=True)
    return m / np.clip(norms, 1e-9, None)


def symbol_matrix(
    graph: CodeGraph, *, model: str | None = None, cache_key: str = ""
) -> tuple[list[str], np.ndarray]:
    """Returns symbol ids and a row-normalised embedding matrix, cached on disk."""
    model = model or settings.embed_model
    ids = list(graph.symbols)
    texts = [_signature(graph.symbols[i]) for i in ids]

    # Key on the content, so a different checkout of the same repo misses correctly.
    digest = hashlib.sha256(("\n".join(texts) + model).encode()).hexdigest()[:16]
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / f"{cache_key or 'repo'}-{digest}.npz"

    if path.exists():
        data = np.load(path, allow_pickle=True)
        return list(data["ids"]), data["vectors"]

    vectors = _embed(texts, model) if texts else np.zeros((0, 768), dtype=np.float32)
    np.savez_compressed(path, ids=np.array(ids, dtype=object), vectors=vectors)
    return ids, vectors


def rank(query: str, ids: list[str], vectors: np.ndarray, *, model: str | None = None) -> list[str]:
    if not ids or vectors.size == 0:
        return []
    q = _embed([query], model or settings.embed_model)[0]
    scores = vectors @ q
    order = np.argsort(-scores)
    return [ids[i] for i in order]
