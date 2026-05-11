#!/usr/bin/env bash
set -euo pipefail

echo "→ Generating Solidity API docs (solidity-docgen via scripts/run-docgen.mjs)"
pnpm docgen

echo "→ Post processing docs"
./scripts/postprocess-docs.sh

echo "→ Syncing to docs repo"
rsync -av --delete \
  docs/ \
  ../docs/docs/developer/smart-contracts/

cd ../docs
yarn start