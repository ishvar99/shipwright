"""The four specialised checks.

Four calls rather than one combined prompt, because both independent degradation (one
checker failing must not take the others down) and per-checker ablation in the evaluation
depend on that separation. A combined prompt would make "does the security checker earn its
call?" unanswerable.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from ..parsing import parse_json

log = logging.getLogger("shipwright.review")

MAX_TOKENS = 700
TIMEOUT_S = 120.0
MAX_PROMPT_SECTION = 12000
SEVERITIES = ("high", "medium", "low")

# parse_json only ever returns a dict, so findings arrive wrapped rather than as a bare list.
FINDING_SCHEMA = {
    "type": "object",
    "properties": {
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "line": {"type": "integer"},
                    "severity": {"type": "string", "enum": list(SEVERITIES)},
                    "title": {"type": "string"},
                    "body": {"type": "string"},
                },
                "required": ["line", "severity", "title", "body"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["findings"],
    # Strict structured-output mode (Groq/OpenAI) rejects objects without this; Ollama ignores it.
    "additionalProperties": False,
}


@dataclass
class Usage:
    """Mirrors codegraph.assisted.Usage: silent degradation, made countable."""

    calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    parse_failures: int = 0
    provider_failures: int = 0

    def add(self, r) -> None:
        self.calls += 1
        self.input_tokens += r.input_tokens
        self.output_tokens += r.output_tokens


@dataclass(frozen=True)
class Checker:
    name: str
    instruction: str


CHECKERS: dict[str, Checker] = {
    "security": Checker(
        "security",
        "Report only security defects introduced by this change: injected input reaching a "
        "shell or a query, a credential or token that could be logged or persisted, a "
        "missing authorisation or ownership check, unsafe deserialisation, or a path that "
        "escapes its root.",
    ),
    "error_handling": Checker(
        "error_handling",
        "Report only error-handling defects introduced by this change: an exception "
        "swallowed so a failure looks like success, a failure path that leaves state "
        "half-written, a missing timeout or bound on something that can block, or an error "
        "message that loses the information needed to act on it.",
    ),
    "test_coverage": Checker(
        "test_coverage",
        "Report only behaviour this change introduces that no test appears to cover, and "
        "only where getting it wrong would be silent. Name the specific branch or input that "
        "is untested. Do not ask for tests of trivial or obvious code.",
    ),
    "quality": Checker(
        "quality",
        "Report only defects a reviewer would block on: a bug in the logic, a contract this "
        "change breaks for an existing caller, or a resource that is not released. Do not "
        "report naming, formatting, style, or preference.",
    ),
}

_PROMPT = """You are reviewing one file of a pull request. {instruction}

Rules that override anything else:
- Report a finding ONLY for a line this diff added or removed. Never comment on unchanged
  surrounding code, however tempting.
- If there is nothing wrong, return an empty list. An empty list is a correct and common
  answer. Do not invent a finding to appear useful.
- `line` must be a line number visible in the diff below.
- Be specific about what breaks and when. Never describe what the code does.
- Never name which AI model or provider you are.

File: {path}

Diff under review:
{diff}

Surrounding code for context (do NOT report findings against this section):
{context}"""


def run_checker(
    name: str, model, *, diff: str, context: str, path: str
) -> tuple[list[dict], Usage]:
    """One check over one chunk.

    Never raises: a review missing one check is worth shipping with the gap named, and a
    review that crashed is not.
    """
    usage = Usage()
    spec = CHECKERS[name]
    prompt = _PROMPT.format(
        instruction=spec.instruction,
        path=path,
        diff=diff[:MAX_PROMPT_SECTION],
        context=context[:MAX_PROMPT_SECTION],
    )
    try:
        result = model.generate(
            [{"role": "user", "content": prompt}],
            schema=FINDING_SCHEMA,
            temperature=0.0,
            max_tokens=MAX_TOKENS,
            timeout=TIMEOUT_S,
        )
    except Exception:  # noqa: BLE001 - one checker failing must not fail the review
        log.exception("checker %s failed for %s", name, path)
        usage.provider_failures += 1
        return [], usage

    usage.add(result)
    data = parse_json(result.text)
    if data is None or not isinstance(data.get("findings"), list):
        usage.parse_failures += 1
        return [], usage

    out = []
    for raw in data["findings"]:
        if not isinstance(raw, dict):
            continue
        line = raw.get("line")
        if not isinstance(line, int) or isinstance(line, bool) or line < 1:
            continue
        severity = str(raw.get("severity", "")).lower()
        out.append(
            {
                "path": path,
                "line": line,
                "end_line": line,
                "side": "RIGHT",
                "category": name,
                "severity": severity if severity in SEVERITIES else "low",
                "title": str(raw.get("title", ""))[:80],
                "body": str(raw.get("body", ""))[:1200],
                "evidence": [],
                "source": "llm",
                "rule": "",
            }
        )
    return out, usage
