.PHONY: ci
ci:
	pnpm lint
	pnpm test
	pnpm slither
	pnpm typechain