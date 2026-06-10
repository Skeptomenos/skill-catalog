# Skill Catalog

Skill Catalog is an MCP service that lets coding agents discover and load a large skill library without putting every skill description into the initial prompt.

The service indexes configured skill roots recursively, exposes selection-oriented skill search, and returns full skill files only when an agent explicitly chooses a skill. It is designed first for personal use on a Mac Mini over private Streamable HTTP, then for local-device and internal-company deployments.

## Current Status

Milestones 1 and 2 are complete. A runnable v1 read-only MCP server exists with SQLite FTS search, optional QMD hybrid ranking, guarded skill/reference reads, config examples, and validation tests.

Milestone 3 is implemented and in final hardening: public split publishing, private-network deployment guidance, auth and admin guards, bounded stateful sessions, observability, and a read-only management UI for operating the MCP server are present.

Public split publishing targets [Skeptomenos/skill-catalog](https://github.com/Skeptomenos/skill-catalog). The split workflow publishes a server-package-only public copy while excluding the private planning corpus, monorepo-only agent instructions, the router skill artifact, and bundled/imported skill content. The public repo is not a Codex plugin, skill bundle, or marketplace package.

## Runtime Decision

V1 uses the official MCP TypeScript SDK with Zod tool schemas at the public MCP boundary. The service core is Effect-native: config, filesystem scanning, SQLite, QMD, search, and audit behavior expose Effect-returning service methods.

This keeps the MCP contract conventional while giving the long-lived daemon typed errors, resource lifecycle management, retries/timeouts, and observability without wiring an unused layer graph in V1.

## Goals

- Make a large personal skill library discoverable without context bloat.
- Keep Codex and OpenCode native skill lists small by installing only a router skill globally.
- Support remote Streamable HTTP so multiple agent clients can use a central Mac Mini service.
- Preserve progressive disclosure: search returns metadata, `read_skill` returns `SKILL.md`, and references are fetched separately.
- Keep all index state rebuildable from configured roots.

## Operation

- MCP endpoint: `/mcp`
- Health endpoint: `/health`
- Management UI: `/admin`

The management UI shows root/sync diagnostics, FTS/QMD health, metadata and trust warnings, smoke checks, recent audit events, effective config, and a derived-index rebuild control. It does not create, edit, import, approve, or publish skills.

The example config uses `server.bearer_token_env: SKILL_CATALOG_TOKEN`, so `SKILL_CATALOG_TOKEN` must be set and non-empty before startup. Omitting `bearer_token_env` is the only intentional no-auth mode, and it should be limited to narrow local development.

## Non-Goals for v1

- No skill creation or editing.
- No skill installation into Codex, OpenCode, or Claude Code beyond a router skill artifact.
- No ACL model beyond private-network access plus bearer token.
- No MCP resources or prompts.
- No execution of scripts found inside skill folders.
- No replacement for repo-local native skills.

## Planned Milestones

| Milestone | Scope |
|-----------|-------|
| 1 | Done - design docs, architecture, session context, and v1 implementation plan |
| 2 | Done - runnable read-only MCP server with SQLite metadata search and optional QMD hybrid ranking |
| 3 | Implemented/final hardening - server-package public split publishing, operational deployment, management UI, and auth/admin/audit hardening |
| 4+ | Registry, write workflow, quality gates, ACLs, MCP resources, and richer progressive disclosure |

## Documentation

- [Design](docs/DESIGN.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Deployment](docs/DEPLOYMENT.md)

## References

- Codex skills: https://developers.openai.com/codex/skills
- Codex MCP: https://developers.openai.com/codex/mcp
- OpenCode skills: https://opencode.ai/docs/skills/
- OpenCode plugins: https://opencode.ai/docs/plugins/
