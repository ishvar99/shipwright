from shipwright.gateway.base import GenResult
from shipwright.review.run import review_diff


class FakeModel:
    tier = "local"
    model = "fake"

    def __init__(self, text: str = '{"findings": []}'):
        self.text = text
        self.calls = 0

    def generate(self, messages, **kwargs):
        self.calls += 1
        return GenResult(text=self.text, model="fake", input_tokens=5, output_tokens=2)


class DownModel:
    tier = "local"
    model = "fake"

    def generate(self, messages, **kwargs):
        raise RuntimeError("provider down")


def _repo(tmp_path):
    (tmp_path / "a.py").write_text("import os\n\n\ndef f():\n    return os.getcwd()\n")
    return tmp_path


FILES = [
    {
        "path": "a.py",
        "status": "modified",
        "reviewable": True,
        "patch": "@@ -1,3 +1,4 @@\n import os\n+import subprocess\n \n def f():",
    }
]


def test_produces_a_result_with_findings_and_coverage(tmp_path):
    out = review_diff(root=_repo(tmp_path), files=FILES, intent="", model=FakeModel())
    assert isinstance(out["findings"], list)
    assert out["coverage"]["files"] == 1
    assert out["coverage"]["reviewed"] == 1
    assert out["complete"] is True


def test_unreviewable_file_is_counted_not_hidden(tmp_path):
    files = [*FILES, {"path": "big.bin", "status": "modified", "patch": "", "reviewable": False}]
    out = review_diff(root=_repo(tmp_path), files=files, intent="", model=FakeModel())
    assert out["coverage"]["files"] == 2
    assert out["coverage"]["reviewed"] == 1
    assert "big.bin" in out["coverage"]["unreviewed"]
    # Anything unreviewed makes the review partial, never silently complete.
    assert out["complete"] is False


def test_a_failing_model_degrades_to_a_partial_review(tmp_path):
    out = review_diff(root=_repo(tmp_path), files=FILES, intent="", model=DownModel())
    assert out["complete"] is False
    assert out["coverage"]["degraded"]
    # Ruff still ran, so the review is degraded rather than absent.
    assert isinstance(out["findings"], list)
    assert out["usage"]["provider_failures"] > 0


def test_deterministic_only_mode_makes_no_model_calls(tmp_path):
    model = FakeModel()
    out = review_diff(root=_repo(tmp_path), files=FILES, intent="", model=model, checkers=())
    assert model.calls == 0
    assert out["coverage"]["tier"] == "none"


def test_notify_receives_stage_beats(tmp_path):
    events = []
    review_diff(
        root=_repo(tmp_path),
        files=FILES,
        intent="",
        model=FakeModel(),
        notify=lambda t, p: events.append(t),
    )
    assert "review.chunked" in events
    assert "review.ready" in events
    assert any(t.startswith("review.stage.") for t in events)


def test_chunk_cap_names_what_it_skipped(tmp_path):
    root = _repo(tmp_path)
    files = [
        {
            "path": f"f{i}.py",
            "status": "modified",
            "reviewable": True,
            "patch": f"@@ -1,1 +1,2 @@\n x\n+y{i}",
        }
        for i in range(5)
    ]
    out = review_diff(
        root=root, files=files, intent="", model=FakeModel(), checkers=(), max_chunks=2
    )
    assert out["coverage"]["reviewed"] == 2
    # Silently dropping the rest would read as "we reviewed everything".
    assert len(out["coverage"]["unreviewed"]) == 3
    assert out["complete"] is False


def test_deterministic_only_reports_no_tier_rather_than_blaming_the_language(tmp_path):
    # "window" would render as "no call graph for this language" on a Python repo, which is
    # false: the graph was never asked for. A wrong reason is worse than no reason.
    out = review_diff(root=_repo(tmp_path), files=FILES, intent="", model=FakeModel(), checkers=())
    assert out["coverage"]["tier"] == "none"


def test_language_without_a_graph_reports_window(tmp_path):
    (tmp_path / "main.go").write_text("package main\n\nfunc main() {}\n")
    files = [
        {
            "path": "main.go",
            "status": "modified",
            "reviewable": True,
            "patch": "@@ -1,2 +1,3 @@\n package main\n+var x = 1\n",
        }
    ]
    out = review_diff(root=tmp_path, files=files, intent="", model=FakeModel())
    # build() returns an empty graph for a Go repo rather than failing, so "graph is not None"
    # is not evidence that any graph context existed.
    assert out["coverage"]["tier"] == "window"


def test_python_with_graph_context_reports_graph(tmp_path):
    # This patch touches line 5, inside f()'s body — FILES above only touches the imports,
    # so it yields no changed symbol and correctly reports "window".
    inside = [
        {
            "path": "a.py",
            "status": "modified",
            "reviewable": True,
            "patch": (
                "@@ -4,2 +4,2 @@\n def f():\n"
                '-    return os.getcwd()\n+    return os.getcwd() or "/"\n'
            ),
        }
    ]
    out = review_diff(root=_repo(tmp_path), files=inside, intent="", model=FakeModel())
    assert out["coverage"]["tier"] == "graph"


def test_diff_touching_only_imports_is_not_claimed_as_graph_grounded(tmp_path):
    # No changed function means no graph context, and the review must not imply otherwise.
    out = review_diff(root=_repo(tmp_path), files=FILES, intent="", model=FakeModel())
    assert out["coverage"]["tier"] == "window"


def test_findings_are_gated_to_the_diff(tmp_path):
    # The model points at line 999, which this diff never touches.
    model = FakeModel(
        '{"findings": [{"line": 999, "severity": "high", "title": "t", "body": "b"}]}'
    )
    out = review_diff(root=_repo(tmp_path), files=FILES, intent="", model=model)
    assert out["findings"] == []


def test_ruff_failure_degrades_the_review_instead_of_looking_clean(tmp_path, monkeypatch):
    # run_ruff now raises when it cannot run, so the stage runner must catch it and name the
    # gap. A review that quietly lost its deterministic layer must not report itself complete.
    import shipwright.review.deterministic as det

    monkeypatch.setattr(det, "_ruff_cmd", lambda: ["definitely-not-a-real-binary"])
    out = review_diff(root=_repo(tmp_path), files=FILES, intent="", model=FakeModel())
    assert "deterministic" in out["coverage"]["degraded"]
    assert out["complete"] is False


def test_surviving_findings_carry_their_hunk(tmp_path):
    model = FakeModel('{"findings": [{"line": 2, "severity": "high", "title": "t", "body": "b"}]}')
    out = review_diff(root=_repo(tmp_path), files=FILES, intent="", model=model)
    assert out["findings"], "expected the line-2 finding to survive the gate"
    assert "import subprocess" in out["findings"][0]["hunk"]


def test_progress_is_notified_per_chunk(tmp_path):
    events = []
    files = [
        {
            "path": f"f{i}.py",
            "status": "modified",
            "reviewable": True,
            "patch": f"@@ -1,1 +1,2 @@\n x\n+y{i}",
        }
        for i in range(3)
    ]
    for f in files:
        (tmp_path / f["path"]).write_text("x = 1\n")
    review_diff(
        root=tmp_path,
        files=files,
        intent="",
        model=FakeModel(),
        notify=lambda t, p: events.append((t, p)),
    )
    progress = [p for t, p in events if t == "review.progress"]
    assert progress == [
        {"done": 1, "total": 3},
        {"done": 2, "total": 3},
        {"done": 3, "total": 3},
    ]


def test_progress_is_not_emitted_without_a_notify(tmp_path):
    # notify=None is the eval harness's path; it must not crash or cost anything.
    (tmp_path / "a.py").write_text("x = 1\n")
    out = review_diff(
        root=tmp_path,
        files=[
            {
                "path": "a.py",
                "status": "modified",
                "reviewable": True,
                "patch": "@@ -1,1 +1,2 @@\n x\n+y",
            }
        ],
        intent="",
        model=FakeModel(),
    )
    assert isinstance(out["findings"], list)
