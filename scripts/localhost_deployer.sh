#!/bin/bash

set -e
export $(grep -v '^#' .env | xargs)

pnpm hardhat run scripts/fund-local-accounts.ts --network localhost
pnpm hardhat run scripts/deploy-underlying-asset.ts --network localhost
pnpm hardhat run scripts/mint-underlying-asset-to-lp.ts --network localhost
pnpm hardhat run scripts/deploy-investment-universe.ts --network localhost
pnpm hardhat run scripts/deploy-config.ts --network localhost
pnpm hardhat run scripts/deploy-internal-states-orchestrator.ts --network localhost
# pnpm hardhat run scripts/deploy-liquidity-orchestrator.ts --network localhost
# pnpm hardhat run scripts/deploy-oracle.ts --network localhost
# pnpm hardhat run scripts/deploy-orion-vault-factory.ts --network localhost
# pnpm hardhat run scripts/populate-config.ts --network localhost
