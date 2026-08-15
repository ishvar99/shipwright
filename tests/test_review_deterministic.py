from shipwright.review.deterministic import RULES, run_ruff


def test_finds_a_real_security_issue(tmp_path):
    (tmp_path / "bad.py").write_text(
        "import subprocess\n\n\ndef go(cmd):\n    subprocess.run(cmd, shell=True)\n"
    )
    findings = run_ruff(tmp_path, ["bad.py"])
    assert any(x["rule"].startswith("S") for x in findings)


def test_finding_carries_path_line_and_category(tmp_path):
    (tmp_path / "bad.py").write_text(
        "def go():\n    try:\n        x = 1\n    except Exception:\n        pass\n    return x\n"
    )
    findings = run_ruff(tmp_path, ["bad.py"])
    assert findings, "expected a blind-except or try-except-pass finding"
    one = findings[0]
    assert one["path"] == "bad.py"
    assert one["line"] >= 1
    assert one["source"] == "ruff"
    assert one["category"] in {"security", "error_handling", "quality"}


def test_clean_file_yields_nothing(tmp_path):
    (tmp_path / "ok.py").write_text("def add(a, b):\n    return a + b\n")
    assert run_ruff(tmp_path, ["ok.py"]) == []


def test_missing_file_is_not_fatal(tmp_path):
    assert run_ruff(tmp_path, ["nope.py"]) == []


def test_only_requested_files_are_scanned(tmp_path):
    for name in ("a.py", "b.py"):
        (tmp_path / name).write_text(
            "import subprocess\n\n\ndef g(c):\n    subprocess.run(c, shell=True)\n"
        )
    findings = run_ruff(tmp_path, ["a.py"])
    assert {x["path"] for x in findings} == {"a.py"}


def test_repo_config_cannot_silence_us(tmp_path):
    # --isolated: a repository that disables every rule in its own pyproject must not
    # blind the reviewer. An inline noqa comment is still honoured, because that is a
    # deliberate line-level statement by the author.
    (tmp_path / "pyproject.toml").write_text("[tool.ruff.lint]\nselect = []\n")
    (tmp_path / "bad.py").write_text(
        "import subprocess\n\n\ndef g(c):\n    subprocess.run(c, shell=True)\n"
    )
    assert run_ruff(tmp_path, ["bad.py"])


def test_every_selected_rule_maps_to_a_category():
    # A rule with no category would render as an unlabelled finding in the UI.
    assert set(RULES.values()) <= {"security", "error_handling", "quality"}
    assert RULES


def test_findings_are_returned_even_though_ruff_exits_nonzero(tmp_path):
    # ruff exits 1 when findings exist; only >=2 is a real error. Treating 1 as failure
    # would silently return nothing exactly when there was something to say.
    (tmp_path / "bad.py").write_text(
        "import subprocess\n\n\ndef g(c):\n    subprocess.run(c, shell=True)\n"
    )
    assert len(run_ruff(tmp_path, ["bad.py"])) > 0
