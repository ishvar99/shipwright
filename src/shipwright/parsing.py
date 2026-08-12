"""Tolerant JSON extraction from model replies.

Models wrap JSON in markdown fences and trailing chat tokens. A bare json.loads fails on
that and callers silently fall back — which would make a fine-tune look like it changed
nothing. Parse failures must be rare and visible, so every model-reply parse in the
project comes through here (assisted localization AND intent routing)."""

from __future__ import annotations

import json
import re

_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.S)


def parse_json(text: str) -> dict | None:
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
