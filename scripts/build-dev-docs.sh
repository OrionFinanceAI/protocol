#!/usr/bin/env bash
set -euo pipefail

echo "→ Generating Hardhat docs"
pnpm docgen

echo "→ Post processing docs"
./scripts/postprocess-docs.sh

echo "→ Syncing to docs repo"
rsync -av --delete \
  docs/ \
  ../docs/docs/developer/smart-contracts/

cd ../docs
yarn start