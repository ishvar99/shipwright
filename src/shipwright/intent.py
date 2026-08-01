"""What is the user actually asking for?

Every submission used to run the same pipeline: retrieve, rank, rewrite a function. Retrieval
always returns its top-k, and the fused RRF score is rank-derived — "how do I bake sourdough
bread" scores within 11% of a real bug report — so nothing downstream could tell that a
question was not a change request. The result was unrequested edits to the user's repository.

The gate is here, before any work starts.
"""

from __future__ import annotations

import re

CHANGE = "change"  # asks for the code to be different: bug report, feature request
QUESTION = "question"  # asks about the code: where is X, how does Y work
OTHER = "other"  # nothing to do here: greeting, off-topic, too vague to act on

SCHEMA = {
    "type": "object",
    "properties": {"intent": {"type": "string", "enum": [CHANGE, QUESTION, OTHER]}},
    "required": ["intent"],
}

_PROMPT = """You route requests for a code assistant. Classify the user's message.

change   — they want the code to behave differently: a bug report, a defect description, or
           a request to add or modify behaviour.
question — they want to understand this codebase. Includes the project as a whole ("what is
           this project", "what does this repo do") and specific parts ("where is auth
           handled", "how does the cache work").
other    — anything that is not about this codebase: greetings, thanks, small talk, questions
           about the assistant itself, off-topic requests, or a message too vague to act on
           (for example "it is broken" with no symptom).

Message:
{issue}"""

# Cheap, deterministic pre-filter. These never need a model call, and answering them in
# milliseconds is better product behaviour than a five-second think.
_GREETING = re.compile(
    r"^(hi|hey|hello|yo|thanks|thank you|ta|cheers|ok|okay|cool|nice"
    r"|good (morning|afternoon|evening))\b",
    re.I,
)
_META = re.compile(
    r"\b(what can you do|who are you|what are you|how do you work|help me use)\b", re.I
)
# "fix it", "it's broken" — a change request in grammar, but with nothing to act on.
_VAGUE = re.compile(
    r"^(please\s+)?(fix|repair|debug|solve)\s+(it|this|that|the (bug|issue|problem))[\s.!?]*$"
    r"|^(it|this|that)('?s| is)?\s*(broken|not working|buggy|failing)[\s.!?]*$",
    re.I,
)


def prefilter(issue: str) -> str | None:
    """A decided intent, or None when the model should look. Pure — the tested part."""
    text = issue.strip()
    if len(text) < 12:
        return OTHER
    # Nothing word-like to retrieve on: punctuation, emoji, or a keyboard mash.
    words = re.findall(r"[A-Za-z][A-Za-z_]{2,}", text)
    if not words:
        return OTHER
    if _VAGUE.search(text) or _META.search(text):
        return OTHER
    if _GREETING.match(text) and len(words) <= 4:
        return OTHER
    return None


def classify(issue: str, model=None) -> tuple[str, str]:
    """Returns (intent, reason). Falls back to `question` — never `change` — when the model
    is unavailable or answers oddly: the safe default is to look, not to edit."""
    decided = prefilter(issue)
    if decided:
        return decided, "handled without a model"
    if model is None:
        return QUESTION, "no model available"

    try:
        result = model.generate(
            [{"role": "user", "content": _PROMPT.format(issue=issue[:2000])}],
            schema=SCHEMA,
            temperature=0.0,
            max_tokens=16,
            timeout=30.0,
        )
        import json

        intent = str(json.loads(result.text).get("intent", "")).strip().lower()
        if intent not in (CHANGE, QUESTION, OTHER):
            return QUESTION, "unrecognised classification"
        return intent, "classified"
    except Exception:  # noqa: BLE001 - a routing failure must not fail the request
        return QUESTION, "classification unavailable"
