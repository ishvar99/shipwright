"""Renders results from recorded rows only. Nothing here computes a number that isn't
already in the database."""

from rich.console import Console
from rich.table import Table
from sqlalchemy import String, cast, select

from ..db import session
from ..models import RESOLVED, SKIPPED, Run, TaskResult

console = Console()


def _fmt_ms(ms: int) -> str:
    return f"{ms / 1000:.0f}s" if ms < 90_000 else f"{ms / 60000:.1f}m"


def list_runs(limit: int = 20) -> None:
    with session() as s:
        runs = s.scalars(select(Run).order_by(Run.started_at.desc()).limit(limit)).all()
        if not runs:
            console.print("[yellow]no runs recorded[/]")
            return
        t = Table("run id", "suite/split", "scaffold", "model", "tier", "n", "started")
        for r in runs:
            n = len(s.scalars(select(TaskResult).where(TaskResult.run_id == r.id)).all())
            t.add_row(
                str(r.id)[:8],
                f"{r.suite}/{r.split}",
                r.scaffold,
                r.model,
                r.model_tier,
                str(n),
                r.started_at.strftime("%Y-%m-%d %H:%M"),
            )
        console.print(t)


def show_run(run_id: str) -> None:
    with session() as s:
        run = s.scalars(select(Run).where(cast(Run.id, String).like(f"{run_id}%"))).first()
        if not run:
            console.print(f"[red]no run matching {run_id}[/]")
            return
        rows = s.scalars(
            select(TaskResult).where(TaskResult.run_id == run.id).order_by(TaskResult.task_id)
        ).all()

        attempted = [r for r in rows if r.status != SKIPPED]
        resolved = [r for r in rows if r.status == RESOLVED]
        with_patch = [r for r in rows if (r.metrics or {}).get("patch_generated")]
        evaluated = [r for r in rows if (r.metrics or {}).get("evaluated")]

        console.print(
            f"\n[bold]{run.suite}/{run.split}[/] · scaffold [cyan]{run.scaffold}[/] · "
            f"model [cyan]{run.model}[/] ({run.model_tier}) · commit {run.git_commit or 'n/a'}"
        )
        console.print(f"started {run.started_at:%Y-%m-%d %H:%M} · run {run.id}\n")

        t = Table("task", "status", "patch", "steps", "tok in/out", "wall")
        for r in rows:
            t.add_row(
                r.task_id[:44],
                r.status + (f" ({r.skip_reason})" if r.skip_reason else ""),
                str(r.patch_lines) if r.patch_lines else "-",
                str(r.steps) if r.steps else "-",
                f"{r.input_tokens}/{r.output_tokens}" if r.input_tokens else "-",
                _fmt_ms(r.wall_ms),
            )
        console.print(t)

        # Denominator is stated explicitly so skips can never inflate a rate.
        console.print(
            f"\nresolved [bold]{len(resolved)}/{len(attempted)}[/] attempted "
            f"({len(rows)} selected, {len(rows) - len(attempted)} skipped)"
        )
        console.print(f"patch produced on {len(with_patch)}/{len(attempted)} attempted")
        if len(evaluated) < len(attempted):
            console.print(
                f"[yellow]{len(attempted) - len(evaluated)} of {len(attempted)} not yet "
                f"evaluated against tests — counted as unresolved[/]"
            )
        total_wall = sum(r.wall_ms for r in rows)
        console.print(f"total wall {_fmt_ms(total_wall)} · local inference, no API cost\n")


def show_loc_run(run_id: str) -> None:
    """Localization report. Acc@k is strict: all ground-truth locations within top k."""
    with session() as s:
        run = s.scalars(select(Run).where(cast(Run.id, String).like(f"{run_id}%"))).first()
        if not run:
            console.print(f"[red]no run matching {run_id}[/]")
            return
        rows = s.scalars(
            select(TaskResult).where(TaskResult.run_id == run.id).order_by(TaskResult.task_id)
        ).all()

        attempted = [r for r in rows if r.status != SKIPPED]
        m = [r.metrics or {} for r in attempted]
        file5 = sum(1 for x in m if x.get("file_acc_at_5"))
        func10 = sum(1 for x in m if x.get("func_acc_at_10"))
        anyhit = sum(1 for x in m if x.get("any_hit"))

        console.print(
            f"\n[bold]{run.suite}[/] · {run.scaffold} · commit {run.git_commit or 'n/a'} · "
            f"run {str(run.id)[:8]}"
        )
        t = Table("task", "file@5", "func@10", "any", "gt", "symbols", "wall")
        for r in rows:
            x = r.metrics or {}
            t.add_row(
                r.task_id[:36],
                "[green]Y[/]" if x.get("file_acc_at_5") else "·",
                "[green]Y[/]" if x.get("func_acc_at_10") else "·",
                "Y" if x.get("any_hit") else "·",
                str(x.get("n_gt", "-")),
                str((x.get("graph") or {}).get("symbols", "-")),
                _fmt_ms(r.wall_ms),
            )
        console.print(t)

        n = len(attempted) or 1
        console.print(
            f"\nfile-level Acc@5   [bold]{file5}/{len(attempted)}[/] ({100 * file5 / n:.1f}%)"
        )
        console.print(
            f"function Acc@10    [bold]{func10}/{len(attempted)}[/] ({100 * func10 / n:.1f}%)"
        )
        console.print(f"any-hit (diag)     {anyhit}/{len(attempted)} ({100 * anyhit / n:.1f}%)")
        if len(rows) != len(attempted):
            console.print(f"[yellow]{len(rows) - len(attempted)} skipped[/]")
        console.print("no inference — retrieval only, zero cost\n")
