#!/bin/bash

set -e
export $(grep -v '^#' .env | xargs)

pnpm hardhat run scripts/request-vault-deposit.ts --network localhost
pnpm hardhat run scripts/request-vault-withdrawal.ts --network localhost
