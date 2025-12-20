.PHONY: install
install:
	uv venv --python 3.12
	source .venv/bin/activate && uv pip install slither-analyzer==0.11.3
	pnpm install

.PHONY: ci
ci:
	pnpm audit --prod --audit-level high
	pnpm typechain
	pnpm lint
	pnpm slither
	pnpm test