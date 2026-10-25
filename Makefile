.PHONY: install up down migrate seed reset check dev
install:
	pnpm install --frozen-lockfile
	pnpm db:generate
up:
	docker compose up --build
down:
	docker compose down
migrate:
	pnpm db:migrate
seed:
	pnpm db:seed
reset:
	pnpm db:reset
check:
	pnpm check
dev:
	pnpm dev
