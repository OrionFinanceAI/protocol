.PHONY: ci
ci:
	pnpm slither
	pnpm lint
	pnpm test
	pnpm typechain