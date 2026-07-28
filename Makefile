.PHONY: bootstrap up down doctor db-init model models mem vm-light vm-agent preflight fmt logs nuke

bootstrap:
	uv sync
	cp -n .env.example .env || true
	@echo "next: make up && make db-init && make doctor"

up:
	docker compose up -d
	@echo "waiting for healthchecks..."
	@until [ "$$(docker inspect -f '{{.State.Health.Status}}' shipwright-postgres-1 2>/dev/null)" = "healthy" ]; do sleep 1; done
	@docker compose ps

down:
	docker compose down

# Stock qwen2.5-coder:7b loads at a 4096 window; agent runs need 16384 (FAILURES.md F5).
# The 3b build only reproduces the size-vs-quality ablation row; it is not the default.
models:
	ollama create qwen2.5-coder-7b-16k -f infra/ollama/qwen2.5-coder-7b-16k.Modelfile
	ollama create qwen2.5-coder-3b-loc -f infra/ollama/qwen2.5-coder-3b-loc.Modelfile

model: models

doctor:
	uv run sw doctor

db-init:
	uv run sw db-init

# Resident models and swap pressure — the 16GB budget is the real constraint.
mem:
	@curl -s http://localhost:11434/api/ps | python3 -c "import json,sys; [print(f\"  {m['name']:30} {m.get('size_vram',0)//10**6:5d} MB  ctx={m.get('context_length')}\") for m in json.load(sys.stdin).get('models',[])] or print('  no models resident')"
	@sysctl vm.swapusage | sed 's/vm.swapusage: /  swap: /'

# Localization uses no containers, so the VM only needs to host postgres+redis (~300MB).
vm-light:
	colima stop && colima start --cpu 4 --memory 1 --disk 60
	docker compose up -d

# SWE-bench agent runs execute emulated amd64 containers and need real headroom.
vm-agent:
	colima stop && colima start --cpu 4 --memory 3 --disk 60
	docker compose up -d

# Check there's room before starting a long run. 16GB is the binding constraint.
preflight:
	@echo "memory hogs (close these for long runs):"
	@ps -eo rss,comm | awk '{a[$$2]+=$$1} END {for (k in a) if (a[k]>300000) printf "  %5d MB  %s\n", a[k]/1024, k}' | sort -rn | head -5
	@sysctl vm.swapusage | sed 's/vm.swapusage: /  swap: /'
	@echo "  (localization needs ~5.4GB: model 5.0 + worker 0.4)"

fmt:
	uv run ruff check --fix src
	uv run ruff format src

logs:
	docker compose logs -f --tail=50

# Removes the database volume too.
nuke:
	docker compose down -v
