#!/usr/bin/env bash
# Ratchet the Bun CI install to the read-only internal package identity.
# shellcheck disable=SC2016 # Assertions intentionally match literal CI expressions.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WORKFLOW="$ROOT/.gitea/workflows/test.yml"
NPMRC="$ROOT/.npmrc"
PACKAGE_JSON="$ROOT/package.json"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

require() {
  local file="$1" phrase="$2"
  grep -Fq -- "$phrase" "$file" || fail "$(basename "$file") must contain: $phrase"
}

forbid() {
  local file="$1" phrase="$2"
  if grep -Fqi -- "$phrase" "$file"; then
    fail "$(basename "$file") must not contain: $phrase"
  fi
}

require_before() {
  local file="$1" first="$2" second="$3" first_line second_line
  first_line="$(grep -nF -- "$first" "$file" | head -1 | cut -d: -f1)"
  second_line="$(grep -nF -- "$second" "$file" | head -1 | cut -d: -f1)"
  [[ -n "$first_line" && -n "$second_line" && "$first_line" -lt "$second_line" ]] ||
    fail "$first must appear before $second in $(basename "$file")"
}

require "$NPMRC" "@molecule-ai:registry=https://git.moleculesai.app/api/packages/molecule-ai/npm/"
require "$NPMRC" '//git.moleculesai.app/api/packages/molecule-ai/npm/:_authToken=${MCP_SERVER_READPKG_TOKEN}'
require "$PACKAGE_JSON" '"@molecule-ai/mcp-server": "1.8.3"'

require "$WORKFLOW" "Install dependencies from the authenticated internal registry"
require "$WORKFLOW" 'INFISICAL_CI_CLIENT_ID: ${{ secrets.INFISICAL_CI_CLIENT_ID }}'
require "$WORKFLOW" 'INFISICAL_CI_CLIENT_SECRET: ${{ secrets.INFISICAL_CI_CLIENT_SECRET }}'
require "$WORKFLOW" 'INFISICAL_CI_PROJECT_ID: ${{ secrets.INFISICAL_CI_PROJECT_ID }}'
require "$WORKFLOW" "MOLECULE_TEMPLATE_REPO_TOKEN"
require "$WORKFLOW" "%2Fshared%2Fcontrolplane"
require "$WORKFLOW" 'echo "::add-mask::$MCP_SERVER_READPKG_TOKEN"'
require "$WORKFLOW" 'export MCP_SERVER_READPKG_TOKEN'
require "$WORKFLOW" 'cache_dir="$(mktemp -d)"'
require "$WORKFLOW" 'BUN_INSTALL_CACHE_DIR="$cache_dir" bun install --frozen-lockfile'
require "$WORKFLOW" "bun install --frozen-lockfile"

require_before "$WORKFLOW" "Install dependencies from the authenticated internal registry" "bun install --frozen-lockfile"
require_before "$WORKFLOW" 'export MCP_SERVER_READPKG_TOKEN' "bun install --frozen-lockfile"

forbid "$WORKFLOW" "registry.npmjs.org"
forbid "$WORKFLOW" "gitea-pat-owner"
forbid "$WORKFLOW" "MOL_PACKAGE_TOKEN"
forbid "$WORKFLOW" '>> "$GITHUB_ENV"'
forbid "$NPMRC" "registry.npmjs.org"
forbid "$NPMRC" "gitea-pat-owner"

echo "PASS: Bun CI installs @molecule-ai packages from internal Gitea with read-only auth"
