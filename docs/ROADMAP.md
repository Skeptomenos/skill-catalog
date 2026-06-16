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

## Phase 3: V1.1 Retrieval, Token Cost, And Operator UX

Goal: improve selection quality and day-to-day operation without adding write/import workflows.

Scope:

- Keep or add deterministic routing/token-cost evals for native preload versus Skill Catalog MCP routing.
- Design a compact `search_skills` response mode or lightweight discovery tool if rich search payloads dominate routing cost.
- Revisit QMD/FTS score fusion with calibrated scoring instead of ad hoc score maxing.
- Add targeted ranking evals before changing ranking behavior.
- Design a metadata-only `read_skill` response for oversized `SKILL.md` files.
- Improve admin warning detail, smoke checks, and runtime diagnostics based on dogfood.
- Keep trust ranking relevance-only until FTS and QMD scores are normalized enough for predictable trust-aware ranking.

Exit criteria:

- Search/discovery payloads have a measured token-cost profile and do not defeat the router's context-saving purpose.
- Ranking changes are covered by query evals and do not bury strong exact metadata matches.
- Admin UI explains actionable warnings and backend health without exposing edit/import controls.
- Oversized skill behavior has a documented and tested contract.

## Phase 4: Registry And Skill Patch Workflow

Goal: introduce catalog-owned state needed for safe writes later.

Scope:

- Add registry-owned persisted skill IDs and per-skill operational state.
- Add per-skill trust overrides and review history.
- Create the internal `skill-patch` tool or skill for version-aware skill edits.
- Use SemVer-style significance rules: patch for non-behavioral fixes, minor for compatible additions, major for breaking workflow changes.
- Keep direct UI/source mutation out of scope until the registry and patch workflow exist.

Exit criteria:

- Catalog state can distinguish portable frontmatter metadata from local operational state.
- Skill updates have an explicit review/version path.
- Duplicate-name policy can be revisited with registry support.

## Phase 5: External Import And Security Review

Goal: safely ingest skills from Git repositories, npm workflows, websites, local catalogs, and remote catalogs.

Scope:

- Design import acquisition records and source metadata capture.
- Index unreviewed external skills as `review_required` with clear warnings.
- Add an automatic skill security review gate before external skills become trusted active catalog entries.
- Add ingestion-time secret scan and binary/script policy checks.
- Keep script execution prohibited.

Exit criteria:

- External skills cannot become trusted without passing the review gate.
- Rejected or blocked skills remain visible to operators but unavailable to normal agent reads/searches.
- Source, review result, reviewer, timestamp, and audit trail are catalog-owned state.

## Phase 6: Rich Progressive Disclosure And Packaging

Goal: make skill loading more structured across agent clients once the tool contract is stable.

Scope:

- Add MCP resources such as `skill://name/SKILL.md` and reference URIs.
- Add MCP prompts for reusable router workflows if they prove useful.
- Add reference manifests and optional reference-file frontmatter.
- Evaluate Codex plugin packaging and OpenCode plugin/enforcement hooks.
- Keep the public split repo a server-package-only distribution unless a separate packaging decision is made.

Exit criteria:

- Resources improve browsing/read UX without replacing the stable V1 tools prematurely.
- Packaging reduces install friction without reintroducing native global skill bloat.

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
