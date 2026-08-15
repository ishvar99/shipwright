"""Reading pull requests, and posting one review back.

Same rules as github.py, which is the only other place we touch somebody else's account: the
token arrives per call and is never stored, and every failure becomes a sentence the user can
act on rather than a status code.
"""

from __future__ import annotations

import httpx

from .github import API, TIMEOUT, PullRequestError

PER_PAGE = 100
# GitHub caps /pulls/{n}/files at 3000 entries; 30 pages of 100 reaches exactly that.
MAX_PAGES = 30


def _client(token: str) -> httpx.Client:
    return httpx.Client(
        timeout=TIMEOUT,
        headers={"accept": "application/vnd.github+json", "authorization": f"Bearer {token}"},
    )


def _get(client: httpx.Client, url: str, slug: str, **params) -> httpx.Response:
    try:
        r = client.get(url, params=params or None)
    except httpx.HTTPError as e:
        raise PullRequestError("GitHub didn't answer. Try again in a moment.") from e
    if r.status_code == 404:
        raise PullRequestError(f"{slug} isn't reachable with your GitHub connection.")
    if r.status_code == 403:
        raise PullRequestError("GitHub is rate-limiting us. Try again shortly.")
    if r.status_code >= 400:
        raise PullRequestError("GitHub is not responding right now.")
    return r


def list_pull_requests(slug: str, token: str, *, client: httpx.Client | None = None) -> list[dict]:
    """Open pull requests, for the picker."""
    own = client is None
    c = client or _client(token)
    try:
        r = _get(c, f"{API}/repos/{slug}/pulls", slug, state="open", per_page=PER_PAGE)
        return [
            {
                "number": p.get("number"),
                "title": p.get("title") or "",
                "author": (p.get("user") or {}).get("login", ""),
                "updated_at": p.get("updated_at") or "",
                "draft": bool(p.get("draft")),
            }
            for p in r.json()
        ]
    finally:
        if own:
            c.close()


def fetch_pull_request(
    slug: str, number: int, token: str, *, client: httpx.Client | None = None
) -> dict:
    """Title, body, head/base shas, and every file's patch.

    A file with no `patch` is not skipped silently: GitHub omits it for very large files, and
    the review has to be able to say that file went unreviewed.
    """
    own = client is None
    c = client or _client(token)
    try:
        meta = _get(c, f"{API}/repos/{slug}/pulls/{number}", slug).json()
        files: list[dict] = []
        truncated = False
        for page in range(1, MAX_PAGES + 1):
            rows = _get(
                c,
                f"{API}/repos/{slug}/pulls/{number}/files",
                slug,
                per_page=PER_PAGE,
                page=page,
            ).json()
            if not rows:
                break
            for row in rows:
                patch = row.get("patch") or ""
                files.append(
                    {
                        "path": row.get("filename") or "",
                        "status": row.get("status") or "",
                        "patch": patch,
                        "reviewable": bool(patch),
                    }
                )
            if len(rows) < PER_PAGE:
                break
        else:
            # Ran out of pages with every page full: there is more than we fetched.
            truncated = True
        return {
            "number": number,
            "title": meta.get("title") or "",
            "body": meta.get("body") or "",
            "head_sha": (meta.get("head") or {}).get("sha", ""),
            "base_sha": (meta.get("base") or {}).get("sha", ""),
            "files": files,
            "truncated": truncated,
        }
    finally:
        if own:
            c.close()


def _errors(response: httpx.Response) -> str:
    try:
        return " ".join(e.get("message", "") for e in response.json().get("errors", []))
    except ValueError:
        return ""


def post_review(
    slug: str, number: int, payload: dict, token: str, *, client: httpx.Client | None = None
) -> dict:
    """Post one review. On a line-anchoring rejection, retry once without inline comments.

    GitHub refuses a comment on a line outside the diff and rejects the entire review with
    it. merge() already gates for this, but the head can move between reviewing and posting,
    so a summary-only review beats losing the findings altogether.
    """
    own = client is None
    c = client or _client(token)
    try:
        for attempt in (0, 1):
            try:
                r = c.post(f"{API}/repos/{slug}/pulls/{number}/reviews", json=payload)
            except httpx.HTTPError as e:
                raise PullRequestError("GitHub didn't answer. Press the button again.") from e
            if r.status_code in (200, 201):
                data = r.json()
                return {"url": data.get("html_url", ""), "id": data.get("id")}
            if r.status_code in (401, 403):
                raise PullRequestError(
                    f"Your GitHub connection can't review pull requests on {slug}."
                )
            if r.status_code == 422:
                detail = _errors(r).lower()
                if "commit_id" in detail or "not part of the pull request" in detail:
                    raise PullRequestError(
                        "This pull request moved since it was reviewed. Review it again."
                    )
                if attempt == 0 and payload.get("comments"):
                    payload = {**payload, "comments": []}
                    continue
                raise PullRequestError("GitHub refused the review comments.")
            raise PullRequestError("GitHub is not responding right now.")
        raise PullRequestError("GitHub refused the review.")
    finally:
        if own:
            c.close()
