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
        models = {m.removesuffix(":latest") for m in p.list_models()}
        if settings.local_model.removesuffix(":latest") not in models:
            ok = False
            table.add_row("ollama", "[yellow]missing model[/]", f"pull {settings.local_model}")
        else:
            started = time.perf_counter()
            r = p.generate(
                [{"role": "user", "content": "Reply with the single word: ready"}], max_tokens=8
            )
            elapsed = int((time.perf_counter() - started) * 1000)
            table.add_row(
                "ollama",
                "[green]ok[/]",
                f"{p.model} · {elapsed}ms · ttft {r.ttft_ms}ms · {r.output_tokens} out-tok",
            )
    except Exception as e:
        ok = False
        table.add_row("ollama", "[red]fail[/]", str(e)[:90])

    console.print(table)
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
