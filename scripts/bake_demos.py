"""Image-build step: clone the demo repos, compute graph stats, write the seed manifest.

Runs in the Docker builder (fast machine), never at boot — stats cost minutes at 0.1 CPU,
and the whole point of baking is that a wake is instant. boot.seed_demos() reads the
manifest this writes."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from shipwright.codegraph.build import build

DEMOS = [
    # Small, permissively licensed, and the repo the recorded fixtures already use.
    (
        "AzureAD/microsoft-authentication-library-for-python",
        "https://github.com/AzureAD/microsoft-authentication-library-for-python",
    ),
]


def _git(args: list[str], cwd: Path) -> str:
    return subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, check=True
    ).stdout.strip()


def main(root: str = "workspaces/_demo") -> None:
    base = Path(root)
    base.mkdir(parents=True, exist_ok=True)
    manifest = []
    for slug, url in DEMOS:
        dest = base / slug.replace("/", "__")
        if not (dest / ".git").exists():
            subprocess.run(["git", "clone", "--depth", "1", url, str(dest)], check=True)
        # apply() commits on this tree; a bare container has no git identity.
        _git(["config", "user.email", "fix@shipwright.local"], dest)
        _git(["config", "user.name", "Shipwright"], dest)
        stats = build(dest).stats()
        manifest.append({
            "slug": slug,
            "url": url,
            "path": str(dest),  # relative — resolved against WORKDIR /app at runtime
            "import_ref": _git(["rev-parse", "HEAD"], dest),
            "default_ref": _git(["rev-parse", "--short", "HEAD"], dest),
            "symbols": stats["symbols"],
            "files": stats["files"],
        })
    (base / "demos.json").write_text(json.dumps(manifest, indent=1))
    print(f"baked {len(manifest)} demo repo(s) -> {base / 'demos.json'}")


if __name__ == "__main__":
    main(*sys.argv[1:])
