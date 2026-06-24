# Skill Catalog Roadmap

## Current Position

Skill Catalog V1 is operational. The service is a read-only MCP server with SQLite FTS search, optional QMD hybrid ranking, guarded skill and reference reads, auth/admin hardening, bounded sessions, audit/status visibility, a management UI, public split publishing, and a small native `skill-router` integration pattern for Codex and OpenCode.

The active product question is no longer "can the server work?" It is "does the catalog reliably improve real agent behavior while keeping native skill context small and keeping routing payloads cheaper than preloading native skill metadata?"

## Cross-Phase Testing Requirement

Starting with V1.1, each roadmap phase must include a testing-expansion sub-batch before the phase is considered complete. The test suite should grow with the product surface instead of relying on the original V1 smoke gate.

Rules:

- Every new public MCP tool, HTTP/admin endpoint, config behavior, state transition, and security boundary needs tests at the same layer where agents or operators depend on it.
- Product behavior should be covered by real-runtime integration or smoke tests, not only mocked unit tests.
- `pnpm validate` remains the default regression gate unless a deliberately heavier test, such as browser automation, is documented as an explicit non-default gate.
- Each phase must document what is intentionally not tested yet because it belongs to a later product phase.

Phase-specific testing expectations:

- Phase 3 / V1.1: complete the P0/P1 server regression baseline, including real MCP SDK contract tests, admin API integration tests, read/reference edge cases, SQLite migration coverage, scanner edge cases, deterministic ranking fixtures, and QMD smoke coverage.
- Phase 4: add write-tool, registry, review-state, writable-root, package-path, full-package update, script-bearing review-required visibility, approval/rejection/change-request, and config overlay reload tests before treating the write-capable proof of concept as done.
- Phase 5: add external acquisition, provenance, security finding, secret/binary/symlink/script policy, blocked/rejected visibility, and import-review gate tests before server-owned import is considered safe.
- Phase 6: add Invocation Shortcut, wrapper content, pinned trusted subset, version/hash reconciliation, MCP resource/prompt, and packaging tests before native slash-menu integration is shipped.
- Phase 7: add OAuth, ACL, role-restricted review tool, shared rate-limit, audit-retention, and promotion-workflow tests before enterprise/shared-server deployment is accepted.

## Active Phase: V1 Live Dogfood

Goal: use Skill Catalog as the real local skill discovery layer for Codex and OpenCode.

Scope:

- Keep only `skill-router` installed in global native skill folders.
- Keep Codex and OpenCode connected to the Skill Catalog MCP server.
- Use real ai-dev work to collect retrieval misses, weak rankings, confusing warnings, admin friction, and config/runtime issues.
- Rebuild the index after skill-library changes and inspect warnings from `/admin`.

Exit criteria:

- Codex and OpenCode can both call the MCP server in normal sessions.
- The router consistently triggers catalog search for complex, unfamiliar, multi-step, high-risk, or domain-specific work.
- Dogfood misses are captured as concrete queries with expected skills.
- No V1 read-only boundary regressions are found.

## Completed Phase 2: Skill Library Quality

Goal: make the existing skill corpus easier to retrieve and safer to operate.

Completed scope:

- Add missing `author`, `version`, and `source` frontmatter to remaining first-party skills.
- Add or improve `triggers`, `when_to_use`, `when_not_to_use`, and `category` on routing-critical skills.
- Build a small query-eval set from dogfood misses.
- Keep external or unreviewed roots surfaced as `review_required`, not silently trusted.

Exit criteria met:

- High-value skills have clean metadata-warning rows.
- Repeated dogfood prompts route to expected skills in top results.
- Remaining warnings are either low-priority legacy cleanup or intentionally external/unreviewed content.

## Phase 3: V1.1 Token Efficiency And Retrieval Evals

Goal: prove and improve the token economics and retrieval quality of Skill Catalog without adding write/import, shortcut-install, or security-review workflows.

Current token-cost baseline: the deterministic eval over the 67-skill first-party catalog shows static MCP routing exposure is 397 characters cheaper than native skill name/description preload, but triggered routing traces are 0/7 cheaper once router body and prompt-visible rich search responses are counted.

Scope:

- Keep or add deterministic routing/token-cost evals for native preload versus Skill Catalog MCP routing.
- Design a compact `search_skills` response mode or lightweight discovery tool if rich search payloads dominate routing cost.
- Measure router-body, static MCP manifest, search-result, read-result, and selected-skill payload costs separately.
- Revisit QMD/FTS score fusion with calibrated scoring instead of ad hoc score maxing.
- Add targeted ranking evals before changing ranking behavior.
- Complete the P0/P1 server regression coverage plan before expanding the public product surface beyond current read-only tools.
- Design a metadata-only `read_skill` response for oversized `SKILL.md` files if read payload size becomes part of the token-cost problem.
- Keep trust ranking relevance-only until FTS and QMD scores are normalized enough for predictable trust-aware ranking.
- Do not add native Invocation Shortcut installation, contribution, approval, import, security-review, or enterprise workflows in V1.1.

Exit criteria:

- Search/discovery payloads have a measured token-cost profile and do not defeat the router's context-saving purpose.
- Compact discovery has deterministic before/after eval evidence against the current rich response shape.
- Ranking changes are covered by query evals and do not bury strong exact metadata matches.
- Oversized skill behavior has a documented and tested contract if it is changed for token-cost reasons.

## Phase 4: Skill Contribution, Registry, MCP Write Tools, And Lightweight Review POC

Goal: introduce a write-capable Skill Catalog proof of concept that helps agents create, update, validate, store, and lightly review skills through MCP tools backed by registry and guardrail state.

Scope:

- Add registry-owned persisted skill IDs, current root/path mapping, parsed metadata, review IDs, and per-skill operational state.
- Add per-skill trust overrides and review history.
- Add configurable catalog-managed writable skill roots for write tools; keep skill bodies as files while SQLite stores registry, approval, review, audit, and index state.
- Restrict `create_skill` and `update_skill` to roots explicitly configured as writable; allow multiple writable roots later as the skill library grows.
- Require `create_skill.target_root` when multiple writable roots exist; default only when exactly one writable root exists.
- Define the write flow for new and changed skills through MCP tools rather than local-only scripts.
- Add internal Skill Catalog authoring/contribution guidance so agents know how to structure, frontmatter, test, and submit Skill Packages through the write tools.
- Add internal Skill Catalog review guidance so a user can ask a separate agent to inspect a review-required package, write an assessment, and call the appropriate review tool.
- Keep external intake skill-assisted in Phase 4: an agent may fetch/inspect external content and submit a package, but Skill Catalog does not yet own server-side GitHub/npm/website import automation.
- Make write-tool inputs package-first: complete `SKILL.md` plus optional companion files, with only minimal structured routing metadata such as `name`, `target_root`, and optional `package_path`.
- Support nested safe `package_path` values for grouped libraries, while keeping `name` globally unique across roots.
- Forbid nested skill packages in the same root; group directories may contain packages, but package paths cannot be ancestors or descendants of each other.
- Add `create_skill`, `update_skill`, `list_skill_reviews`, `get_skill_review`, `approve_skill`, `reject_skill`, and `request_skill_changes` tools for the single-person proof of concept.
- Add `dry_run: true` preflight validation to `create_skill` and `update_skill` instead of adding a separate public validation tool in Phase 4.
- Create the internal `skill-patch` tool or skill for version-aware edit planning and compatibility checks.
- Keep `update_skill` as full-package replacement in the proof of concept; avoid low-level patch/merge semantics in the server API.
- Delete omitted companion files during full-package `update_skill`; dry runs should report added, updated, and deleted files.
- Keep `update_skill` from renaming or moving skills in Phase 4; create a new skill and reject/block the old one for migration-style changes.
- Reset trusted skills to `review_required` with a new pending review whenever `update_skill` replaces their package.
- Support companion files in Skill Packages, including references, docs, and scripts; Skill Catalog must store and review scripts without executing them.
- Add validation for required frontmatter, source metadata, duplicate names, size/path policy, and SemVer-style version changes.
- Add first validation and security checks for created and updated skills, returned as MCP tool results.
- Classify findings as `info`, `warning`, or `blocking`; `approve_skill` must reject review IDs with unresolved blocking findings.
- Accept optional `actor` strings on write and review tools for audit metadata, with a server fallback when omitted.
- Require `approval_note` when approving reviews with warnings; make it optional for clean or info-only approvals.
- Require reviewer assessment text for `reject_skill` and `request_skill_changes`.
- Refuse mutation when `create_skill` or `update_skill` produces blocking findings; return findings with `written: false`.
- Index created and updated skills as `review_required` until `approve_skill` marks them `trusted`.
- Do not add `auto_approve` to write tools in Phase 4; approval should remain a separate MCP action.
- Hide review-required Skill Packages that contain scripts from normal search/read/reference surfaces until approval, regardless of the review-required visibility policy.
- Add a narrow review surface over registry review records, without creating a separate candidate subsystem or workflow engine.
- Keep roles, users, SSO, and authorization out of Phase 4; actor metadata is not access control.
- `request_skill_changes` hides the current package from normal search/read until a new `update_skill` review; `reject_skill` marks the package blocked and review/admin-only.
- Keep rejected package files in place for audit, diagnostics, and Git inspection; defer archival/purge policies.
- Keep rejected package names reserved in the proof of concept; retry rejected skills through `update_skill`, not duplicate `create_skill`.
- Record durable review events for create, update, approve, reject, and change-request actions so later webhook/ticket/Slack integrations have an architectural hook.
- Keep `review_required` skills visible by default in normal search/read surfaces, with config-file and admin-UI controls to hide them from normal agent-facing retrieval.
- Persist admin-driven config changes in a durable config overlay file, not SQLite runtime overrides; effective config should show the source layer for each value.
- Require explicit reload or restart for config overlay changes; reload validates the full effective config and keeps the current runtime config active if validation fails.
- Track validation results, security findings, review IDs, timestamps, actor strings where available, and audit trail as catalog-owned state.
- Expose review tools to all configured MCP clients in the single-person app; same-person contribution and review is allowed, and admin/reviewer role restrictions are deferred to enterprise.
- Use SemVer-style significance rules: patch for non-behavioral fixes, minor for compatible additions, major for breaking workflow changes.
- Keep direct UI mutation out of scope until the MCP write tools and registry/security gates are battle tested.
- Keep catalog-native version control, historical revision browsing, and staging/production skill environments out of scope; Git remains the version-control mechanism for skill source changes.
- Keep strict content-digest-gated approval out of scope for the single-person proof of concept; defer it to more sophisticated review or enterprise promotion workflows.
- Keep formal contribution proposals, enforced independent review, skill revision workflows, and personal-to-shared promotion out of scope for the single-user proof of concept.

Exit criteria:

- Catalog state can distinguish portable frontmatter metadata from local operational state and review IDs.
- Skill creation and updates go through explicit MCP write and validation steps with findings returned through tool results; review remains a lightweight, user-and-agent-driven state transition.
- New and changed skills cannot become `trusted` until `approve_skill` succeeds with the latest `review_id`.
- Skills with unresolved blocking findings cannot be approved.
- Script-bearing skills are not normal agent-facing until approved.
- Changes-requested and rejected packages are not normal agent-facing.
- Duplicate-name policy can be revisited with registry support.

## Phase 5: Server-Owned External Import And Security Review

Goal: safely ingest and review skills from Git repositories, npm workflows, websites, local catalogs, and remote catalogs through server-owned acquisition workflows.

Scope:

- Design import acquisition records and source metadata capture.
- Index unreviewed external skills as `review_required` with clear warnings.
- Add an automatic skill security review gate before external skills become trusted active catalog entries.
- Add ingestion-time secret scan, binary/symlink checks, dynamic-context detection, and script policy checks.
- Require human review for ambiguous instructions or executable content; automated review can flag risk but should not be treated as proof of script safety.
- Keep script execution prohibited.

Exit criteria:

- External skills cannot become trusted without passing the review gate.
- Rejected or blocked skills remain visible to operators but unavailable to normal agent reads/searches.
- Source, review result, reviewer, timestamp, and audit trail are catalog-owned state.

## Phase 6: Native Skill/Slash-Menu Integration, Invocation Shortcuts, And Packaging

Goal: preserve useful native client invocation affordances once generated/imported skills can be reviewed and trusted safely.

Scope:

- Design Invocation Shortcuts for explicit invocation surfaces. In Codex, enabled local skills appear in the app slash command list and can be invoked through `/skills` or `$skill`; a Codex shortcut would be a normal local skill that delegates to `read_skill`.
- Treat `install-slash-command` as the future user-facing product action for creating an Invocation Shortcut.
- Harden the internal `skill-install` helper into a supported shortcut install path only after trust, pinning, and packaging choices are settled.
- Generate shortcuts only for a pinned trusted subset, not the full catalog.
- Evaluate shortcut token cost before any broad install/sync path.
- Add MCP resources such as `skill://name/SKILL.md` and reference URIs.
- Add MCP prompts for reusable router workflows if they prove useful.
- Add reference manifests and optional reference-file frontmatter.
- Add client integration for native shortcut generation/sync only after contribution/security workflows define trusted active skills.
- Evaluate Codex plugin packaging, Claude Code plugin/managed-policy packaging, and OpenCode plugin/enforcement hooks.
- Keep the public split repo a server-package-only distribution that includes Skill Catalog internal skills under `skills/`; broader native plugin or shortcut packaging requires a separate packaging decision.

Exit criteria:

- Resources improve browsing/read UX without replacing the stable V1 tools prematurely.
- Shortcut and packaging flows preserve explicit invocation UX without reintroducing native global skill bloat.
- Shortcuts are generated only for trusted reviewed skills and can be reconciled against catalog version/hash state.

## Phase 7: Enterprise / Shared Server

Goal: support internal-company or multi-user deployment.

Scope:

- OAuth identity.
- ACLs by root, category, and skill.
- Personal, team, department, and company shared skill library scopes.
- Formal contribution proposals, skill revisions, and promotion workflows from personal skills to broader shared libraries.
- Strict content-digest approval for promoted or shared skills.
- Strong auth-aware rate limiting through a reverse proxy, gateway, or shared store.
- Organization-wide audit retention and usage analytics.
- Review event webhooks or workflow integrations for ticket systems, Slack, and similar tools.
- Stronger deployment controls and ingestion policy enforcement.

Exit criteria:

- Access decisions are identity-aware and auditable.
- Skills can move between library scopes only through reviewed promotion workflows.
- Rate limits survive process restarts and work across replicas.
- Audit retention and policy controls meet internal shared-service expectations.

## Future Feature Requests - Unplanned

- Add `skills.sh` API support as an external catalog source. Skill Catalog should be able to resolve a `skills.sh` skill identifier or URL, fetch authenticated API metadata and file contents when credentials are configured, preserve upstream source/audit/hash metadata as review evidence, and route the resulting package through the same external contribution/import guardrails. This is not part of Phase 4 or Phase 5.
