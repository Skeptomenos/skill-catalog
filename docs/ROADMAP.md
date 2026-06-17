# Skill Catalog Roadmap

## Current Position

Skill Catalog V1 is operational. The service is a read-only MCP server with SQLite FTS search, optional QMD hybrid ranking, guarded skill and reference reads, auth/admin hardening, bounded sessions, audit/status visibility, a management UI, public split publishing, and a small native `skill-router` integration pattern for Codex and OpenCode.

The active product question is no longer "can the server work?" It is "does the catalog reliably improve real agent behavior while keeping native skill context small and keeping routing payloads cheaper than preloading native skill metadata?"

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

Goal: prove and improve the token economics and retrieval quality of Skill Catalog without adding write/import, wrapper-install, or security-review workflows.

Current token-cost baseline: the deterministic eval over the 67-skill first-party catalog shows static MCP routing exposure is 397 characters cheaper than native skill name/description preload, but triggered routing traces are 0/7 cheaper once router body and prompt-visible rich search responses are counted.

Scope:

- Keep or add deterministic routing/token-cost evals for native preload versus Skill Catalog MCP routing.
- Design a compact `search_skills` response mode or lightweight discovery tool if rich search payloads dominate routing cost.
- Measure router-body, static MCP manifest, search-result, read-result, and selected-skill payload costs separately.
- Revisit QMD/FTS score fusion with calibrated scoring instead of ad hoc score maxing.
- Add targeted ranking evals before changing ranking behavior.
- Design a metadata-only `read_skill` response for oversized `SKILL.md` files if read payload size becomes part of the token-cost problem.
- Keep trust ranking relevance-only until FTS and QMD scores are normalized enough for predictable trust-aware ranking.
- Do not add native wrapper installation, contribution, approval, import, security-review, or enterprise workflows in V1.1.

Exit criteria:

- Search/discovery payloads have a measured token-cost profile and do not defeat the router's context-saving purpose.
- Compact discovery has deterministic before/after eval evidence against the current rich response shape.
- Ranking changes are covered by query evals and do not bury strong exact metadata matches.
- Oversized skill behavior has a documented and tested contract if it is changed for token-cost reasons.

## Phase 4: Skill Generation, Registry, Contribution Proposals, And Skill Patch Workflow

Goal: introduce catalog-owned state needed for safe writes and contribution review later.

Scope:

- Add registry-owned persisted skill IDs and per-skill operational state.
- Add per-skill trust overrides and review history.
- Define the authoring flow for new skills, likely through a dedicated skill-generation skill or tool that writes drafts locally or opens Git-backed proposals.
- Create the internal `skill-patch` tool or skill for version-aware skill edits.
- Design a Git-backed contribution proposal path before direct server mutation.
- Add proposal validation for required frontmatter, source metadata, duplicate names, size/path policy, and SemVer-style version changes.
- Track proposal state, validation results, reviewer, timestamps, and audit trail as catalog-owned state.
- Use SemVer-style significance rules: patch for non-behavioral fixes, minor for compatible additions, major for breaking workflow changes.
- Keep direct UI/source mutation out of scope until the registry and patch workflow exist.

Exit criteria:

- Catalog state can distinguish portable frontmatter metadata from local operational state.
- Skill updates have an explicit review/version path.
- New and changed skills can be drafted, proposed, and validated without making unreviewed content available to normal agent search/read surfaces.
- Duplicate-name policy can be revisited with registry support.

## Phase 5: External Import, Contribution Approval, And Security Review

Goal: safely ingest and approve skills from contributors, Git repositories, npm workflows, websites, local catalogs, and remote catalogs.

Scope:

- Design import acquisition records and source metadata capture.
- Index unreviewed external skills as `review_required` with clear warnings.
- Add an automatic skill security review gate before contributed or external skills become trusted active catalog entries.
- Add ingestion-time secret scan, binary/symlink checks, dynamic-context detection, and script policy checks.
- Require human review for ambiguous instructions or executable content; automated review can flag risk but should not be treated as proof of script safety.
- Keep script execution prohibited.

Exit criteria:

- Contributed and external skills cannot become trusted without passing the review gate.
- Rejected or blocked skills remain visible to operators but unavailable to normal agent reads/searches.
- Source, review result, reviewer, timestamp, and audit trail are catalog-owned state.

## Phase 6: Native Skill/Slash-Menu Integration, Wrappers, And Packaging

Goal: preserve useful native client invocation affordances once generated/imported skills can be reviewed and trusted safely.

Scope:

- Design native wrapper skills for explicit invocation surfaces. In Codex, enabled local skills appear in the app slash command list and can be invoked through `/skills` or `$skill`; wrapper skills would be normal local skills that delegate to `read_skill`.
- Harden the internal `skill-install` helper into a supported wrapper install path only after trust, pinning, and packaging choices are settled.
- Generate wrappers only for a pinned trusted subset, not the full catalog.
- Evaluate wrapper token cost before any broad install/sync path.
- Add MCP resources such as `skill://name/SKILL.md` and reference URIs.
- Add MCP prompts for reusable router workflows if they prove useful.
- Add reference manifests and optional reference-file frontmatter.
- Add client integration for native wrapper generation/sync only after contribution/security workflows define trusted active skills.
- Evaluate Codex plugin packaging, Claude Code plugin/managed-policy packaging, and OpenCode plugin/enforcement hooks.
- Keep the public split repo a server-package-only distribution that includes Skill Catalog internal skills under `skills/`; broader native plugin or wrapper packaging requires a separate packaging decision.

Exit criteria:

- Resources improve browsing/read UX without replacing the stable V1 tools prematurely.
- Wrapper and packaging flows preserve explicit invocation UX without reintroducing native global skill bloat.
- Wrappers are generated only for trusted reviewed skills and can be reconciled against catalog version/hash state.

## Phase 7: Enterprise / Shared Server

Goal: support internal-company or multi-user deployment.

Scope:

- OAuth identity.
- ACLs by root, category, and skill.
- Strong auth-aware rate limiting through a reverse proxy, gateway, or shared store.
- Organization-wide audit retention and usage analytics.
- Stronger deployment controls and ingestion policy enforcement.

Exit criteria:

- Access decisions are identity-aware and auditable.
- Rate limits survive process restarts and work across replicas.
- Audit retention and policy controls meet internal shared-service expectations.
