import httpx
import pytest

from shipwright.api.github import PullRequestError
from shipwright.api.github_pr import fetch_pull_request, list_pull_requests, post_review


def _client(handler):
    return httpx.Client(
        transport=httpx.MockTransport(handler),
        headers={"accept": "application/vnd.github+json"},
    )


def test_list_pull_requests_maps_fields():
    def handler(request):
        return httpx.Response(
            200,
            json=[
                {
                    "number": 42,
                    "title": "Fix the race",
                    "user": {"login": "ada"},
                    "updated_at": "2026-08-01T00:00:00Z",
                    "draft": False,
                    "head": {"sha": "h1"},
                }
            ],
        )

    assert list_pull_requests("o/r", "tok", client=_client(handler)) == [
        {
            "number": 42,
            "title": "Fix the race",
            "author": "ada",
            "updated_at": "2026-08-01T00:00:00Z",
            "draft": False,
            "head_sha": "h1",
        }
    ]


def test_pull_request_without_a_head_sha_is_not_fatal():
    # A narrowed payload (or a PR GitHub is still computing) must degrade to "", never KeyError.
    def handler(request):
        return httpx.Response(200, json=[{"number": 1, "title": "t"}])

    assert list_pull_requests("o/r", "tok", client=_client(handler))[0]["head_sha"] == ""


def test_fetch_pull_request_paginates_files():
    pages = {
        1: [
            {"filename": f"f{i}.py", "patch": "@@ -1 +1 @@\n+x", "status": "modified"}
            for i in range(100)
        ],
        2: [{"filename": "last.py", "patch": "@@ -1 +1 @@\n+y", "status": "modified"}],
    }

    def handler(request):
        if request.url.path.endswith("/files"):
            return httpx.Response(200, json=pages.get(int(request.url.params.get("page", 1)), []))
        return httpx.Response(
            200,
            json={
                "title": "T",
                "body": "B",
                "head": {"sha": "headsha"},
                "base": {"sha": "basesha"},
            },
        )

    pr = fetch_pull_request("o/r", 42, "tok", client=_client(handler))
    assert pr["head_sha"] == "headsha"
    assert len(pr["files"]) == 101
    assert pr["files"][-1]["path"] == "last.py"
    assert pr["truncated"] is False


def test_file_without_a_patch_is_marked_unreviewable():
    def handler(request):
        if request.url.path.endswith("/files"):
            return httpx.Response(200, json=[{"filename": "huge.bin", "status": "modified"}])
        return httpx.Response(
            200, json={"title": "T", "body": "", "head": {"sha": "h"}, "base": {"sha": "b"}}
        )

    pr = fetch_pull_request("o/r", 1, "tok", client=_client(handler))
    assert pr["files"][0]["patch"] == ""
    assert pr["files"][0]["reviewable"] is False


def test_missing_pull_request_is_a_sentence():
    def handler(request):
        return httpx.Response(404, json={})

    with pytest.raises(PullRequestError) as e:
        fetch_pull_request("o/r", 9, "tok", client=_client(handler))
    assert "o/r" in str(e.value)


def test_rate_limit_is_its_own_sentence():
    def handler(request):
        return httpx.Response(403, json={})

    with pytest.raises(PullRequestError) as e:
        list_pull_requests("o/r", "tok", client=_client(handler))
    assert "rate-limiting" in str(e.value)


def test_post_review_sends_a_comment_event():
    seen = {}

    def handler(request):
        seen["body"] = request.read().decode()
        return httpx.Response(200, json={"id": 1, "html_url": "https://gh/r/1"})

    out = post_review(
        "o/r",
        42,
        {"commit_id": "c", "event": "COMMENT", "body": "b", "comments": []},
        "tok",
        client=_client(handler),
    )
    assert out["url"] == "https://gh/r/1"
    assert "COMMENT" in seen["body"]


def test_post_review_retries_once_without_the_rejected_comments():
    calls = []

    def handler(request):
        calls.append(request.read().decode())
        if len(calls) == 1:
            return httpx.Response(
                422,
                json={
                    "message": "Validation Failed",
                    "errors": [{"message": "line must be part of the diff"}],
                },
            )
        return httpx.Response(200, json={"id": 2, "html_url": "https://gh/r/2"})

    payload = {
        "commit_id": "c",
        "event": "COMMENT",
        "body": "b",
        "comments": [{"path": "a.py", "line": 1, "side": "RIGHT", "body": "x"}],
    }
    out = post_review("o/r", 42, payload, "tok", client=_client(handler))
    assert out["url"] == "https://gh/r/2"
    assert len(calls) == 2
    # The retry degrades to a summary rather than losing the review entirely.
    assert '"comments": []' in calls[1] or '"comments":[]' in calls[1]


def test_moved_head_is_reported_as_such():
    def handler(request):
        return httpx.Response(
            422,
            json={
                "message": "Validation Failed",
                "errors": [{"message": "commit_id is not part of the pull request"}],
            },
        )

    with pytest.raises(PullRequestError) as e:
        post_review(
            "o/r",
            42,
            {"commit_id": "old", "event": "COMMENT", "body": "b", "comments": []},
            "tok",
            client=_client(handler),
        )
    assert "moved" in str(e.value).lower()


def test_no_push_access_is_a_sentence():
    def handler(request):
        return httpx.Response(403, json={})

    with pytest.raises(PullRequestError) as e:
        post_review(
            "o/r",
            42,
            {"commit_id": "c", "event": "COMMENT", "body": "b", "comments": []},
            "tok",
            client=_client(handler),
        )
    assert "o/r" in str(e.value)
