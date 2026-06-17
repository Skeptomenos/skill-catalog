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
