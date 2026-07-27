"""Null-hypothesis baseline: mini-swe-agent (bash-only ReAct, ~100 lines) against the
local model. Every Shipwright scaffold gets compared to this. It exists so later
numbers mean something.

Generation only. Resolution is unevaluated here and recorded conservatively as not
resolved, never as unknown-and-therefore-fine.
"""

import json
import subprocess
import time
from pathlib import Path
from typing import Any

from ..config import settings
from ..db import session
from ..models import ERROR, FAILED, SKIPPED, ModelCall, Run, TaskResult
from .dataset import Task

PREDICTIONS = Path("evals/swebench_live/artifacts")


def _git_commit() -> str:
    r = subprocess.run(["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else ""


def _image_present(image: str, pull_timeout: int = 900) -> bool:
    if subprocess.run(["docker", "image", "inspect", image], capture_output=True).returncode == 0:
        return True
    pull = subprocess.run(
        ["docker", "pull", "--platform", "linux/amd64", image],
        capture_output=True,
        text=True,
        timeout=pull_timeout,
    )
    return pull.returncode == 0


class _Usage:
    """mini-swe-agent 2.4.6 exposes no token counters, so we tap litellm directly.
    Tokens are the evidence spine; they don't get to be approximate."""

    def __init__(self) -> None:
        self.calls = self.input = self.output = 0

    def hook(self, kwargs: Any, response: Any, start: Any, end: Any) -> None:
        usage = getattr(response, "usage", None)
        self.calls += 1
        if usage:
            self.input += getattr(usage, "prompt_tokens", 0) or 0
            self.output += getattr(usage, "completion_tokens", 0) or 0

    def install(self) -> None:
        import litellm

        litellm.success_callback = [self.hook]


def _bench_config() -> dict:
    """mini-swe-agent ships the SWE-bench prompt templates as YAML. The backticks
    variant uses text-based actions instead of the tool-calling API, which small local
    models handle far more reliably."""
    import minisweagent
    import yaml

    path = Path(minisweagent.__file__).parent / "config/benchmarks/swebench_backticks.yaml"
    return yaml.safe_load(path.read_text())


def _extract_patch(env: Any) -> str:
    """Stage everything so new files land in the diff, then read it back."""
    try:
        env.execute("git add -A")
        out = env.execute("git diff --cached")
        return out.get("output", "") if isinstance(out, dict) else str(out)
    except Exception:
        return ""


def run_baseline(
    tasks: list[Task],
    *,
    model_name: str | None = None,
    step_limit: int = 15,
    wall_limit: int = 1800,
    command_timeout: int = 120,
    max_output_tokens: int = 1024,
    notes: str = "",
) -> str:
    from minisweagent.agents.default import DefaultAgent
    from minisweagent.environments.docker import DockerEnvironment
    from minisweagent.models.litellm_textbased_model import LitellmTextbasedModel

    model_id = model_name or settings.local_model
    litellm_name = f"ollama/{model_id}"
    PREDICTIONS.mkdir(parents=True, exist_ok=True)

    cfg = _bench_config()
    agent_cfg = dict(cfg.get("agent", {}))
    model_cfg = {
        k: v
        for k, v in cfg.get("model", {}).items()
        if k not in ("model_name", "model_kwargs", "model_class")
    }
    env_cfg = {k: v for k, v in cfg.get("environment", {}).items() if k != "environment_class"}

    with session() as s:
        run = Run(
            suite="swebench_live",
            split="lite",
            scaffold="s2_minimal",
            model=model_id,
            model_tier="local",
            git_commit=_git_commit(),
            notes=notes,
            config={
                "agent": "mini-swe-agent",
                "step_limit": step_limit,
                "wall_limit": wall_limit,
                "command_timeout": command_timeout,
                "max_output_tokens": max_output_tokens,
                "platform": "linux/amd64 (emulated on arm64)",
                "instance_ids": [t.instance_id for t in tasks],
            },
        )
        s.add(run)
        s.flush()
        run_id = run.id

    preds = (PREDICTIONS / f"predictions-{run_id}.jsonl").open("w")

    for i, task in enumerate(tasks, 1):
        print(f"[{i}/{len(tasks)}] {task.instance_id}", flush=True)
        started = time.perf_counter()
        result = TaskResult(run_id=run_id, task_id=task.instance_id, status=FAILED)
        env = None

        usage = _Usage()
        usage.install()

        try:
            if not _image_present(task.image):
                result.status = SKIPPED
                result.skip_reason = "image_unavailable"
                raise RuntimeError("image unavailable")

            model = LitellmTextbasedModel(
                model_name=litellm_name,
                model_kwargs={
                    "api_base": settings.ollama_base_url,
                    "temperature": 0.0,
                    "drop_params": True,
                    # Uncapped, the 7B rambles ~2k tokens per step (~100s at 21 tok/s),
                    # which makes a 25-step run unaffordable. See FAILURES.md F6.
                    "max_tokens": max_output_tokens,
                },
                cost_tracking="ignore_errors",  # litellm has no pricing for local models
                **model_cfg,
            )
            env = DockerEnvironment(
                image=task.image,
                run_args=["--platform", "linux/amd64"],
                **{**env_cfg, "timeout": command_timeout},
            )
            agent = DefaultAgent(
                model,
                env,
                **{
                    **agent_cfg,
                    "step_limit": step_limit,
                    "wall_time_limit_seconds": wall_limit,
                    "cost_limit": 1.0,
                },
            )

            exit_status = "unknown"
            try:
                out = agent.run(task.problem_statement)
                exit_status = (
                    str(out.get("exit_status", "submitted"))
                    if isinstance(out, dict)
                    else "submitted"
                )
            except Exception as e:  # step/wall limits surface as exceptions
                exit_status = type(e).__name__

            patch = _extract_patch(env)

            result.steps = usage.calls
            result.patch_lines = patch.count("\n") if patch else 0
            result.input_tokens = usage.input
            result.output_tokens = usage.output
            result.tool_calls = usage.calls
            result.metrics = {
                "exit_status": exit_status,
                "patch_generated": bool(patch.strip()),
                "evaluated": False,
                "messages": len(getattr(agent, "messages", [])),
            }
            # Trajectories are the raw evidence behind every failure claim.
            traj = PREDICTIONS / f"traj-{str(run_id)[:8]}-{task.instance_id}.json"
            traj.write_text(
                json.dumps(
                    {
                        "instance_id": task.instance_id,
                        "exit_status": exit_status,
                        "messages": getattr(agent, "messages", []),
                    },
                    indent=1,
                    default=str,
                )
            )
            preds.write(
                json.dumps(
                    {
                        "instance_id": task.instance_id,
                        "model_name_or_path": f"shipwright-s2-{model_id}",
                        "model_patch": patch,
                    }
                )
                + "\n"
            )
            preds.flush()
            print(f"    {exit_status} · patch {result.patch_lines} lines", flush=True)

        except Exception as e:
            if result.status != SKIPPED:
                result.status = ERROR
                result.error = f"{type(e).__name__}: {e}"[:1000]
            print(f"    {result.status}: {result.skip_reason or result.error}", flush=True)
        finally:
            if env is not None:
                try:
                    env.cleanup()
                except Exception:
                    pass

        result.wall_ms = int((time.perf_counter() - started) * 1000)
        with session() as s:
            s.add(result)
            s.flush()
            if result.input_tokens or result.output_tokens:
                s.add(
                    ModelCall(
                        run_id=run_id,
                        task_result_id=result.id,
                        model=model_id,
                        input_tokens=result.input_tokens,
                        output_tokens=result.output_tokens,
                        latency_ms=result.wall_ms,
                    )
                )

    preds.close()
    with session() as s:
        from datetime import UTC, datetime

        r = s.get(Run, run_id)
        r.finished_at = datetime.now(UTC)

    return str(run_id)
