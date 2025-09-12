.PHONY: ci
ci:
	pnpm slither
	pnpm lint
	pnpm coverage
	pnpm typechain