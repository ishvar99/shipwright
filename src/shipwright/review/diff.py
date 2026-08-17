"""Unified-diff parsing, and the set of positions a comment may legally occupy.

`postable` is the load-bearing function in this package. It is the anti-noise gate — a model
asked to review a diff will confidently comment on the unchanged code around it — and it is
also a hard GitHub requirement: a review comment on a line outside the diff is rejected, and
because the review is posted as one batched object, one bad line rejects every finding in it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# @@ -old_start,old_count +new_start,new_count @@ optional trailing context
_HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")
_FILE = re.compile(r"^diff --git a/(.*?) b/(.*)$")

Position = tuple[str, int, str]  # (path, line, "LEFT" | "RIGHT")


@dataclass(frozen=True)
class Hunk:
    old_start: int
    new_start: int
    lines: tuple[str, ...]  # raw, each keeping its leading '+', '-' or ' '


@dataclass(frozen=True)
class FileDiff:
    path: str
    hunks: tuple[Hunk, ...]
    additions: int
    deletions: int

    @property
    def changed(self) -> int:
        return self.additions + self.deletions

    @property
    def added_lines(self) -> frozenset[int]:
        """New-side line numbers of added lines. These carry RIGHT-side comments."""
        out: set[int] = set()
        for hunk in self.hunks:
            line = hunk.new_start
            for raw in hunk.lines:
                if raw.startswith("+"):
                    out.add(line)
                    line += 1
                elif not raw.startswith("-"):
                    line += 1
        return frozenset(out)

    @property
    def deleted_lines(self) -> frozenset[int]:
        """Old-side line numbers of removed lines. These carry LEFT-side comments.

        Kept rather than dropped because a bug is often the *removal* of a guard, which has
        no added line to point at — and a reversed gold patch, which is how reviewbench
        builds its positives, is exactly that shape.
        """
        out: set[int] = set()
        for hunk in self.hunks:
            line = hunk.old_start
            for raw in hunk.lines:
                if raw.startswith("-"):
                    out.add(line)
                    line += 1
                elif not raw.startswith("+"):
                    line += 1
        return frozenset(out)


def _hunks(patch: str) -> tuple[tuple[Hunk, ...], int, int]:
    hunks: list[Hunk] = []
    additions = deletions = 0
    current: list[str] | None = None
    old_start = new_start = 0

    def flush() -> None:
        if current is not None:
            hunks.append(Hunk(old_start=old_start, new_start=new_start, lines=tuple(current)))

    for raw in patch.splitlines():
        m = _HUNK.match(raw)
        if m:
            flush()
            old_start, new_start = int(m.group(1)), int(m.group(3))
            current = []
            continue
        if current is None:
            # Preamble (---, +++, index, or a malformed header we refused to parse).
            continue
        if raw.startswith("+"):
            additions += 1
        elif raw.startswith("-"):
            deletions += 1
        current.append(raw)
    flush()
    return tuple(hunks), additions, deletions


def parse_file_patch(path: str, patch: str) -> FileDiff:
    """One file's hunks, the shape GitHub's /pulls/{n}/files returns.

    An empty patch is a legitimate input, not an error: GitHub omits `patch` entirely on very
    large files, and those must be reported as unreviewed rather than crash the run.
    """
    hunks, additions, deletions = _hunks(patch or "")
    return FileDiff(path=path, hunks=hunks, additions=additions, deletions=deletions)


def parse_unified(patch: str) -> list[FileDiff]:
    """A whole multi-file patch, the shape a gold patch or `git diff` produces."""
    if not patch.strip():
        return []
    out: list[FileDiff] = []
    path: str | None = None
    buf: list[str] = []

    def flush() -> None:
        if path is not None:
            out.append(parse_file_patch(path, "\n".join(buf)))

    for raw in patch.splitlines():
        m = _FILE.match(raw)
        if m:
            flush()
            path = m.group(2)
            buf = []
            continue
        buf.append(raw)
    flush()
    return out


def postable(diffs: list[FileDiff]) -> set[Position]:
    """Every position a review comment may legally occupy."""
    out: set[Position] = set()
    for d in diffs:
        out |= {(d.path, n, "RIGHT") for n in d.added_lines}
        out |= {(d.path, n, "LEFT") for n in d.deleted_lines}
    return out


EXCERPT_MAX_LINES = 40


def excerpt(fd: FileDiff, line: int, side: str) -> str:
    """The hunk containing an anchor, as prefixed diff lines under a header.

    Stored on each surviving finding at review time: the job row does not retain per-file
    patches, and refetching from GitHub at view time would add a network hop and fail on
    expired tokens. Bounded, because one enormous hunk on a 25-finding review would bloat
    the row and the wire. When the window clips the hunk, the header reports the true
    first new-side line of the slice (not the hunk's), and says so.
    """
    for hunk in fd.hunks:
        new_n, old_n = hunk.new_start, hunk.old_start
        index = None
        new_at: list[int] = []
        for i, raw in enumerate(hunk.lines):
            new_at.append(new_n)
            if raw.startswith("+"):
                if side == "RIGHT" and new_n == line:
                    index = i
                new_n += 1
            elif raw.startswith("-"):
                if side == "LEFT" and old_n == line:
                    index = i
                old_n += 1
            else:
                if side == "RIGHT" and new_n == line:
                    index = i
                new_n += 1
                old_n += 1
        if index is None:
            continue
        lines = list(hunk.lines)
        start = hunk.new_start
        clipped = ""
        if len(lines) > EXCERPT_MAX_LINES:
            half = EXCERPT_MAX_LINES // 2
            # Clamped so a late anchor still gets a full window instead of trailing off
            # the end of the hunk with fewer than EXCERPT_MAX_LINES lines.
            lo = max(0, min(index - half, len(lines) - EXCERPT_MAX_LINES))
            lines = lines[lo : lo + EXCERPT_MAX_LINES]
            start = new_at[lo]
            clipped = ", clipped"
        return "\n".join([f"@@ hunk at line {start}{clipped} @@", *lines])
    return ""
