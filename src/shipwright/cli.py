import time

import typer
from rich.console import Console
from rich.table import Table

from .config import settings

app = typer.Typer(
    help="Shipwright: benchmarked AI software-engineering platform", no_args_is_help=True
)
console = Console()


@app.command()
def doctor() -> None:
    """Verify every dependency the local (free) tier needs."""
    table = Table("component", "status", "detail")
    ok = True

    # Postgres
    try:
        from sqlalchemy import text

        from .db import engine

        with engine.connect() as c:
            version = c.execute(text("show server_version")).scalar()
        table.add_row(
            "postgres", "[green]ok[/]", f"v{version} @ {settings.database_url.split('@')[-1]}"
        )
    except Exception as e:
        ok = False
        table.add_row("postgres", "[red]fail[/]", str(e)[:90])

    # Redis
    try:
        import socket
        from urllib.parse import urlparse

        u = urlparse(settings.redis_url)
        with socket.create_connection((u.hostname, u.port or 6379), timeout=3) as s:
            s.sendall(b"PING\r\n")
            reply = s.recv(32)
        table.add_row(
            "redis", "[green]ok[/]" if b"PONG" in reply else "[red]fail[/]", settings.redis_url
        )
    except Exception as e:
        ok = False
        table.add_row("redis", "[red]fail[/]", str(e)[:90])

    # Docker daemon
    try:
        import subprocess

        v = subprocess.run(
            ["docker", "info", "--format", "{{.ServerVersion}}"],
            capture_output=True,
            text=True,
            timeout=20,
        )
        if v.returncode == 0 and v.stdout.strip():
            table.add_row("docker", "[green]ok[/]", f"daemon {v.stdout.strip()}")
        else:
            ok = False
            table.add_row("docker", "[red]fail[/]", (v.stderr or "daemon unreachable").strip()[:90])
    except Exception as e:
        ok = False
        table.add_row("docker", "[red]fail[/]", str(e)[:90])

    # Ollama + a real generation, so "ok" means it can actually infer
    try:
        from .gateway.ollama import OllamaProvider

        p = OllamaProvider()
        available = {m.removesuffix(":latest") for m in p.list_models()}

        # Both roles are checked: agent loops need the 16k build, localization the small
        # one. Checking only one lets a half-built setup look healthy.
        for role, name in (("agent", settings.local_model), ("localize", settings.loc_model)):
            if name.removesuffix(":latest") not in available:
                ok = False
                table.add_row(f"ollama/{role}", "[yellow]missing[/]", f"make models  ({name})")
                continue
            started = time.perf_counter()
            r = OllamaProvider(model=name).generate(
                [{"role": "user", "content": "Reply with the single word: ready"}], max_tokens=8
            )
            elapsed = int((time.perf_counter() - started) * 1000)
            table.add_row(
                f"ollama/{role}", "[green]ok[/]", f"{name} · {elapsed}ms · ttft {r.ttft_ms}ms"
            )

        if settings.embed_model.removesuffix(":latest") not in available:
            table.add_row(
                "ollama/embed", "[yellow]missing[/]", f"ollama pull {settings.embed_model}"
            )
    except Exception as e:
        ok = False
        table.add_row("ollama", "[red]fail[/]", str(e)[:90])

    console.print(table)

    # 16GB is the binding constraint on this machine; surface it every time.
    try:
        import subprocess

        swap = subprocess.run(
            ["sysctl", "-n", "vm.swapusage"], capture_output=True, text=True, timeout=5
        ).stdout.strip()
        console.print(f"[dim]swap: {swap}[/]")
    except Exception:
        pass

    if not ok:
        raise typer.Exit(1)


@app.command("db-init")
def db_init() -> None:
    """Create tables (create_all; no migrations yet)."""
    from .db import init_schema

    init_schema()
    console.print("[green]schema created[/]")


bench = typer.Typer(help="Benchmarks", no_args_is_help=True)
app.add_typer(bench, name="bench")


@bench.command("fetch")
def bench_fetch(split: str = "lite") -> None:
    """Download and cache a SWE-bench-Live split."""
    from .evals.dataset import fetch

    tasks = fetch(split)
    console.print(f"[green]{len(tasks)} tasks[/] cached for split '{split}'")
    console.print(f"example image: {tasks[0].image}")


@bench.command("baseline")
def bench_baseline(
    n: int = typer.Option(2, help="how many tasks"),
    split: str = "lite",
    order: str = typer.Option("shuffle", help="shuffle (seeded, default) | easiest"),
    steps: int = typer.Option(15, help="agent step limit"),
    max_out: int = typer.Option(1024, help="cap output tokens per step"),
    model: str = typer.Option("", help="ollama model; defaults to LOCAL_MODEL"),
    notes: str = "",
) -> None:
    """Run the mini-swe-agent null hypothesis. Task images are amd64 (emulated here)."""
    from .evals.baseline import run_baseline
    from .evals.dataset import fetch, subset
    from .evals.report import show_run

    tasks = subset(fetch(split), n, order=order)
    console.print(f"running {len(tasks)} task(s) · scaffold s2_minimal · steps<={steps}")
    run_id = run_baseline(
        tasks,
        model_name=model or None,
        step_limit=steps,
        max_output_tokens=max_out,
        notes=notes,
    )
    show_run(run_id[:8])


@bench.command("runs")
def bench_runs(limit: int = 20) -> None:
    """List recorded runs."""
    from .evals.report import list_runs

    list_runs(limit)


@bench.command("show")
def bench_show(run_id: str) -> None:
    """Show one run's results (accepts an id prefix)."""
    from .evals.report import show_run

    show_run(run_id)


if __name__ == "__main__":
    app()


loc = typer.Typer(help="Localization benchmark (Loc-Bench)", no_args_is_help=True)
app.add_typer(loc, name="loc")


@loc.command("fetch")
def loc_fetch() -> None:
    """Download and cache Loc-Bench."""
    from .evals.locbench import fetch

    tasks = fetch()
    cats: dict[str, int] = {}
    for t in tasks:
        cats[t.category] = cats.get(t.category, 0) + 1
    console.print(f"[green]{len(tasks)} tasks[/] with function-level ground truth")
    for c, n in sorted(cats.items(), key=lambda kv: -kv[1]):
        console.print(f"  {c or 'uncategorised'}: {n}")


@loc.command("run")
def loc_run(
    n: int = typer.Option(10, help="how many tasks"),
    mode: str = typer.Option(
        "hybrid",
        help="bm25|graph|dense|path|hybrid|hybrid3|hybrid_path|hybrid4|extract|rerank|extract_rerank",
    ),
    top_k: int = typer.Option(10, help="candidates returned"),
    model: str = typer.Option("", help="ollama model; defaults to LOC_MODEL"),
    base: str = typer.Option("hybrid", help="retrieval channels under an assisted mode"),
    notes: str = "",
) -> None:
    """Score localization. Retrieval modes cost nothing; assisted modes use LOC_MODEL."""
    from .evals.locbench import fetch, run_locbench
    from .evals.report import show_loc_run

    tasks = fetch(limit=n)
    console.print(f"localizing {len(tasks)} task(s) · mode={mode} · top_k={top_k}")
    run_id = run_locbench(tasks, mode=mode, top_k=top_k, model_name=model or None, notes=notes)
    show_loc_run(run_id[:8])


@loc.command("ablate")
def loc_ablate(
    n: int = typer.Option(10, help="tasks per mode"), top_k: int = typer.Option(10)
) -> None:
    """Run every retrieval mode over the same tasks and print the comparison."""
    from .evals.locbench import fetch, run_locbench
    from .evals.report import show_loc_run

    tasks = fetch(limit=n)
    modes = ("bm25", "graph", "hybrid", "extract", "rerank", "extract_rerank")
    for mode in modes:
        console.print(f"\n[bold]mode={mode}[/]")
        run_id = run_locbench(tasks, mode=mode, top_k=top_k, notes=f"ablation {mode}")
        show_loc_run(run_id[:8])


@loc.command("show")
def loc_show(run_id: str) -> None:
    """Show one localization run (accepts an id prefix)."""
    from .evals.report import show_loc_run

    show_loc_run(run_id)


@loc.command("compare")
def loc_compare(limit: int = 12) -> None:
    """Ablation table across recorded localization runs."""
    from .evals.report import compare_loc_runs

    compare_loc_runs(limit)
