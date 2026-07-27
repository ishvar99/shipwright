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
        models = p.list_models()
        if settings.local_model not in models:
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


if __name__ == "__main__":
    app()
