#!/bin/bash

# Exit if any command fails
set -e

# Load environment variables from .env if needed
export $(grep -v '^#' .env | xargs)

pnpm hardhat run scripts/fund-local-accounts.ts --network localhost
pnpm hardhat run scripts/deploy-underlying-asset.ts --network localhost
pnpm hardhat run scripts/mint-underlying-asset-to-lp.ts --network localhost
pnpm hardhat run scripts/deploy-investment-universe.ts --network localhost
pnpm hardhat run scripts/deploy-config.ts --network localhost
pnpm hardhat run scripts/add-to-config-whitelist.ts --network localhost
# TODO: the following needs Orchestrators contracts to be deployed first:
# pnpm hardhat run scripts/deploy-orion-vault-factory.ts --network localhost
# TODO: deployer to call createVault() from factory
# pnpm hardhat run scripts/deposit-to-vault.ts --network localhost