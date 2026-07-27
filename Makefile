.PHONY: bootstrap up down doctor db-init fmt logs nuke

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

doctor:
	uv run sw doctor

db-init:
	uv run sw db-init

fmt:
	uv run ruff check --fix src
	uv run ruff format src

logs:
	docker compose logs -f --tail=50

# Removes the database volume too.
nuke:
	docker compose down -v
