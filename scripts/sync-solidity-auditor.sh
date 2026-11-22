#!/usr/bin/env bash
# Refresh .coderabbit/solidity-auditor from upstream pashov/skills (MIT).
# Usage: scripts/sync-solidity-auditor.sh [--check] [ref]
# Requires an authenticated `gh`. Vendors only the knowledge files (not the Claude Code orchestration) and re-pins the
# commit SHA in the folder README. Review `git diff` before committing: these files steer the AI reviewer.
#
# --check  Read-only. Reports whether upstream changed the solidity-auditor skill since the pinned commit. Never
#          modifies files and never fails on network/auth errors (so it is safe in a git hook); exits 0 when up to date
#          or unknown, 10 when the pinned copy is behind upstream.
set -euo pipefail

CHECK=0
if [ "${1:-}" = "--check" ]; then CHECK=1; shift; fi

REF="${1:-main}"
REPO="pashov/skills"
SRC="solidity-auditor/references"
DEST="$(cd "$(dirname "$0")/.." && pwd)/.coderabbit/solidity-auditor"

if [ "$CHECK" = 1 ]; then
  PINNED="$(grep -oE '[0-9a-f]{40}' "$DEST/README.md" | head -1 || true)"
  if [ -z "$PINNED" ] || ! command -v gh >/dev/null 2>&1; then
    echo "solidity-auditor: cannot check upstream (no pinned SHA or gh missing); skipping."
    exit 0
  fi
  CHANGED="$(perl -e 'alarm 15; exec @ARGV' gh api "repos/$REPO/compare/$PINNED...$REF" \
    --jq '[.files[].filename | select(startswith("solidity-auditor/"))] | length' 2>/dev/null)" || CHANGED=unknown
  case "$CHANGED" in *[!0-9]* | "") CHANGED=unknown ;; esac
  case "$CHANGED" in
    unknown | "") echo "solidity-auditor: upstream check unavailable (offline or gh not authenticated); skipping." ;;
    0) echo "solidity-auditor: vendored copy is up to date with $REPO@$REF." ;;
    *)
      echo "solidity-auditor: upstream $REPO@$REF changed $CHANGED file(s) since pin ${PINNED:0:12}."
      echo "  Run scripts/sync-solidity-auditor.sh, review 'git diff -- .coderabbit', then commit."
      exit 10
      ;;
  esac
  exit 0
fi

SHA="$(gh api "repos/$REPO/commits/$REF" --jq .sha)"
echo "Syncing $REPO@$SHA"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fetch() { # path-in-repo -> file under $TMP/<path-in-repo>
  mkdir -p "$TMP/$(dirname "$1")"
  gh api "repos/$REPO/contents/$1?ref=$SHA" --jq .content | base64 -d >"$TMP/$1"
}

fetch LICENSE
fetch solidity-auditor/VERSION
fetch "$SRC/judging.md"
fetch "$SRC/senior-auditor-sop.md"
# Save the tree listing with a checked foreground command (process substitution would swallow a gh failure).
gh api "repos/$REPO/git/trees/$SHA?recursive=1" \
  --jq ".tree[] | select(.path | startswith(\"$SRC/hacking-agents/\")) | .path" >"$TMP/agent-paths.txt"
while read -r path; do fetch "$path"; done <"$TMP/agent-paths.txt"

# Validate everything we are about to install BEFORE deleting the existing copy.
for required in LICENSE solidity-auditor/VERSION "$SRC/judging.md" "$SRC/senior-auditor-sop.md" \
  "$SRC/hacking-agents/shared-rules.md"; do
  [ -s "$TMP/$required" ] || {
    echo "sync aborted: missing or empty upstream file: $required (existing copy left untouched)" >&2
    exit 1
  }
done
if [ "$(find "$TMP/$SRC/hacking-agents" -name '*.md' -size +0 2>/dev/null | wc -l)" -lt 1 ]; then
  echo "sync aborted: no hacking-agents/*.md fetched (existing copy left untouched)" >&2
  exit 1
fi

rm -rf "$DEST/hacking-agents" "$DEST/judging.md" "$DEST/senior-auditor-sop.md" "$DEST/LICENSE"
mkdir -p "$DEST/hacking-agents"
cp "$TMP/$SRC"/hacking-agents/*.md "$DEST/hacking-agents/"
cp "$TMP/$SRC/judging.md" "$TMP/$SRC/senior-auditor-sop.md" "$DEST/"
cp "$TMP/LICENSE" "$DEST/LICENSE"

VERSION="$(tr -d '[:space:]' <"$TMP/solidity-auditor/VERSION")"
sed -i.bak -E "s/pinned at commit \`[0-9a-f]{40}\` \(skill version [^)]*\)/pinned at commit \`$SHA\` (skill version $VERSION)/" "$DEST/README.md"
rm -f "$DEST/README.md.bak"
echo "Done: skill version $VERSION @ $SHA. Review with: git diff -- .coderabbit"
