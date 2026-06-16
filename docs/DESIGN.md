# Skill Catalog Design

## Problem

Codex and OpenCode already support skill progressive disclosure, but they still expose available skill metadata up front. With a large global library, that initial metadata list consumes context, can be shortened or omitted, and makes skill selection less reliable.

The desired system is a central catalog that agents can query only when useful. Agents should start with a tiny router skill and a small MCP surface, then search the catalog before complex work.

## Product Shape

Skill Catalog is a read-only MCP server for skill discovery and retrieval.

V1 indexes configured skill roots and exposes a small set of tools:

- `search_skills` returns selection metadata only.
- `read_skill` returns the full `SKILL.md` for a chosen skill.
- `read_skill_reference` returns a referenced file inside a skill directory.
- `skill_catalog_status` reports sync/index health.

The service does not execute skills. Skills remain instructions and resources that the calling agent reads and applies.

## Runtime Decision

Skill Catalog uses a standard MCP boundary and an Effect service core.

Boundary:

- official MCP TypeScript SDK
- Streamable HTTP transport
- Zod `inputSchema` and `outputSchema` for public MCP tools

First MVP package decision:

- pnpm package manager
- stable `@modelcontextprotocol/sdk@1.29.0`
- avoid v2 MCP SDK split packages until they are no longer alpha

Core:

- Effect-returning service methods for config, filesystem scanning, SQLite, QMD, search, reference reads, and audit logging
- typed errors inside the core
- retries, timeouts, interruption, and resource cleanup where external IO is involved

Rationale: MCP clients and examples expect the SDK's Zod-shaped tool contracts, while the service is more than a small MCP wrapper. It is a long-lived daemon with filesystem scanning, database state, optional subprocess search, auth, audit logs, and future ACL/registry workflows.

Risk: Effect adds a learning curve and build complexity for maintainers who are used to plain TypeScript service code. V1 should keep the Effect boundary clear, keep MCP handlers thin, and avoid unnecessary framework cleverness so future maintainers can follow the direct runtime composition quickly.

The MCP transport adapter should be isolated so a later migration to the v2 split packages can be handled mechanically once those packages stabilize.

## Deployment Model

V1 targets Streamable HTTP over a private network. The first deployment is a Mac Mini hosting the canonical personal skill library. Clients connect from Codex, OpenCode, or other agent harnesses.

Supported deployment shapes:

| Version | Deployment |
|---------|------------|
| v1 | Local or private-network Streamable HTTP with bearer token |
| v2 | Optional local-device or stdio shim if needed for client compatibility |
| v3 | Internal shared server with OAuth, ACLs, and organization/team scopes |

Streamable HTTP is primary. Stdio is useful for local development and single-user setups, but it does not serve the central-hosting goal.

Stateful Streamable HTTP is the default for v1 because it is the most protocol-complete mode for current MCP clients. Stateless Streamable HTTP remains available as a config option for simple local or API-style deployments.

V1 includes in-memory rate limiting for `/mcp` and `/admin/api/*` requests. This is an operational guard against runaway agents, accidental retry loops, and basic private-network abuse. It is not enterprise-grade security because counters reset on process restart and are not shared across replicas. Enterprise-ready phases should replace it with strong auth-aware enforcement at a reverse proxy, gateway, or shared backing store.

V1 also enforces a configurable Express JSON body limit before MCP transport handling or admin API work. This rejects oversized requests early while keeping the MCP service read-only.

## Public Split Publishing

The project split-publishes to `Skeptomenos/skill-catalog` after the split workflow strips non-server artifacts for this package.

Required exclusions for the public split:

- private planning corpus
- bundled skill artifacts, including `integrations/skill-router/`
- any future imported or fixture skill content
- monorepo-only agent instructions

The public repo is a server-package-only copy of this project for people outside the private `ai-dev` monorepo. It should contain the server source, package metadata, config examples, docs, and operational README content. It should not publish private planning, skill-library contents, Codex plugin packaging, or bundled skill artifacts.

## Skill Roots

Skill roots are explicit config entries. V1 begins with:

```text
${AI_DEV_ROOT}/_infra/skills/skills
```

The service must not crawl arbitrary home directories or client machines. Each configured root has a stable root name and path.

## Skill Identity

V1 enforces globally unique skill names across all configured roots.

Each indexed skill has:

- `id`: generated stable identifier.
- `name`: required frontmatter value, globally unique.
- `category`: derived from nested path or frontmatter.
- `source_root`: configured root name.
- `relative_path`: path from root to the skill directory.

Duplicate names are sync errors and must appear in `skill_catalog_status`.

Later registry work can replace generated IDs with persisted registry IDs and source metadata.

## Search Metadata

Search is optimized for skill selection, not browsing. Default result count should be small, with `limit=5` and a configurable hard cap around `20`.

Returned metadata should include:

- `id`
- `name`
- `description`
- `author`
- `version`
- `source`
- `triggers`
- `category`
- `when_to_use`
- `when_not_to_use`
- `source_root`
- `trust_status`
- `warnings`
- `score`
- `matched_backends`
- `matched_fields`
- `why_match`

Preferred metadata fields live in frontmatter:

```yaml
---
name: writing-plans
description: Write and maintain living implementation plans for multi-step work.
triggers:
  - multi-step implementation
category: process/planning
when_to_use:
  - Work has three or more steps.
  - Work touches multiple files or subsystems.
when_not_to_use:
  - Single-file quick fixes.
---
```

Existing skills remain valid with `name` and `description` only. The v1 indexer may parse compatible body sections as a migration bridge, but new skills should move toward explicit frontmatter.

## Skill Source Metadata

New and imported skills should carry source metadata in frontmatter so the catalog can distinguish local/private skills from external skills imported through package workflows such as `npx`, cloned Git repositories, websites, or other catalogs.

`source` describes the skill's original or maintained origin, not every local place the skill passed through before indexing. Local discovery remains `source_root` plus filesystem path. Later acquisition/sync history belongs in catalog-owned SQLite/audit state, not portable skill frontmatter.

Initial `source.type` values:

- `self`: created and maintained by this catalog owner
- `local_catalog`: copied or synced from another catalog on the same machine
- `remote_catalog`: copied or synced from a catalog on another machine
- `git`: cloned or copied from a Git repository
- `website`: copied from a webpage or raw URL
- `npm`: imported through a package workflow such as `npx`

`source` is required for new skills and imported skills. Existing legacy skills remain indexable without `source`, but the catalog should warn when source metadata is missing.

`author` is required for new skills. Imported skills should include the author when known; otherwise they may use `author: unknown` only when `source` is explicit enough to trace the origin. Existing legacy skills remain indexable without `author`, but the catalog should warn when it is missing.

`author` may be written as a string for simple local skills or as an object when richer attribution is useful:

```yaml
author: David Helmus
```

```yaml
author:
  name: Matt Pocock
  url: "https://github.com/mattpocock"
```

The catalog should normalize both forms internally:

```ts
author: {
  name: string
  url?: string
}
```

Minimum preferred fields:

```yaml
---
name: writing-plans
description: Write and maintain living implementation plans for multi-step work.
author: David Helmus
version: 0.1.0
source:
  type: self
  name: ai-dev
---
```

External skills should use a richer `source` object:

```yaml
author: Matt Pocock
source:
  type: git
  url: "https://github.com/mattpocock/skills"
  path: "skills/productivity/grill-me/SKILL.md"
  ref: "main"
  commit: "abc123"
```

Package-driven imports can include the command that installed or synced the skill:

```yaml
author: unknown
source:
  type: npm
  package: "@vendor/agent-skills"
  version: "1.2.3"
  command: "npx @vendor/agent-skills sync"
```

Top-level `version` is the skill author's declared version for that individual skill. Version-like upstream locator fields belong under `source`, for example `source.version`, `source.ref`, or `source.commit`.

New self-created skills should require top-level `version`, starting at `0.1.0`. Imported skills may omit top-level `version` when the upstream skill has no declared version, but source locator fields should identify the imported snapshot where possible. Existing legacy skills remain indexable without `version`, but the catalog should warn when it is missing.

Skill updates should go through a future internal Skill Catalog `skill-patch` tool or skill. That workflow should use SemVer-style significance rules to decide version bumps: patch-level for clarifications, typo fixes, metadata corrections, and compatibility fixes that do not change trigger behavior; minor-level for new compatible workflow capabilities, supported source types, checks, references, or scripts; and major-level for breaking trigger behavior, required inputs, output expectations, or removed workflow paths.

V1 continues accepting existing skills without these fields, but the catalog warns on missing or invalid `author`, `version`, and `source` metadata. Search and status responses expose normalized `author`, `version`, and `source` metadata alongside catalog-owned `source_root`, `trust_status`, and warnings.

Source metadata does not imply trust. Until an import security review exists, external unreviewed skills may be indexed, but search/status/UI responses should clearly surface them as `review_required`. V1 must continue to avoid script execution.

Later import workflows should run a skill security review before external skills are integrated into the catalog. After that gate exists, active catalog skills should be trusted by construction because external imports must pass the review before integration.

Trust and review status are catalog-owned state, not portable skill frontmatter. Frontmatter carries portable facts such as `name`, `description`, `author`, `version`, and `source`. Catalog responses add local operational facts such as `source_root`, `trust_status`, review warnings, reviewer, timestamp, and audit trail.

Trust status values are `trusted`, `review_required`, and `blocked`. `review_required` means the skill is indexed but has not passed the catalog's security review. `blocked` is an active deny state: blocked skills remain indexed for status and admin diagnostics, but they are excluded from normal `search_skills` results and rejected by skill/reference read surfaces.

Default trust status should come from root configuration, not frontmatter alone. A curated local root can default to `trusted`, while an external cloned/npm-synced root can default to `review_required`. Later catalog-owned per-skill review state can override the root default.

```yaml
roots:
  - name: ai-dev-skills
    path: ${AI_DEV_ROOT}/_infra/skills/skills
    default_trust_status: trusted
  - name: external-mattpocock
    path: ~/skills/external/mattpocock
    default_trust_status: review_required
```

V1 search ranking should remain relevance-only. `review_required` skills can appear in `search_skills` results, but ranking should not be adjusted by trust until scores are normalized well enough to avoid burying stronger external matches. V1 should surface trust warnings in result metadata instead.

`blocked` is not a ranking adjustment. It is filtered before results reach normal agent-facing search and read tools.

## Search Backends

Skill Catalog owns the canonical parsed metadata index.

V1 baseline:

- SQLite for derived state.
- SQLite FTS5/BM25 over parsed metadata.
- Deterministic fallback ranking when QMD is disabled, unavailable, or stale.

Optional v1 hybrid boost:

- QMD over `SKILL.md` files only.
- QMD is optional and feature-flagged.
- Search works without QMD.
- Results show backend attribution, for example `matched_backends: ["fts", "qmd"]`.

QMD should not index reference files in v1. References are for after selection, not for routing.

QMD failures are visible in status/admin diagnostics without breaking FTS search. Historical QMD warnings remain available, while the active QMD status reflects the latest attempt: a later successful QMD query restores `qmd: ready`.

QMD file matches are exact-path based. The adapter calls `qmd query --full-path`; absolute filesystem paths are normalized and compared to allowed nonblocked `SKILL.md` file paths, and `./...` output is resolved against the QMD process cwd before exact matching. Default `qmd://...` URI output does not match, and the catalog does not use suffix guessing.

FTS-only ranking should remain useful without vector search. It should weight exact `name`, `triggers`, `when_to_use`, and `description` matches ahead of broad body text matches, then return transparent `matched_fields` and `why_match` values so agents can judge weak matches.

## Router Skill Behavior

The globally installed router skill should be small and strong, but not absolute.

Recommended rule:

> Before complex, unfamiliar, multi-step, high-risk, or domain-specific work, call `search_skills`. Skip search for trivial one-shot answers, obvious shell commands, or tasks already fully covered by active repo instructions. If the user names a skill, call `read_skill` directly.

V1 should ship the router skill as a static checked-in artifact. Template generation can wait until plugin packaging or multi-profile installs exist.

Install the router skill in shared skill locations first, especially `~/.agents/skills/skill-router`, because both Codex and OpenCode can read that location.

Do not install every cataloged skill into native Codex/OpenCode global skill folders. That would recreate the context problem.

## Codex and OpenCode Integration

Codex documented behavior:

- Skills start as metadata and full `SKILL.md` loads only when selected.
- The initial skills list has a context budget and very large sets may be shortened or omitted.
- MCP servers can be configured in `config.toml`.
- Plugins can package skills and MCP config later.

OpenCode documented behavior:

- OpenCode discovers skills from `.opencode/skills`, `.claude/skills`, `.agents/skills`, and global equivalents including `~/.agents/skills`.
- The native `skill` tool lists available skills and loads full content on demand.
- OpenCode plugins are JS/TS hooks and custom tools, not the same packaging model as Codex plugins.

V1 integration should avoid plugins. Ship:

- server config example
- shared `skill-router` skill
- Codex MCP config snippet
- OpenCode MCP config snippet
- optional one-line global `AGENTS.md` guidance

## Token-Cost Evaluation

The deterministic token-cost eval compares Skill Catalog MCP routing against native skill preload using only each skill's `name` and `description` as the portable native baseline. Extended Skill Catalog frontmatter such as `author`, `version`, `source`, `triggers`, `when_to_use`, and `when_not_to_use` is useful for catalog ranking, but it is not portable native preload metadata across Codex, OpenCode, and Claude Code.

The eval reports bytes, characters, and `ceil(characters / 4)` approximate tokens. It does not claim exact provider billing tokens because Codex, OpenCode, Claude Code, and arbitrary model providers do not expose one uniform authoritative tokenizer for this comparison.

Current result for the 67-skill first-party catalog:

- Native preload baseline: 15,531 characters for all skill names and descriptions.
- Static MCP routing session surface: 15,134 characters, or 397 characters cheaper than native preload.
- Router full body when triggered: 1,572 characters.
- Average `search_skills` call prompt-visible cost: 16,155 characters.
- Triggered discovery traces cheaper than native preload: 0/7.
- Triggered full-read traces cheaper than native preload: 0/7.
- All-trace cheaper count including the no-skill trivial trace: 1/8.

Conclusion: the current architecture keeps the native skill list small and improves centralized retrieval, but triggered routing is not yet token-cheaper with the rich `search_skills` response shape. V1.1 should design a compact `search_skills` mode or separate lightweight discovery tool, then rerun the deterministic eval before claiming token-cost savings for triggered routing.

## Management UI

Milestone 3 adds a small management UI for operating the MCP server. The UI is for server administration, not skill editing.

Expected capabilities:

- view configured roots, indexed skill counts, sync errors, metadata warnings, and duplicate names
- inspect search backend state for FTS and QMD
- run smoke searches and read checks against selected skills
- trigger a rebuild of derived SQLite index state from configured roots
- inspect recent audit events and QMD failure warnings
- view effective config for session mode, limits, roots, and QMD settings

V1 remains read-only for skill source files. The UI may manage derived server state and configuration, but it must not create, edit, or publish skill content until a registry/write workflow and quality gates exist.

## Reference Reads

`read_skill` returns only the full `SKILL.md`.

`read_skill_reference` reads a caller-provided relative path under the selected skill directory. The server must:

- resolve paths safely under the skill directory
- reject path traversal
- reject symlinks in v1
- never execute files
- inline only text-like content below configured limits
- return metadata for binary or oversized files

V1 should allow all file extensions under the skill directory, guarded by path, size, binary, and symlink checks.

## Future Backlog

The big-picture roadmap is tracked in [Roadmap](ROADMAP.md). In short:

- Active V1 live dogfood with Codex and OpenCode.
- First-party skill-library metadata cleanup complete; keep capturing real retrieval misses.
- V1.1 retrieval, token-cost, and operator-UX improvements.
- Registry and internal `skill-patch` workflow before source mutation.
- External import with security review before trust.
- MCP resources, prompts, and packaging after the tool contract is stable.
- Enterprise OAuth, ACLs, shared rate limiting, audit retention, and policy controls for shared deployments.

## Open Questions

- What exact QMD collection workflow should be used on the Mac Mini?
