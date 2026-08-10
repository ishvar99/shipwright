"""Opening a pull request for an applied fix.

The only place Shipwright writes to somebody else's account, so the rules are narrow: the
token arrives per-call and is never stored, it reaches git through an auth header rather than
a URL or argv, and every failure is turned into a sentence a user can act on instead of raw
git stderr.
"""

from __future__ import annotations

import base64
import os
import subprocess
from pathlib import Path

import httpx

API = "https://api.github.com"
TIMEOUT = 20.0


class PullRequestError(RuntimeError):
    """Carries a message meant for the user, already free of credentials."""


def _auth_env(token: str) -> dict[str, str]:
    """Same mechanism as the clone path: never in the URL (which lands in .git/config and in
    stderr) and never in argv (which any process on the box can read)."""
    basic = base64.b64encode(f"x-access-token:{token}".encode()).decode()
    return {
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "http.extraHeader",
        "GIT_CONFIG_VALUE_0": f"Authorization: Basic {basic}",
    }


def push_failure(stderr: str, slug: str) -> str:
    """git's push errors, as something actionable. The raw text names the remote URL and is
    the one place a credential could surface, so it is never shown."""
    text = stderr.lower()
    if "403" in text or "permission" in text or "denied" in text or "not authorized" in text:
        return f"You don't have push access to {slug}."
    if "404" in text or "repository not found" in text:
        return f"{slug} isn't reachable — it may be private, renamed, or deleted."
    # Before the "rejected" rule: a shallow refusal is worded as a rejection and would
    # otherwise be reported as a branch conflict that does not exist.
    if "shallow" in text:
        return "GitHub refused a push from our shallow copy. Re-import the repository first."
    if "non-fast-forward" in text or "rejected" in text:
        return "That branch already exists on GitHub with different commits."
    if "src refspec" in text or "does not match any" in text:
        return "That fix branch is no longer in the workspace. Apply the fix again."
    if "authentication failed" in text or "could not read username" in text:
        return "Your GitHub connection was refused. Reconnect GitHub and try again."
    return "Pushing the branch to GitHub failed."


def push_branch(repo_dir: Path, slug: str, branch: str, token: str) -> None:
    """Push straight to the URL — no remote is added, so no credential path outlives the call.
    The workspace is a --depth 1 clone; pushing a commit whose parent the remote already has
    is fine, which is the only case that can arise here."""
    r = subprocess.run(
        ["git", "push", f"https://github.com/{slug}.git", f"{branch}:{branch}"],
        cwd=repo_dir,
        capture_output=True,
        text=True,
        timeout=120,
        # Inherited, like the clone path: a hand-built PATH is what resolves `git` itself, and
        # guessing it wrong is a FileNotFoundError on somebody else's box. GIT_TERMINAL_PROMPT
        # turns a rejected header into an error instead of a wait for input nobody can give.
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0", **_auth_env(token)},
    )
    if r.returncode != 0:
        raise PullRequestError(push_failure(r.stderr, slug))


def _ask(call):
    """A transport failure is a sentence too. By the time either call below runs the branch is
    already on GitHub, and a bare ReadTimeout escaping here would be classified as an engine
    outage — telling the user the model is down when GitHub was, and never telling them their
    branch was pushed."""
    try:
        return call()
    except httpx.HTTPError as e:
        raise PullRequestError(
            "The branch is on GitHub, but the pull request could not be created — "
            "GitHub didn't answer. Press the button again."
        ) from e


def _client(token: str) -> httpx.Client:
    return httpx.Client(
        timeout=TIMEOUT,
        headers={"accept": "application/vnd.github+json", "authorization": f"Bearer {token}"},
    )


def default_branch(slug: str, token: str) -> str:
    """The PR base. NOT `Repo.default_ref`, which is `rev-parse --short HEAD` — a commit sha,
    which GitHub rejects as a base. Asking is one call and always right."""
    with _client(token) as c:
        r = _ask(lambda: c.get(f"{API}/repos/{slug}"))
        if r.status_code == 404:
            raise PullRequestError(f"{slug} isn't reachable with your GitHub connection.")
        if r.status_code >= 400:
            raise PullRequestError("GitHub is not responding right now.")
        return str(r.json().get("default_branch") or "main")


def pr_body(issue: str, fix: dict) -> str:
    """States what the change is, what proved it, and who wrote it. The attribution is not
    decoration: a reviewer must know a model produced this before they read the diff."""
    tests = fix.get("tests") or {}
    lines = [
        "### What this changes",
        "",
        (issue.strip().splitlines() or ["(no description)"])[0][:200],
        "",
    ]
    target = fix.get("target") or {}
    if target.get("path"):
        lines += [f"Located to `{target.get('name', '')}` in `{target['path']}`.", ""]
    if tests:
        passed, failed = tests.get("passed", 0), tests.get("failed", 0)
        lines += [
            f"Tests after the change: **{passed} passed, {failed} failed**"
            + (" — the suite is green." if not failed else " — review the failures."),
            "",
        ]
    else:
        lines += ["The test suite was not run against this change.", ""]
    lines += ["---", "", "Written by Shipwright from the report above, and reviewed by nobody yet."]
    return "\n".join(lines)


def open_pull_request(slug: str, branch: str, base: str, title: str, body: str, token: str) -> dict:
    """Creates the PR, or returns the one that already exists for this branch.

    Idempotent on purpose: pressing the button twice, or retrying after a timeout, must not
    fail. GitHub 422s when a PR already exists for the head, and the useful answer then is
    that PR, not an error.
    """
    with _client(token) as c:
        r = _ask(
            lambda: c.post(
                f"{API}/repos/{slug}/pulls",
                json={"title": title, "head": branch, "base": base, "body": body},
            )
        )
        if r.status_code == 201:
            data = r.json()
            return {"url": data["html_url"], "number": data["number"]}
        if r.status_code == 422:
            owner = slug.split("/", 1)[0]
            params = {"head": f"{owner}:{branch}", "state": "open"}
            existing = _ask(lambda: c.get(f"{API}/repos/{slug}/pulls", params=params))
            if existing.status_code == 200 and existing.json():
                data = existing.json()[0]
                return {"url": data["html_url"], "number": data["number"]}
            detail = "; ".join(e.get("message", "") for e in r.json().get("errors", []))
            raise PullRequestError(detail[:200] or "GitHub refused the pull request.")
        if r.status_code in (401, 403):
            raise PullRequestError(f"Your GitHub connection can't open pull requests on {slug}.")
        raise PullRequestError("GitHub is not responding right now.")
