#!/usr/bin/env bash
set -euo pipefail

SLITHER_ARGS=(. --filter-paths "lib|node_modules|dependencies|test|contracts/morpho" --fail-medium)

if [[ -x ".venv/bin/slither" ]]; then
  SLITHER_BIN=".venv/bin/slither"
elif command -v slither >/dev/null 2>&1; then
  SLITHER_BIN="slither"
else
  echo "Slither not found. Run: make install (or source .venv/bin/activate && uv pip install slither-analyzer==0.11.5)"
  exit 1
fi

# Hardhat 3 writes split build-info files (<id>.json + <id>.output.json).
# crytic-compile expects a single file containing `output`.
pnpm compile >/dev/null
node scripts/merge-hardhat3-build-info.mjs

# Create HH3 virtual source links expected by crytic-compile path checks.
CREATED_PROJECT_LINK=false
CREATED_NPM_DIR=false
if [[ ! -e "project" ]]; then
  ln -s . project
  CREATED_PROJECT_LINK=true
fi
if [[ ! -e "npm" ]]; then
  mkdir -p npm
  CREATED_NPM_DIR=true
fi
node scripts/link-hardhat3-virtual-sources.mjs

# Hide HH3 split-only companion files; crytic-compile expects one JSON per build.
OUTPUT_FILES=(artifacts/build-info/*.output.json)
HAVE_OUTPUT_FILES=false
if [[ -e "${OUTPUT_FILES[0]}" ]]; then
  HAVE_OUTPUT_FILES=true
  for f in "${OUTPUT_FILES[@]}"; do
    mv "$f" "$f.bak"
  done
fi

cleanup() {
  if [[ "$CREATED_PROJECT_LINK" == true && -L "project" ]]; then
    rm project
  fi
  if [[ "$CREATED_NPM_DIR" == true && -d "npm" ]]; then
    rm -rf npm
  fi
  if [[ "$HAVE_OUTPUT_FILES" == true ]]; then
    for f in artifacts/build-info/*.output.json.bak; do
      [[ -e "$f" ]] || continue
      mv "$f" "${f%.bak}"
    done
  fi
}
trap cleanup EXIT

# Reuse compiled artifacts and skip crytic-compile hardhat recompile path.
"$SLITHER_BIN" "${SLITHER_ARGS[@]}" --ignore-compile --hardhat-ignore-compile
