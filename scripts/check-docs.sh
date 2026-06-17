#!/usr/bin/env bash
# Docs-consistency gate: cross-checks verifiable literals in the docs against
# the code and package metadata so prose cannot silently drift from reality.
# Checks: the production start command appears in DEPLOYMENT.md (run command and
# launchd plist), no stale machine-specific paths, no references to drifted build
# output, every MCP tool registered in code is documented in ARCHITECTURE.md, and
# integration example URLs use the example config port. It also verifies that the
# public split artifact stays self-contained after private planning content is
# stripped.
#
# Run via `pnpm check:docs` or as part of `pnpm validate`.
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail() {
  echo "DOCS CHECK FAIL: $1" >&2
  exit 1
}

if grep -n -E '(^|[;&|[:space:]])r[g]([[:space:]]|$)' "$0"; then
  fail "check-docs uses an undeclared ripgrep command"
fi

START_CMD="$(node -p "require('./package.json').scripts.start")"
ENTRY="${START_CMD#node }"
[[ -n "$ENTRY" && "$ENTRY" != "$START_CMD" ]] || fail "could not derive entry point from package.json start script ('$START_CMD')"

[[ -f "docs/DEPLOYMENT.md" ]] || fail "docs/DEPLOYMENT.md missing"

grep -q "node $ENTRY" docs/DEPLOYMENT.md \
  || fail "DEPLOYMENT.md run command does not match package.json start script ('node $ENTRY')"
grep -q "<string>$ENTRY</string>" docs/DEPLOYMENT.md \
  || fail "DEPLOYMENT.md launchd plist ProgramArguments does not reference '$ENTRY'"

if grep -rn '\.codex/worktrees' README.md AGENTS.md CONTEXT.md docs/ 2>/dev/null; then
  fail "stale machine-specific worktree path found in docs (see matches above)"
fi

if grep -rn 'dist/src/index\.js' README.md AGENTS.md CONTEXT.md docs/ package.json 2>/dev/null; then
  fail "reference to dist/src/index.js found; build output and docs have drifted (see matches above)"
fi

for tool in search_skills read_skill read_skill_reference skill_catalog_status; do
  grep -q "\"$tool\"" src/mcp/mcp-server.ts \
    || fail "tool '$tool' is not registered in src/mcp/mcp-server.ts"
  grep -q "$tool" docs/ARCHITECTURE.md \
    || fail "tool '$tool' is registered in code but undocumented in docs/ARCHITECTURE.md"
done

EXAMPLE_PORT="$(grep -m1 -E '^\s*port:' config/skill-catalog.example.yaml | awk '{print $2}')"
[[ -n "$EXAMPLE_PORT" ]] || fail "could not read port from config/skill-catalog.example.yaml"
grep -q ":$EXAMPLE_PORT/mcp" integrations/codex-config.example.toml \
  || fail "codex example URL port does not match example config port ($EXAMPLE_PORT)"
grep -q ":$EXAMPLE_PORT/mcp" integrations/opencode-mcp.example.json \
  || fail "opencode example URL port does not match example config port ($EXAMPLE_PORT)"

PUBLIC_ARTIFACT_ROOT="$(mktemp -d /tmp/skill-catalog-public-docs.XXXXXX)"
trap 'rm -rf "$PUBLIC_ARTIFACT_ROOT"' EXIT
PUBLIC_ARTIFACT="$PUBLIC_ARTIFACT_ROOT/skill-catalog"
rsync -a --delete --exclude node_modules --exclude dist ./ "$PUBLIC_ARTIFACT/"
rm -rf "$PUBLIC_ARTIFACT/_planning"
rm -rf "$PUBLIC_ARTIFACT/integrations/skill-router"
rm -rf "$PUBLIC_ARTIFACT/fixtures"
rm -rf "$PUBLIC_ARTIFACT/skill-fixtures"
rm -rf "$PUBLIC_ARTIFACT/bundled-skills"
rm -rf "$PUBLIC_ARTIFACT/imported-skills"
rm -rf "$PUBLIC_ARTIFACT/.codex-plugin"
rm -rf "$PUBLIC_ARTIFACT/marketplace"
rm -f "$PUBLIC_ARTIFACT/AGENTS.md"

for required_file in package.json src/index.ts config/skill-catalog.example.yaml README.md docs/ARCHITECTURE.md docs/DEPLOYMENT.md docs/DESIGN.md skills/skill-install/SKILL.md skills/skill-install/scripts/install.py; do
  [[ -f "$PUBLIC_ARTIFACT/$required_file" ]] \
    || fail "public split artifact missing required file '$required_file'"
done

[[ ! -e "$PUBLIC_ARTIFACT/AGENTS.md" ]] \
  || fail "public split artifact should not include monorepo-only AGENTS.md"

if grep -R -n -E '_planning|session-context|\]\([^)]*plans/' "$PUBLIC_ARTIFACT/README.md" "$PUBLIC_ARTIFACT/docs" 2>/dev/null; then
  fail "public split artifact contains references to stripped private planning content (see matches above)"
fi

echo "DOCS CHECK OK"
