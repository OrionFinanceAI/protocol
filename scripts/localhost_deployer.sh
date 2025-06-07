#!/bin/bash

set -e
export $(grep -v '^#' .env | xargs)

# Generate FHE key pair and upload public key to IPFS.
# cd python-sdk && sdk keygen && sdk upload context.public.tenseal && cd ..

pnpm hardhat run scripts/fund-local-accounts.ts --network localhost
pnpm hardhat run scripts/deploy-underlying-asset.ts --network localhost
pnpm hardhat run scripts/mint-underlying-asset-to-lp.ts --network localhost
pnpm hardhat run scripts/deploy-investment-universe.ts --network localhost
pnpm hardhat run scripts/deploy-config.ts --network localhost
pnpm hardhat run scripts/deploy-internal-states-orchestrator.ts --network localhost
pnpm hardhat run scripts/deploy-liquidity-orchestrator.ts --network localhost
pnpm hardhat run scripts/deploy-oracle.ts --network localhost
pnpm hardhat run scripts/deploy-orion-vault-factory.ts --network localhost
pnpm hardhat run scripts/populate-config.ts --network localhost
pnpm hardhat run scripts/deploy-orion-vault.ts --network localhost
# cd python-sdk && sdk download && cd ..
cd python-sdk && sdk order-intent && cd ..
pnpm hardhat run scripts/request-vault-deposit.ts --network localhost

# ...
# pnpm hardhat run scripts/request-vault-withdrawal.ts --network localhost