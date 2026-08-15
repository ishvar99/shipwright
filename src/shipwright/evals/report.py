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

        # Only claim zero inference when genuinely no model ran — dense modes invoke the
        # embedder even with no LLM calls (F10).
        calls = sum(r.tool_calls for r in attempted)
        embed = (run.config or {}).get("embed_model")
        if run.model == "none" or not calls:
            if embed:
                console.print(f"retrieval + {embed} embeddings · local, no API cost\n")
            else:
                console.print("retrieval only — no model invoked, zero cost\n")
        else:
            tin = sum(r.input_tokens for r in attempted)
            tout = sum(r.output_tokens for r in attempted)
            console.print(
                f"{run.model} · {calls} calls · {tin:,} in / {tout:,} out tokens "
                f"· local inference, no API cost\n"
            )


def _pct(metrics: list[dict], n: int, key: str) -> str:
    return f"{100 * sum(1 for x in metrics if x.get(key)) / n:.1f}%"


def compare_loc_runs(limit: int = 12) -> None:
    """Ablation table straight from recorded rows — no log scraping, no hand-typed cells."""
    with session() as s:
        runs = s.scalars(
            select(Run).where(Run.suite == "locbench").order_by(Run.started_at.desc()).limit(limit)
        ).all()
        if not runs:
            console.print("[yellow]no locbench runs recorded[/]")
            return

        t = Table("run", "mode", "model", "n", "file@5", "func@10", "any-hit", "calls", "tok in")
        for run in sorted(runs, key=lambda r: r.started_at):
            rows = s.scalars(select(TaskResult).where(TaskResult.run_id == run.id)).all()
            att = [r for r in rows if r.status != SKIPPED]
            if not att:
                continue
            m = [r.metrics or {} for r in att]
            n = len(att)
            calls = sum(r.tool_calls for r in att)
            t.add_row(
                str(run.id)[:8],
                run.scaffold.removeprefix("retrieval_"),
                "—" if run.model == "none" else run.model.removesuffix(":latest"),
                str(n) + (f" (+{len(rows) - n} skip)" if len(rows) != n else ""),
                _pct(m, n, "file_acc_at_5"),
                _pct(m, n, "func_acc_at_10"),
                _pct(m, n, "any_hit"),
                str(calls) if calls else "—",
                f"{sum(r.input_tokens for r in att):,}" if calls else "—",
            )
        console.print(t)
        console.print(
            "[dim]Acc@k is strict: every ground-truth location inside top k. "
            "any-hit is diagnostic only.[/]"
        )


def _rate(rows: list[TaskResult], key: str) -> str:
    """Percentage over the rows that actually carry the key, or an em dash.

    Deliberately not `_pct` above: that one divides by the caller's `n`, which for a metric
    no row recorded would render a measured-looking 0.0%. A number nobody computed is
    exactly what this module refuses to print.
    """
    seen = [r for r in rows if key in (r.metrics or {})]
    if not seen:
        return "—"
    return f"{100 * sum(1 for r in seen if (r.metrics or {})[key]) / len(seen):.1f}%"


def show_review_run(run_id: str) -> None:
    """One reviewbench run."""
    with session() as s:
        run = s.scalars(select(Run).where(cast(Run.id, String).like(f"{run_id}%"))).first()
        if run is None:
            console.print(f"[red]no run matching[/] {run_id}")
            return
        rows = s.scalars(select(TaskResult).where(TaskResult.run_id == run.id)).all()

    att = [r for r in rows if r.status != SKIPPED]
    console.print(f"\n[bold]{run.suite}[/] {run.scaffold} · {run.model} · split={run.split}")
    if run.split == "forward":
        console.print(
            "[yellow]noise control: the diff under review is the fix the maintainers merged, "
            "so every finding here is a false positive candidate.[/]"
        )
    # The attempted denominator is printed on every suite: a shrinking denominator must
    # never be able to inflate a rate (ADR-0003).
    console.print(f"attempted {len(att)}/{len(rows)} ({len(rows) - len(att)} skipped)")
    if not att:
        return

    table = Table(show_header=True, header_style="bold")
    table.add_column("metric")
    table.add_column("value", justify="right")

    # On the forward split the diff under review IS the merged fix, so "landed inside the
    # ground-truth function" is not a detection — it is a false positive on code the
    # maintainers accepted. Printing it under a detect@ heading invites reading a noise
    # measurement as a success.
    noise_split = run.split == "forward"
    for key, label in (
        ("detected_func", "flagged the fixed function" if noise_split else "detect@func"),
        ("detected_file", "flagged the fixed file" if noise_split else "detect@file"),
        ("top1", "top finding was there" if noise_split else "precision@1"),
    ):
        table.add_row(label, _rate(att, key))

    per100 = [r.metrics["findings_per_100"] for r in att if "findings_per_100" in (r.metrics or {})]
    table.add_row("findings / 100 lines", f"{sum(per100) / len(per100):.2f}" if per100 else "—")
    table.add_row("findings total", str(sum((r.metrics or {}).get("n_findings", 0) for r in att)))
    table.add_row("runs degraded", str(sum(1 for r in att if (r.metrics or {}).get("degraded"))))
    table.add_row(
        "parse failures", str(sum((r.metrics or {}).get("parse_failures", 0) for r in att))
    )
    console.print(table)
    console.print(
        f"[dim]tokens in {sum(r.input_tokens for r in att):,} · "
        f"out {sum(r.output_tokens for r in att):,} · "
        f"calls {sum(r.tool_calls for r in att)} · commit {run.git_commit}[/]"
    )
