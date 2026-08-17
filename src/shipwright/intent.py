"""What is the user actually asking for?

Every submission used to run the same pipeline: retrieve, rank, rewrite a function. Retrieval
always returns its top-k, and the fused RRF score is rank-derived — "how do I bake sourdough
bread" scores within 11% of a real bug report — so nothing downstream could tell that a
question was not a change request. The result was unrequested edits to the user's repository.

The gate is here, before any work starts.
"""

from __future__ import annotations

import re

from .parsing import parse_json

CHANGE = "change"  # asks for the code to be different: bug report, feature request
QUESTION = "question"  # asks about the code: where is X, how does Y work
OTHER = "other"  # nothing to do here: greeting, off-topic, too vague to act on

SCHEMA = {
    "type": "object",
    "properties": {"intent": {"type": "string", "enum": [CHANGE, QUESTION, OTHER]}},
    "required": ["intent"],
    # Strict structured-output mode (Groq/OpenAI) rejects objects without this; Ollama ignores it.
    "additionalProperties": False,
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
    r"\b(what can you do|who are you|what are you|how do you work|help me use"
    # Identity probes belong here rather than at the model: the capabilities answer is the
    # right reply, and a prompt rule is a request while a route is a guarantee.
    r"|which (ai |llm |model)|what (ai |llm |model)|are you (chatgpt|claude|gpt|llama|qwen|gemini)"
    r"|built on)\b",
    re.I,
)
# "fix it", "it's broken" — a change request in grammar, but with nothing to act on.
_VAGUE = re.compile(
    r"^(please\s+)?(fix|repair|debug|solve)\s+(it|this|that|the (bug|issue|problem))[\s.!?]*$"
    r"|^(it|this|that)('?s| is)?\s*(broken|not working|buggy|failing)[\s.!?]*$",
    re.I,
)


def prefilter(issue: str) -> tuple[str, str] | None:
    """A decided (intent, reason), or None when the model should look. Pure — the tested part.

    The reason names WHICH rule fired, because the right reply differs by subclass: "what can
    you do" deserves a capabilities answer, "fix it" deserves a request for the symptom, and
    only a keyboard mash deserves "nothing to work on"."""
    text = issue.strip()
    # Meta before length: "help me" and "who are you" are short AND about the assistant, and
    # the capabilities answer is the better reply for both.
    if _META.search(text):
        return OTHER, "meta"
    if len(text) < 12:
        return OTHER, "chitchat" if _GREETING.match(text) else "vague"
    # Nothing word-like to retrieve on: punctuation, emoji, or a keyboard mash.
    words = re.findall(r"[A-Za-z][A-Za-z_]{2,}", text)
    if not words:
        return OTHER, "nonsense"
    if _VAGUE.search(text):
        return OTHER, "vague"
    if _GREETING.match(text) and len(words) <= 4:
        return OTHER, "chitchat"
    return None


def classify(issue: str, model=None) -> tuple[str, str]:
    """Returns (intent, reason). Falls back to `question` — never `change` — when the model
    is unavailable or answers oddly: the safe default is to look, not to edit."""
    decided = prefilter(issue)
    if decided:
        return decided
    if model is None:
        return QUESTION, "no model available"

    try:
        result = model.generate(
            [{"role": "user", "content": _PROMPT.format(issue=issue[:2000])}],
            schema=SCHEMA,
            temperature=0.0,
            # 64, not 16: a hosted provider without constrained decoding may spend tokens
            # on fences before the JSON; 16 truncates it into an unparseable stub.
            max_tokens=64,
            timeout=30.0,
        )
        data = parse_json(result.text) or {}
        intent = str(data.get("intent", "")).strip().lower()
        if intent not in (CHANGE, QUESTION, OTHER):
            return QUESTION, "unrecognised classification"
        return intent, "classified"
    except Exception:  # noqa: BLE001 - a routing failure must not fail the request
        return QUESTION, "classification unavailable"
