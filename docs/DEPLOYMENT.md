# Skill Catalog Deployment

## Target Shape

V1 is designed for a Mac Mini or similar always-on host reachable over a private network. The server exposes Streamable HTTP at `/mcp`, a health check at `/health`, and the management UI at `/admin`.

Assumptions:

- The host is reachable only on localhost or a private network such as Tailscale.
- A bearer token protects `/mcp` and `/admin/api/*`.
- Skill roots are explicit directories on the host.
- Every configured root must exist, be a directory, and not be a symlink at startup.
- SQLite is derived cache state and can be rebuilt from configured roots.

## Files And Environment

Recommended config path:

```bash
~/.config/skill-catalog/config.yaml
```

Recommended cache path:

```bash
~/.cache/skill-catalog/catalog.sqlite
```

Required environment for the example config:

```bash
export AI_DEV_ROOT=/Users/david.helmus/repos/ai-dev
export SKILL_CATALOG_TOKEN="$(openssl rand -base64 32)"
```

The example config sets `server.bearer_token_env: SKILL_CATALOG_TOKEN`. Startup fails if that variable is unset or empty. To run without auth for narrow local development, omit `bearer_token_env` from the config; do not leave it configured with a missing token.

Copy `config/skill-catalog.example.yaml` to the config path and adjust:

```yaml
server:
  host: 127.0.0.1
  port: 7421
  allowed_hosts: []
  max_sessions: 100
  session_idle_ttl_ms: 1800000
  bearer_token_env: SKILL_CATALOG_TOKEN
  session_mode: stateful

roots:
  - name: skill-catalog-internal-skills
    path: ${AI_DEV_ROOT}/_infra/skill-catalog/skills
    default_trust_status: trusted
  - name: ai-dev-skills
    path: ${AI_DEV_ROOT}/_infra/skills/skills
    default_trust_status: trusted
  - name: ai-dev-agent-skills
    path: ${AI_DEV_ROOT}/.agents/skills
    default_trust_status: trusted

storage:
  sqlite_path: ~/.cache/skill-catalog/catalog.sqlite
```

Keep `skill-catalog-internal-skills` enabled for normal installs. It contains Skill Catalog product-owned helper skills that ship with the server, unlike private or external skill-library roots.

## External Skill Roots

Externally sourced skills should live outside the Skill Catalog server package and be added as explicit roots in the local deployment config. This keeps the public split artifact server-only while still letting a private deployment index cloned or synced skill libraries.

Example for a cloned Git skill library:

```bash
mkdir -p ~/skill-catalog-external
git clone https://github.com/google-labs-code/stitch-skills \
  ~/skill-catalog-external/stitch-skills
```

Add the cloned library's skill-package root to `~/.config/skill-catalog/config.yaml`:

```yaml
roots:
  - name: ai-dev-skills
    path: ${AI_DEV_ROOT}/_infra/skills/skills
    default_trust_status: trusted
  - name: google-stitch-skills
    path: ~/skill-catalog-external/stitch-skills/plugins
    default_trust_status: review_required
```

Use `review_required` for unreviewed external roots. Source metadata does not imply local trust, and V1 does not run a security review or execute scripts found inside skill folders.

After changing roots, restart the service or use the admin rebuild action. Verify the root was indexed:

```bash
TOKEN="$(tr -d '\n' < ~/.config/skill-catalog/token)"
curl -sS -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:7421/admin/api/status
```

The status output should include the external root name, indexed skill count, `review_required` trust status, and any metadata warnings from upstream `SKILL.md` frontmatter.

## QMD Collection Maintenance

If QMD is enabled with `search.qmd.collection: skill-catalog`, keep that QMD collection aligned with the same roots that Skill Catalog scans. QMD must emit filesystem paths with `--full-path`, so index the real root paths rather than symlinks.

For the ai-dev root plus the Google Stitch external root:

```bash
qmd collection remove skill-catalog
qmd collection add /Users/david.helmus \
  --name skill-catalog \
  --mask '{repos/ai-dev/_infra/skills/skills/**/SKILL.md,skill-catalog-external/stitch-skills/plugins/**/SKILL.md}'
qmd embed -c skill-catalog --max-docs-per-batch 100 --max-batch-mb 20
```

Verify QMD retrieval:

```bash
qmd ls skill-catalog
qmd query 'stitch generate design' -c skill-catalog --full-path --no-rerank -n 5
```

Expected evidence is that `qmd ls` includes the same number of `SKILL.md` files as the configured nonblocked roots, and the query returns absolute paths under the cloned external skill directory.

For a private-network listener, set `server.host` to the host's Tailscale IP and put any MagicDNS name clients use in `server.allowed_hosts`:

```yaml
server:
  host: 100.64.0.10
  allowed_hosts:
    - skillbox.tailnet-name.ts.net
  bearer_token_env: SKILL_CATALOG_TOKEN
```

If binding to `0.0.0.0`, set `server.allowed_hosts` to the explicit private hostnames clients may use; otherwise host-header validation is disabled and the server prints a warning. Keep the bearer token enabled whenever binding beyond localhost.

## Startup

Install and build from the server package:

```bash
pnpm install
pnpm build
```

Start the service:

```bash
AI_DEV_ROOT=/Users/david.helmus/repos/ai-dev \
SKILL_CATALOG_TOKEN=replace-with-token \
node dist/index.js --config ~/.config/skill-catalog/config.yaml
```

Health check:

```bash
curl http://127.0.0.1:7421/health
```

Management UI:

```text
http://127.0.0.1:7421/admin
```

If a bearer token is configured, enter it in the UI token field. API requests use `Authorization: Bearer <token>`.

Admin API `POST` requests also require `X-Skill-Catalog-Admin: true` and are rejected when the browser sends a cross-origin `Origin`. The UI sends the header for its rebuild/smoke actions; direct scripts must send it too. `/admin/api/*` uses the same in-memory V1 rate-limit settings as `/mcp`, returning normal JSON `429` responses for admin throttling.

No-auth mode is only selected by omitting `server.bearer_token_env`; it is appropriate only for tightly scoped local development on a trusted machine.

## MCP Timeout Triage Runbook

If a Codex or OpenCode session can discover the `skill-catalog` tool namespace but `tools/call` waits until a 300-second client timeout, first separate server health from client/session bridge state. Tool discovery alone is not proof that the current `/mcp` call path is healthy.

Start with the local HTTP surfaces:

```bash
TOKEN="$(tr -d '\n' < ~/.config/skill-catalog/token)"

curl -sS -w ' code=%{http_code} time=%{time_total}\n' \
  http://127.0.0.1:7421/health

curl -sS -H "Authorization: Bearer $TOKEN" \
  -w ' code=%{http_code} time=%{time_total}\n' \
  http://127.0.0.1:7421/admin/api/status
```

Expected healthy evidence is `/health` returning `200`, admin status returning `200`, the configured roots and indexed counts appearing in the JSON, and `search_backends.qmd` reporting `disabled`, `ready`, or `unavailable` rather than the request hanging.

Then verify that the process and catalog cache are usable:

```bash
launchctl print gui/$(id -u)/com.skill-catalog.server
lsof -nP -iTCP:7421 -sTCP:LISTEN
lsof -nP ~/.cache/skill-catalog/catalog.sqlite \
  ~/.cache/skill-catalog/catalog.sqlite-wal \
  ~/.cache/skill-catalog/catalog.sqlite-shm 2>/dev/null || true

sqlite3 -readonly ~/.cache/skill-catalog/catalog.sqlite \
  "pragma query_only=ON; pragma quick_check; select source_root, count(*) from skills group by source_root;"
```

Do not paste raw `launchctl print` output into tickets or chat without reviewing it first; the user launchd domain can include unrelated secret-bearing environment variables. The Skill Catalog LaunchAgent should use a narrow wrapper or environment, but `launchctl print` may still show inherited GUI-domain state.

If QMD is enabled, verify it separately. QMD failures should not block FTS search, and status/admin diagnostics should show the latest QMD warning:

```bash
qmd ls skill-catalog
qmd query 'stitch generate design' -c skill-catalog --full-path --no-rerank -n 5
```

For the strongest client/server split, run a direct MCP SDK smoke from the host shell. This uses the same `/mcp` protocol path as agents, but bypasses the current Codex/OpenCode session bridge:

```bash
TOKEN="$(tr -d '\n' < ~/.config/skill-catalog/token)"
SMOKE_URL='http://127.0.0.1:7421/mcp' SMOKE_TOKEN="$TOKEN" \
node scripts/smoke-client.mjs
```

When investigating logs, use the structured JSON lines in `~/Library/Logs/skill-catalog.out.log`. `/mcp` requests emit:

- `mcp_request_start`
- `mcp_request_end`
- `mcp_tool_call_start`
- `mcp_tool_call_end`
- `mcp_tool_call_error`

Interpretation:

- No `mcp_request_start` near the client timeout: the request likely did not reach the Skill Catalog server; suspect client/session bridge, MCP client state, URL/auth configuration, or network routing.
- `mcp_request_start` without `mcp_request_end`: the HTTP request entered Express but did not finish; inspect transport/session handling and process health.
- `mcp_tool_call_start` without `mcp_tool_call_end` or `mcp_tool_call_error`: the request reached a tool handler and likely stalled in the tool path or backend it called.
- `mcp_tool_call_error`: inspect the JSON error summary and the adjacent stderr log.
- Fast `/health`, admin status, and direct SDK calls while one Codex session times out: treat it as a session-local MCP bridge issue and start a fresh session or restart the client before changing server code.

The structured logs intentionally omit bearer tokens and skill contents. Search queries, skill names, relative reference paths, request IDs, MCP session IDs, status codes, and durations may appear to make incidents diagnosable.

## launchd Service Shape

Create `~/Library/LaunchAgents/com.skill-catalog.server.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.skill-catalog.server</string>
  <key>WorkingDirectory</key>
  <string>/Users/david.helmus/repos/ai-dev/_infra/skill-catalog</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>dist/index.js</string>
    <string>--config</string>
    <string>/Users/david.helmus/.config/skill-catalog/config.yaml</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AI_DEV_ROOT</key>
    <string>/Users/david.helmus/repos/ai-dev</string>
    <key>SKILL_CATALOG_TOKEN</key>
    <string>replace-with-token</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/david.helmus/Library/Logs/skill-catalog.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/david.helmus/Library/Logs/skill-catalog.err.log</string>
</dict>
</plist>
```

Load it:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.skill-catalog.server.plist
launchctl kickstart -k gui/$(id -u)/com.skill-catalog.server
```

## Private Network Notes

- Prefer Tailscale MagicDNS or the node's Tailscale IP over exposing the service on a public interface.
- If binding to `0.0.0.0`, configure `server.allowed_hosts` and restrict access with Tailscale ACLs, a host firewall, or a reverse proxy on the same private network.
- Treat `SKILL_CATALOG_TOKEN` like an API key. Rotate it by updating the environment and restarting the service.
- QMD is optional. If `search.qmd.enabled` is true and QMD fails, FTS search still works and `skill_catalog_status` plus `/admin` show the latest QMD warning.
- The SQLite file is cache state. Use the `/admin` rebuild control or restart the service to rebuild from configured roots after source changes.
