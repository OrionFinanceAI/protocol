.PHONY: install
install:
	uv venv --python 3.12
	source .venv/bin/activate && uv pip install slither-analyzer==0.11.5
	pnpm install --frozen-lockfile

.PHONY: ci
ci:
	pnpm audit --prod --audit-level high
	pnpm build
	pnpm lint
	pnpm slither
	pnpm test

.PHONY: docs
docs:
	./scripts/build-dev-docs.sh