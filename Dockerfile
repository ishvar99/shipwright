# Backend image for the hosted free tier (Render). Bakes small demo workspaces so a
# recruiter's first click never waits on a clone + index at 0.1 CPU.
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 # apply/fix commit onto visitor-imported trees; a bare container has no identity.
 && git config --system user.email fix@shipwright.local \
 && git config --system user.name Shipwright

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# WORKDIR is load-bearing: WORKSPACES and every stored repo path are cwd-relative.
WORKDIR /app

# Deps first — 500 free build-minutes/month make layer caching a real budget.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY src ./src
COPY scripts ./scripts
RUN uv sync --frozen --no-dev

# Bake demo workspaces + manifest at BUILD time (fast machine), not boot (0.1 CPU).
RUN uv run --no-sync python scripts/bake_demos.py

ENV PYTHONUNBUFFERED=1
# Render injects PORT. Single process: 512 MB and the SQLAlchemy pool sizing assume it.
CMD ["sh", "-c", "uv run --no-sync uvicorn shipwright.api.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
