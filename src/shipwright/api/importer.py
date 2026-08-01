"""Zip import: validate hard, reject with copy the user can act on, and never let an
uploaded archive influence git. A `.git/hooks/pre-commit` inside the zip would otherwise run
as the server user on our own import commit."""

from __future__ import annotations

import shutil
import zipfile
from pathlib import Path

MAX_ENTRIES = 10_000
MAX_TOTAL = 500 * 1024 * 1024
MAX_COMPRESSED = 150 * 1024 * 1024
MAX_RATIO = 100


class ZipRejected(Exception):
    """Message is user-facing copy, stored verbatim on the repo row — never a repr."""


def _is_symlink(info: zipfile.ZipInfo) -> bool:
    return (info.external_attr >> 16) & 0o170000 == 0o120000


def validate(zip_path: Path) -> None:
    if zip_path.stat().st_size > MAX_COMPRESSED:
        raise ZipRejected("That archive is too large (limit 150 MB).")
    if not zipfile.is_zipfile(zip_path):
        raise ZipRejected("That file isn't a zip archive.")
    with zipfile.ZipFile(zip_path) as zf:
        infos = zf.infolist()
        if len(infos) > MAX_ENTRIES:
            raise ZipRejected("That archive has too many files (limit 10,000).")
        total = compressed = 0
        for info in infos:
            name = info.filename
            # Reject rather than sanitise: zipfile silently drops ".." components, which
            # would import a mangled tree instead of telling the user what was wrong.
            if name.startswith("/") or "\\" in name or ".." in Path(name).parts:
                raise ZipRejected("That archive contains unsafe file paths.")
            if _is_symlink(info):
                raise ZipRejected("That archive contains symlinks, which aren't supported.")
            total += info.file_size
            compressed += info.compress_size
        if total > MAX_TOTAL:
            raise ZipRejected("That archive is too large uncompressed (limit 500 MB).")
        if compressed and total / compressed > MAX_RATIO:
            raise ZipRejected("That archive expands too much to be a real project.")


def extract(zip_path: Path, dest: Path) -> None:
    """Stream with a running byte cap — the sizes in the header are not evidence."""
    dest.mkdir(parents=True, exist_ok=True)
    root = dest.resolve()
    written = 0
    with zipfile.ZipFile(zip_path) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            target = (dest / info.filename).resolve()
            try:
                target.relative_to(root)
            except ValueError:
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, open(target, "wb") as out:
                while chunk := src.read(65536):
                    written += len(chunk)
                    if written > MAX_TOTAL:
                        raise ZipRejected("That archive is too large uncompressed (limit 500 MB).")
                    out.write(chunk)
    _normalise(dest)
    if not any(dest.rglob("*")):
        raise ZipRejected("That archive is empty.")


def _strip_git(root: Path) -> None:
    shutil.rmtree(root / ".git", ignore_errors=True)
    shutil.rmtree(root / "__MACOSX", ignore_errors=True)


def _normalise(dest: Path) -> None:
    """Drop the uploaded git dir and mac cruft, then hoist a single wrapper directory so
    `zip -r proj.zip proj/` and a zip of the folder's contents import identically."""
    _strip_git(dest)
    entries = list(dest.iterdir())
    if len(entries) == 1 and entries[0].is_dir():
        wrapper = entries[0]
        for child in list(wrapper.iterdir()):
            shutil.move(str(child), str(dest / child.name))
        wrapper.rmdir()
        _strip_git(dest)  # the wrapper's own .git is only reachable after hoisting
