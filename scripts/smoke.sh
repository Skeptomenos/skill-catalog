#!/usr/bin/env bash
# Smoke gate: boots the PRODUCTION artifact (dist/index.js, the same entry point
# used by `pnpm start`, DEPLOYMENT.md, and the launchd plist) against throwaway
# fixture skill roots, then asserts deploy-critical behavior end to end:
#   - the build output matches the documented entry point
#   - the server refuses to start when bearer_token_env is set but unresolved
#   - /health responds
#   - /mcp and /admin/api/* reject missing/wrong bearer tokens
#   - admin POSTs reject authenticated requests without the custom admin header
#   - a real MCP client can initialize and call all four tools (scripts/smoke-client.mjs)
#   - blocked-root skills are denied on search and read surfaces
#
# Run via `pnpm smoke` (after `pnpm build`) or as part of `pnpm validate`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${SMOKE_PORT:-7493}"
TOKEN="smoke-token-$$"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/skill-catalog-smoke.XXXXXX")"
SERVER_PID=""

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() {
  echo "SMOKE FAIL: $1" >&2
  if [[ -f "$TMP/server.log" ]]; then
    echo "--- server.log (tail) ---" >&2
    tail -20 "$TMP/server.log" >&2 || true
  fi
  exit 1
}

# --- Gate 1: build output matches the documented production entry point ---
[[ -f "$ROOT/dist/index.js" ]] || fail "dist/index.js missing. The build output does not match the production entry point used by 'pnpm start' and docs/DEPLOYMENT.md. Run 'pnpm build' first; if it emitted elsewhere (e.g. dist/src/), the build config has drifted."

# --- Fixtures: one trusted root, one blocked root ---
mkdir -p "$TMP/skills/smoke-prd/docs" "$TMP/skills/smoke-git" "$TMP/blocked/smoke-blocked-skill"

cat > "$TMP/skills/smoke-prd/SKILL.md" <<'EOF'
---
name: smoke-prd
description: Smoke fixture for PRD planning checks. Unique smoke marker zqsmokeprd.
author: Smoke Fixture
version: 0.1.0
source:
  type: self
  name: smoke-fixtures
triggers:
  - zqsmokeprd
---

# Smoke PRD

Smoke PRD body.
EOF
printf 'Smoke template body\n' > "$TMP/skills/smoke-prd/docs/template.md"

cat > "$TMP/skills/smoke-git/SKILL.md" <<'EOF'
---
name: smoke-git
description: Smoke fixture for git workflow checks. Unique smoke marker zqsmokegit.
---

# Smoke Git
EOF

cat > "$TMP/blocked/smoke-blocked-skill/SKILL.md" <<'EOF'
---
name: smoke-blocked-skill
description: Blocked smoke fixture that must never surface in search or reads. Unique smoke marker zqsmokeblocked.
---

# Blocked
EOF

cat > "$TMP/config.yaml" <<EOF
server:
  transport: streamable-http
  host: 127.0.0.1
  port: $PORT
  bearer_token_env: SKILL_CATALOG_SMOKE_TOKEN
  session_mode: stateful

roots:
  - name: smoke-trusted
    path: $TMP/skills
    default_trust_status: trusted
  - name: smoke-blocked
    path: $TMP/blocked
    default_trust_status: blocked

storage:
  sqlite_path: $TMP/catalog.sqlite

search:
  default_limit: 5
  max_limit: 20
  qmd:
    enabled: false

limits:
  max_skill_bytes: 262144
  max_inline_reference_bytes: 131072
  max_http_body_bytes: 1048576
  follow_symlinks: false
  rate_limit:
    enabled: true
    window_ms: 60000
    max_requests: 500
    max_entries: 1000
EOF

# --- Gate 2: refuse to start when bearer_token_env is set but unresolved ---
set +e
env -u SKILL_CATALOG_SMOKE_TOKEN timeout 5 node "$ROOT/dist/index.js" --config "$TMP/config.yaml" > "$TMP/noauth.log" 2>&1
NOAUTH_EXIT=$?
set -e
if [[ "$NOAUTH_EXIT" -eq 124 ]]; then
  fail "server kept running with bearer_token_env configured but the env var unset (auth would be silently disabled)"
fi
if [[ "$NOAUTH_EXIT" -eq 0 ]]; then
  fail "server exited 0 when bearer_token_env was unresolved; expected a startup error"
fi

# --- Boot the real server ---
SKILL_CATALOG_SMOKE_TOKEN="$TOKEN" node "$ROOT/dist/index.js" --config "$TMP/config.yaml" > "$TMP/server.log" 2>&1 &
SERVER_PID=$!

HEALTHY=""
for _ in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; then
    HEALTHY=1
    break
  fi
  kill -0 "$SERVER_PID" 2>/dev/null || fail "server process exited during startup"
  sleep 0.2
done
[[ -n "$HEALTHY" ]] || fail "/health did not become ready"

http_code() {
  curl -s -o /dev/null -w '%{http_code}' "$@"
}

INIT_BODY='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.0"}}}'

# --- Gate 3: auth is enforced on /mcp and /admin/api/* ---
CODE=$(http_code -X POST "http://127.0.0.1:$PORT/mcp" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  --data "$INIT_BODY")
[[ "$CODE" == "401" ]] || fail "/mcp without token returned $CODE, expected 401"

CODE=$(http_code -X POST "http://127.0.0.1:$PORT/mcp" \
  -H "authorization: Bearer wrong-$TOKEN" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  --data "$INIT_BODY")
[[ "$CODE" == "401" ]] || fail "/mcp with wrong token returned $CODE, expected 401"

CODE=$(http_code "http://127.0.0.1:$PORT/admin/api/status")
[[ "$CODE" == "401" ]] || fail "/admin/api/status without token returned $CODE, expected 401"

CODE=$(http_code -X POST "http://127.0.0.1:$PORT/admin/api/rebuild")
[[ "$CODE" == "401" ]] || fail "/admin/api/rebuild without token returned $CODE, expected 401"

CODE=$(http_code "http://127.0.0.1:$PORT/admin")
[[ "$CODE" == "200" ]] || fail "/admin page returned $CODE, expected 200"

STATUS_JSON=$(curl -fsS -H "authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/admin/api/status") \
  || fail "/admin/api/status with token failed"
echo "$STATUS_JSON" | grep -q '"skills_indexed"' || fail "/admin/api/status response missing skills_indexed"

CODE=$(http_code -X POST "http://127.0.0.1:$PORT/admin/api/rebuild" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  --data '{}')
[[ "$CODE" == "403" ]] || fail "/admin/api/rebuild with token but no admin header returned $CODE, expected 403"

REBUILD_JSON=$(curl -fsS -X POST "http://127.0.0.1:$PORT/admin/api/rebuild" \
  -H "authorization: Bearer $TOKEN" \
  -H 'x-skill-catalog-admin: true' \
  -H 'content-type: application/json' \
  --data '{}') || fail "/admin/api/rebuild with token and admin header failed"
echo "$REBUILD_JSON" | grep -q '"status"' || fail "/admin/api/rebuild response missing status"

# --- Gate 4: end-to-end MCP tool calls through a real client ---
SMOKE_URL="http://127.0.0.1:$PORT/mcp" SMOKE_TOKEN="$TOKEN" node "$ROOT/scripts/smoke-client.mjs" \
  || fail "MCP client end-to-end checks failed (see output above)"

echo "SMOKE OK"
