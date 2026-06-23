# Skill Catalog Design

## Problem

Codex and OpenCode already support skill progressive disclosure, but they still expose available skill metadata up front. With a large global library, that initial metadata list consumes context, can be shortened or omitted, and can make skill selection less reliable.

The desired system is a central catalog that agents can query only when useful. Agents should start with a tiny router skill and a small MCP surface, then search the catalog before complex work. Later phases can preserve native client invocation affordances, but V1.1 should first prove the token and retrieval economics of the catalog path.

## Product Shape

Skill Catalog is a read-only MCP server for skill discovery and retrieval.

V1 indexes configured skill roots and exposes a small set of tools:

- `search_skills` returns selection metadata only.
- `read_skill` returns the full `SKILL.md` for a chosen skill.
- `read_skill_reference` returns a referenced file inside a skill directory.
- `skill_catalog_status` reports sync/index health.

The service does not execute skills. Skills remain instructions and resources that the calling agent reads and applies.

V1 does not install skills into client machines and does not accept contributions. Later registry and contribution workflows can add controlled writes and review state after the read-only retrieval contract is stable. Client-side Invocation Shortcut generation should wait until generated or imported skills can be reviewed and trusted.

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
- bundled integration artifacts, including `integrations/skill-router/`
- private skill-library, external imported, or fixture skill content
- monorepo-only agent instructions

The public repo is a server-package-only copy of this project for people outside the private `ai-dev` monorepo. It should contain the server source, package metadata, config examples, docs, operational README content, and Skill Catalog internal skills under `skills/`. It should not publish private planning, private or external skill-library contents, Codex plugin packaging, or bundled integration artifacts.

## Skill Roots

Skill roots are explicit config entries. V1 begins with:

```text
${AI_DEV_ROOT}/_infra/skill-catalog/skills
${AI_DEV_ROOT}/_infra/skills/skills
```

The `skill-catalog/skills` root contains first-party internal Skill Catalog skills that ship with the product and must always be indexed by a Skill Catalog install. The shared/private skill library root is a separate catalog input. The service must not crawl arbitrary home directories or client machines. Each configured root has a stable root name and path.

Phase 4 write tools must write only to roots explicitly configured as writable. Read/index roots and writable roots are separate by default so MCP write tools cannot accidentally mutate internal product skills, private library skills, or external synced skills. A future Skill Catalog deployment may configure multiple writable roots for larger skill libraries.

When exactly one writable root exists, `create_skill` may default to it. When multiple writable roots exist, `create_skill` must require a `target_root` input rather than inferring placement from category or source metadata. Within the selected root, `create_skill` may accept an optional `package_path` for curated grouping. If omitted, the catalog derives the package path from `name`; if provided, nested safe paths such as `gog-cli/drive` are allowed. Group folders may contain multiple skill packages, but skill packages must not be nested inside other skill packages.

## Skill Identity

V1 enforces globally unique skill names across all configured roots.

Each indexed skill has:

- `id`: generated stable identifier.
- `name`: required frontmatter value, globally unique.
- `category`: derived from nested path or frontmatter.
- `source_root`: configured root name.
- `relative_path`: path from root to the skill directory.

Duplicate names are sync errors and must appear in `skill_catalog_status`.

Later registry work can replace generated IDs with persisted registry IDs and source metadata. The registry should remain a current-state operational model: stable skill identity, current root/path mapping, current parsed metadata, trust/review state, lightweight review IDs, and audit state. It should not become catalog-native version control, a historical revision browser, or a staging/production deployment system for skills. Git remains the version-control mechanism for source changes.

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

External sourcing has three separate paths:

- Indexed External Root: a configured root that already contains externally sourced skills on disk. The catalog scans it, usually as `review_required`, but does not own acquisition.
- Skill-Assisted External Intake: a Phase 4 agent workflow that fetches/inspects external content, normalizes it into a Skill Package, and submits it through `create_skill`.
- External Import: a later server-owned workflow where Skill Catalog resolves a source, fetches files, records acquisition metadata, runs import/security checks, and integrates the package.

Later External Import workflows should run a skill security review before external skills become trusted active catalog entries. After that gate exists, imported active catalog skills should be trusted by construction because external imports must pass the review before integration.

Trust and review status are catalog-owned state, not portable skill frontmatter. Frontmatter carries portable facts such as `name`, `description`, `author`, `version`, and `source`. Catalog responses add local operational facts such as `source_root`, `trust_status`, review warnings, actor string where available, timestamp, and audit trail.

Trust status values are `trusted`, `review_required`, and `blocked`. `review_required` means catalog trust is not satisfied yet. In Phase 4 it is a lightweight one-person review nudge and guardrail state; in later import phases it may also reflect a real security-review gate. `blocked` is an active deny state: blocked skills remain indexed for status and admin diagnostics, but they are excluded from normal `search_skills` results and rejected by skill/reference read surfaces.

Default trust status should come from root configuration, not frontmatter alone. A curated local root can default to `trusted`, while an external cloned/npm-synced root can default to `review_required`. Later catalog-owned per-skill review state can override the root default.

```yaml
roots:
  - name: skill-catalog-internal-skills
    path: ${AI_DEV_ROOT}/_infra/skill-catalog/skills
    default_trust_status: trusted
  - name: ai-dev-skills
    path: ${AI_DEV_ROOT}/_infra/skills/skills
    default_trust_status: trusted
  - name: external-mattpocock
    path: ~/skills/external/mattpocock
    default_trust_status: review_required
```

V1 search ranking should remain relevance-only. `review_required` skills can appear in `search_skills` results, but ranking should not be adjusted by trust until scores are normalized well enough to avoid burying stronger external matches. V1 should surface trust warnings in result metadata instead.

Phase 4 should keep `review_required` visible by default for the single-person proof of concept, matching the current soft-gate model. That visibility must become configurable through the config file and the admin UI. When disabled, normal `search_skills` and `read_skill` should behave as if `review_required` skills are not agent-facing, while status/admin diagnostics still show them. `blocked` remains excluded and rejected regardless of this setting.

Review-required Skill Packages that contain scripts are the exception to the default-visible soft gate: they should remain visible in status/admin diagnostics but excluded from normal `search_skills`, `read_skill`, and `read_skill_reference` until approved. This keeps Phase 4 technically simple without pretending the first script review is comprehensive.

Admin UI configuration changes should write a durable config overlay file, not SQLite runtime overrides. Overlay changes should require an explicit reload or service restart before they affect runtime behavior. Reload should validate the full effective config first; validation failure leaves the current runtime config active and reports errors. Skill Catalog is intended to be AI-native, so coding agents should be able to inspect, edit, diff, and review configuration as files. SQLite remains operational state for registry, index, review, and audit data.

`blocked` is not a ranking adjustment. It is filtered before results reach normal agent-facing search and read tools.

## Skill Contribution Pipeline And Lightweight Review

A useful catalog eventually needs a way to create, validate, review, approve, and make skills trusted/active in the local catalog. That is not V1.1. The near-term product remains a single-person system, but the write-capable proof of concept should still go through Skill Catalog MCP tools rather than local-only scripts. The catalog should be the server that indexes, provides, stores, and flags skills with guardrails; contribution authoring and review assessment happen between the user and their agent.

Phase 4 should separate three concerns:

1. Contribution workflow: an internal Skill Catalog authoring/contribution skill teaches an agent how to structure a skill, write required frontmatter, include companion files, test the skill, and call `create_skill` or `update_skill`.
2. Server guardrails: MCP tools validate package shape, paths, metadata, size, duplicate names, scripts, and obvious risk; then they write to catalog-managed roots when there are no blocking findings.
3. Lightweight review workflow: an internal Skill Catalog review skill teaches an agent how to inspect a review-required package, produce an assessment, and call `approve_skill`, `reject_skill`, or `request_skill_changes`.

This is intentionally not a workflow engine. In the one-person app, self-authored skills and externally sourced skills use the same catalog state, but external skills and script-bearing packages should be more likely to need review. The server nudges with `review_required`, findings, visibility rules, and audit records. It does not run an internal reviewing agent, prompt-inject review feedback into sessions, or prevent the same person from contributing and approving. Hard reviewer separation belongs to a later multi-user/enterprise phase.

The registry should track current catalog-visible state, not a catalog-native revision graph. For the single-person proof of concept, lightweight review IDs are enough to tie `approve_skill` to the latest validation/security result without inventing a staging/production skill deployment model. Strict content-digest-gated approval can wait until a more sophisticated review or enterprise promotion pipeline exists.

Skill packages should remain filesystem artifacts in catalog-managed writable skill roots. `create_skill` and `update_skill` write `SKILL.md` and allowed companion files only under roots configured as writable. Their input should be package-first: a small amount of routing metadata such as `name`, optional `target_root`, and optional `package_path`, complete `SKILL.md` text, and optional companion files. The server parses the submitted frontmatter and validates it against structured routing fields; it should not synthesize `SKILL.md` from separate `description`, `triggers`, `version`, or similar fields. `name` is the globally unique skill identity. `package_path` is optional filesystem placement relative to the selected writable root, allowing grouped packages such as `gog-cli/drive/SKILL.md` for a skill named `gog-cli-drive`. A package path must not be an ancestor or descendant of another package path in the same root, because that would make another skill's `SKILL.md` part of the parent skill's reference boundary. Phase 4 packages should support companion files such as references, docs, and scripts, commonly under `references/`, `docs/`, and `scripts/`. SQLite stores registry state, review IDs, approval state, audit events, warnings, and search indexes. Write and review tools may accept optional `actor` strings for audit metadata because the one-person system can still use different AI agents for contribution and review. Actor metadata should default to a server fallback when omitted and must not become authorization state. `create_skill` uses the only writable root by default, or requires `target_root` when multiple writable roots exist. This preserves Git diffs, direct filesystem inspection, compatibility with current skill formats, and rebuildability. Full-package replacement should remove omitted companion files from the existing skill directory so stale files cannot remain after review.

Near-term single-user contribution pipeline:

1. `create_skill` writes a new catalog-managed skill through MCP from complete package content, not from server-rendered metadata fields.
2. `update_skill` replaces the full catalog-managed Skill Package through MCP: complete `SKILL.md` plus allowed companion files, including references, docs, and scripts. Companion files omitted from the submitted package are deleted from the existing skill directory. It must not rename or move the skill by changing `name`, `target_root`, or `package_path`. If the previous package was `trusted`, the replacement immediately resets trust to `review_required`, creates a new pending review, and returns a new `review_id`.
3. The catalog validates required metadata, source metadata, duplicate names, size limits, path layout, and SemVer-style version changes.
4. The catalog runs a first validation/security check focused on storage safety and obvious risk: path validation, size limits, secret scans, binary and symlink policy, dynamic-context detection, and script presence/policy findings.
5. `create_skill` and `update_skill` support `dry_run: true`, returning validation and security findings plus a manifest diff without writing files, creating review records, or mutating indexes.
6. Blocking findings prevent mutation. Non-dry-run `create_skill` and `update_skill` calls with blocking findings return validation and security findings with `written: false`, but do not write files, create review records, or mutate indexes.
7. Non-dry-run `create_skill` and `update_skill` calls without blocking findings return validation and security findings plus a `review_id` in the MCP result. The calling agent relays those findings to the user; the server does not need an internal agent runtime or prompt-injection mechanism.
8. New or changed skills are indexed as `review_required` until approved. This is a soft review gate: review-required skills may remain searchable/readable with warnings, but they are not trusted. Review-required skills with scripts are hidden from normal search/read/reference surfaces until approved.
9. `create_skill` and `update_skill` do not support `auto_approve`; approval remains a separate `approve_skill` action.
10. Findings use `info`, `warning`, and `blocking` severity. `approve_skill` may accept `info` and `warning` findings, but it must reject any review ID with unresolved `blocking` findings. `approval_note` is required when warnings are present and optional when only info findings or no findings exist.
11. `list_skill_reviews` returns the lightweight review surface, with filters for review status, trust status, root, and whether scripts are present.
12. `get_skill_review` provides a narrow review-only read surface for a `review_id`, returning review findings, trust state, package manifest, `SKILL.md`, and selected companion previews needed for approval.
13. `approve_skill` accepts the latest `review_id`, records the approval decision, and changes the skill to `trusted`.
14. `request_skill_changes` requires and records reviewer assessment text, sets review status to `changes_requested`, keeps trust status as `review_required`, and hides the current package from normal search/read/reference surfaces until `update_skill` creates a new pending review.
15. `reject_skill` requires and records reviewer assessment text, sets review status to `rejected`, sets trust status to `blocked`, and keeps the package visible only in review/admin diagnostics. It does not delete or move package files in the proof of concept, and the rejected package keeps its skill name reserved.
16. The catalog records validation results, security findings, timestamps, review ID, review status, actor string where available, and audit history as catalog-owned registry state.

Retrying a rejected skill should use `update_skill` on the rejected package, which creates a new pending review. `create_skill` should continue treating the rejected package name as occupied; allowing a second package with the same public name would require candidate/revision semantics that are out of scope for the proof of concept. Rename or move flows should create a new skill at the new name/path and then reject or block the old one; first-class migration tools belong after the proof of concept.

Initial blocking findings should focus on server and package integrity: duplicate names, invalid paths, missing required `name` or `description`, oversized `SKILL.md`, unsafe `package_path`, nested package boundary conflicts, symlinks, binary files, secret scan hits, and path traversal risk. Script presence should produce review findings and hide the skill from normal search/read until approval, but it should not be blocking by itself in Phase 4.

Replacement deletes should be constrained to the existing skill directory. Symlinks, path traversal, and unsafe paths remain blocking findings, and review results should explicitly call out deleted scripts or references.

Formal multi-user contribution proposals, skill revisions, and promotion workflows belong to an enterprise phase after identity and library scopes exist. At that scale, a company may distinguish personal, team, department, and company shared skill libraries, then promote skills from personal to broader shared scopes through a reviewed process.

The server should not pretend that script safety can be fully automated. Phase 4 script checks should stay modest and focus on surfacing review findings. Deeper script security belongs to Phase 5. Skill Catalog may store, review, and serve scripts as companion files after approval, but it must not execute scripts found in skill folders.

This pipeline should introduce tools only after the registry/security model is designed. Single-user POC tools include `create_skill`, full-package `update_skill`, `list_skill_reviews`, `get_skill_review`, `approve_skill`, `reject_skill`, and `request_skill_changes`, but the review tools should stay small state-transition APIs rather than becoming an application workflow engine. Keep preflight validation as `dry_run: true` on `create_skill` and `update_skill` rather than adding a separate public validation tool in Phase 4. Keep the flow linear: create/update returns a review ID, review records can be listed later, review inspection reads that ID, and approve/reject/change-request tools write the assessment back to the catalog. Internal Skill Catalog skills should carry the agent-facing workflow instructions for skill authoring, external skill intake, and skill review. The `skill-patch` helper can help an agent plan version-aware edits and produce the replacement package, but the server API should avoid low-level patch/merge semantics in the proof of concept. Enterprise-only tools may later include `submit_skill_proposal`, `review_skill_proposal`, and `promote_skill`. They should not be added to the V1.1 MCP surface because every added public tool increases static MCP token cost.

In the one-person application, review tools may be exposed to every configured MCP client and used by the same human through a different AI agent. Later enterprise deployments should put `list_skill_reviews`, `get_skill_review`, `approve_skill`, `reject_skill`, and `request_skill_changes` behind admin or skill-reviewer roles. Phase 4 `actor` strings are audit metadata, not a role or authorization model.

Review workflow integrations should be event-based. Phase 4 should record durable review events when skills are created, updated, approved, rejected, or sent back for changes. Later phases can forward those events through webhooks into ticket systems, Slack, or similar workflow tools.

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

## Native Skill, Slash-Menu, And Invocation Shortcut Compatibility

Skill Catalog's central retrieval model creates a local-invocation gap: some clients expose installed local skills in command menus or explicit mention pickers. A user may want `/deploy`, `/code-review`, or `$prd` to remain visible even if the real skill body lives behind `read_skill`.

Official behavior differs by client:

- Codex skills are available in the CLI, IDE extension, and app. Codex starts with each skill's `name`, `description`, and file path, then loads the full `SKILL.md` when selected. In CLI/IDE, explicit invocation is through `/skills` or `$skill`. In the Codex app, enabled skills also appear in the slash command list, so a visible app slash entry is still just a local enabled skill; no separate command file is required.
- Claude Code skills are directly invokable as `/skill-name`. The command name comes from the skill directory or command file path, not usually from frontmatter `name`. Existing `.claude/commands/*.md` files still work, but skills are the recommended richer format.
- OpenCode exposes native skills through its skill tool and supported skill directories.

An Invocation Shortcut is a client-local entry that exists only to appear in a client's native command, slash menu, or skill picker and route explicit invocation to a fixed catalog skill. For Codex and OpenCode this can be implemented as a tiny local `SKILL.md` wrapper that instructs the agent to call `read_skill`. It should not copy the full skill body, references, scripts, or assets.

Broad Invocation Shortcut sync is not V1.1. Skill Catalog may ship a small internal `skill-install` helper because it is client-local tooling that writes an explicit shortcut only when invoked, but broad shortcut generation should come after skill-generation/contribution and security-review workflows. That broader surface should expose only trusted reviewed catalog skills, not arbitrary unreviewed content.

Invocation Shortcut requirements:

- generated only for explicitly pinned high-value skills, not the whole catalog
- includes minimal `name` and `description`
- includes no scripts, dynamic shell injection, references, or assets
- names the catalog skill and MCP tool dependency clearly
- sets client-specific no-implicit-invocation metadata where supported, such as Codex `agents/openai.yaml` `allow_implicit_invocation: false` and Claude Code `disable-model-invocation: true`
- carries source/provenance metadata linking back to the catalog skill ID, version, and content hash
- refuses to install shortcuts for `blocked` skills or skills without a stable trusted/reviewed state once registry review exists

Invocation Shortcut risks:

- Every shortcut still creates native metadata cost. For Codex especially, local `SKILL.md` shortcuts still contribute to the initial skills list even if the real skill body is remote. Shortcut work must include token-cost evals before claiming this improves UX without losing the context-budget benefit.
- Shortcut content can drift from the catalog skill version unless it records and reconciles a catalog version/hash.
- Shortcut installation writes to client-local skill directories, so it is not a read-only server feature. Broad automated installation belongs with packaging/client-integration work, not V1.1 retrieval.
- Claude Code supports dynamic shell injection in skill content. Generated shortcuts must never use it, and enterprise deployments should prefer managed policy that disables shell expansion for untrusted user/project skills.

The internal `skill-install` helper is a narrow local script-plus-skill for dogfood and explicit installs. The future user-facing product action should be named `install-slash-command`, while the domain object it creates is an Invocation Shortcut. Production shortcut tooling still needs a later decision on whether shortcuts are generated by a local CLI, Codex plugin, Claude plugin/managed policy, or a future server-assisted client integration.

## Codex, Claude Code, and OpenCode Integration

Codex documented behavior:

- Skills start as metadata and full `SKILL.md` loads only when selected.
- The initial skills list has a context budget and very large sets may be shortened or omitted.
- Explicit invocation in CLI/IDE uses `/skills` or `$skill`.
- In the Codex app, enabled skills also appear in the slash command list.
- MCP servers can be configured in `config.toml`.
- Plugins can package skills and MCP config later.
- `agents/openai.yaml` can disable implicit invocation while preserving explicit `$skill` invocation.

Claude Code documented behavior:

- Skills create `/skill-name` commands and can also be invoked automatically when relevant.
- Custom commands have been merged into skills; existing `.claude/commands/` files still work.
- Skill command names usually come from the directory or command file path rather than frontmatter `name`.
- `disable-model-invocation: true` makes a skill manual-only.
- Skill content can run dynamic shell preprocessing unless disabled by policy.

OpenCode documented behavior:

- OpenCode discovers skills from `.opencode/skills`, `.claude/skills`, `.agents/skills`, and global equivalents including `~/.agents/skills`.
- The native `skill` tool lists available skills and loads full content on demand.
- OpenCode plugins are JS/TS hooks and custom tools, not the same packaging model as Codex plugins.

V1 integration should avoid plugins. Ship:

- server config example
- shared `skill-router` skill
- Codex MCP config snippet
- OpenCode MCP config snippet
- Claude Code compatibility notes, but no broad Invocation Shortcut installation
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

Invocation Shortcut evals are a later packaging/integration concern, separate from V1.1 catalog-routing evals. A shortcut-only scenario can improve explicit invocation UX while still being net-worse on context cost if many shortcuts are installed.

## Management UI

V1 includes a small management UI for operating the MCP server. The UI is for server administration, not skill editing.

Expected capabilities:

- view configured roots, indexed skill counts, sync errors, metadata warnings, and duplicate names
- inspect search backend state for FTS and QMD
- run smoke searches and read checks against selected skills
- trigger a rebuild of derived SQLite index state from configured roots
- inspect recent audit events and QMD failure warnings
- view effective config for session mode, limits, roots, QMD settings, config overlay path, and source layer per value
- write config overlay changes and explicitly reload them after validation
- configure whether `review_required` skills are visible in normal search/read surfaces once registry/write workflows exist

V1 remains read-only for skill source files. The UI may manage derived server state and configuration, but it must not create, edit, or make skill content trusted/active until a registry/write workflow and quality gates exist.

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
- V1.1 token-efficiency and retrieval evals.
- Registry and guardrails before MCP write tools mutate skill storage.
- Single-user `create_skill`, `update_skill`, lightweight review surface, and MCP contribution pipeline after registry-owned current-state records exist.
- External import with security review before trust.
- Native skill/slash-menu Invocation Shortcut integration after generation and security-review workflows.
- MCP resources, prompts, and packaging after the tool contract is stable.
- Enterprise OAuth, ACLs, library scopes, skill promotion workflows, shared rate limiting, audit retention, and policy controls for shared deployments.

## Open Questions

- What exact QMD collection workflow should be used on the Mac Mini?
- For enterprise contribution, should the first promotion path be Git pull requests only, or should the server own proposal storage after SSO and library scopes exist?
