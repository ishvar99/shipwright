"""LoRA fine-tuning via mlx_lm, sized for 16 GB.

A 1.5B base is deliberate: ADR-0005 measured that a 7B leaves no headroom on this machine,
and training needs room for activations and optimizer state on top of weights. The point of
this experiment is a measured before/after on a held-out split, not the largest model that
technically loads.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

BASE_MODEL = "mlx-community/Qwen2.5-Coder-1.5B-Instruct-4bit"
DATA = Path("evals/finetune")
ADAPTERS = Path("evals/finetune/adapters")


def _free_ollama() -> None:
    """Ollama holds ~5 GB after a run; training needs it back."""
    try:
        import httpx

        r = httpx.get("http://localhost:11434/api/ps", timeout=5)
        for m in r.json().get("models", []):
            subprocess.run(["ollama", "stop", m["name"]], capture_output=True, timeout=60)
            print(f"  unloaded {m['name']}", flush=True)
    except Exception as e:
        print(f"  (could not query ollama: {e})", flush=True)


def train(
    *,
    model: str = BASE_MODEL,
    iters: int = 400,
    num_layers: int = 8,
    batch_size: int = 1,
    max_seq_length: int = 4096,
    learning_rate: float = 1e-5,
    free_memory: bool = True,
) -> dict:
    train_file = DATA / "train.jsonl"
    if not train_file.exists():
        raise SystemExit("no training data — run `sw ft data` first")
    n_train = sum(1 for _ in train_file.open())

    if free_memory:
        _free_ollama()

    ADAPTERS.mkdir(parents=True, exist_ok=True)
    cmd = [
        sys.executable,
        "-m",
        "mlx_lm",
        "lora",
        "--model",
        model,
        "--train",
        "--data",
        str(DATA),
        "--fine-tune-type",
        "lora",
        "--num-layers",
        str(num_layers),
        "--batch-size",
        str(batch_size),
        "--iters",
        str(iters),
        "--max-seq-length",
        str(max_seq_length),
        "--learning-rate",
        str(learning_rate),
        "--adapter-path",
        str(ADAPTERS),
        "--steps-per-eval",
        "100",
        "--grad-checkpoint",
    ]
    print(f"  {n_train} training examples · {model}", flush=True)
    print("  " + " ".join(cmd[2:]), flush=True)

    proc = subprocess.run(cmd, text=True, capture_output=True, timeout=60 * 180)
    out = (proc.stdout or "") + (proc.stderr or "")
    print(out[-4000:], flush=True)

    losses = [line for line in out.splitlines() if "Iter" in line and ("loss" in line.lower())]
    meta = {
        "returncode": proc.returncode,
        "n_train": n_train,
        "model": model,
        "iters": iters,
        "num_layers": num_layers,
        "max_seq_length": max_seq_length,
        "learning_rate": learning_rate,
        "first_loss": losses[0] if losses else None,
        "last_loss": losses[-1] if losses else None,
    }
    (ADAPTERS / "shipwright_run.json").write_text(json.dumps(meta, indent=1))
    return meta
