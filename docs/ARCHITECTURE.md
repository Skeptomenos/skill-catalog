# Skill Catalog Architecture

## V1 Boundary

V1 is a read-only MCP server. It indexes skill metadata and serves skill files. It does not mutate source files, execute scripts, install skills, or manage other MCP servers.

Local Invocation Shortcuts are not part of the V1 or V1.1 server boundary. An Invocation Shortcut is a client-local entry that delegates explicit invocation to `read_skill` for a fixed catalog skill. Shortcut generation and installation write to client skill directories, so they belong after contribution guardrails, security review, and later packaging/client-integration work, not the read-only server API.

Phase 4 intentionally breaks the V1 read-only boundary with a controlled MCP write-tool proof of concept. The architecture contract is:

- Add `create_skill`, full-package `update_skill`, `list_skill_reviews`, `get_skill_review`, `approve_skill`, `reject_skill`, and `request_skill_changes` only after registry state, validation, security checks, review IDs, and audit records exist.
- Keep write inputs package-first: `name`, optional `target_root`, optional `package_path`, complete `SKILL.md`, and optional companion files. The server parses and validates frontmatter instead of rendering `SKILL.md` from separate metadata fields.
- Treat `name` as globally unique skill identity and `package_path` as relative filesystem placement under a writable root.
- Support `dry_run: true` with findings and manifest diff but no file, review, or index mutation.
- Refuse mutation when blocking findings exist; return findings with `written: false`.
- Write packages only when no blocking findings exist. `update_skill` is full-package replacement and deletes omitted companion files inside the existing skill directory, but it must not rename or move the skill.
- Return findings plus `review_id` for successful writes, index changed packages as `review_required`, and use lightweight review tools to mark them `trusted`, rejected, or changes-requested.
- Keep review tools as state-transition and audit APIs, not a server-owned review workflow engine. Agent-facing authoring, external-intake, and review instructions live in internal Skill Catalog skills.
- Do not support `auto_approve`; approval remains a separate `approve_skill` action.
- Reject approval when unresolved blocking findings exist; require `approval_note` when warnings are present.
- Hide script-bearing `review_required` packages from normal search/read/reference surfaces until approved.
- Keep rejected package files in place, reserve rejected package names, and retry rejected packages through `update_skill`.
- Never execute scripts found inside skill packages.

V1 uses pnpm and the stable monolithic `@modelcontextprotocol/sdk@1.29.0` for the first MVP PR. The MCP TypeScript SDK v2 split packages are still alpha, so the transport adapter should be isolated for a later mechanical migration when v2 stabilizes.

Streamable HTTP is stateful by default. The server should create session IDs for normal deployments and allow stateless mode through config for simple local/API-style use.

## Components

```text
MCP client
  Codex / OpenCode / agent harnesses
    |
    | Streamable HTTP + bearer token
    v
Skill Catalog MCP server
  boundary:
    MCP TypeScript SDK
    Zod tool schemas
    thin handlers
  tools:
    search_skills
    read_skill
    read_skill_reference
    skill_catalog_status
  Effect service core:
    config loader
    skill scanner
    metadata parser
    search ranker
    reference reader
    audit logger
  data:
    SQLite metadata + FTS index
    optional QMD search adapter
  source:
    configured skill roots
```

The MCP adapter stays thin. Tool handlers validate with Zod through the MCP SDK, call Effect services, then translate typed service results or errors into MCP tool responses.

```ts
server.registerTool("search_skills", { inputSchema: SearchInput }, async input => {
  const result = await Effect.runPromise(runtime.search.search(input))

  return toMcpResult(result)
})
```

## Data Ownership

Source of truth:

- configured skill root directories
- each skill directory's `SKILL.md`
- optional companion files under that skill directory
- for Phase 4 writes, catalog-managed skill roots that `create_skill` and `update_skill` are allowed to mutate

Derived state:

- SQLite metadata rows
- SQLite FTS index
- registry, trust, approval, review, and audit records
- sync errors
- audit log
- optional QMD index state outside this service

The service must be able to delete and rebuild search/index state from configured roots. Phase 4 registry and approval state may be persisted in SQLite, but SQLite should not become the primary store for skill packages. Write tools should write `SKILL.md` and allowed companion files into a catalog-managed skill root, including `references/`, `docs/`, and `scripts/` when provided, then update registry and derived index state from those files. Strict content-digest-gated approval belongs to later enterprise review and promotion workflows, not the single-person write-tool proof of concept.

## Public Split Boundary

`_infra/skill-catalog` split-publishes to `Skeptomenos/skill-catalog` as a server-package-only public copy. The default monorepo split cleanup removes the private planning corpus, and the Skill Catalog split step also strips project-specific non-server artifacts before publishing.

The Skill Catalog public split must continue to remove:

- private planning corpus
- bundled integration artifacts such as `integrations/skill-router/`
- private skill-library, external imported, or fixture skill content
- monorepo-only agent instructions

The split should publish a server-package-only public copy: MCP server implementation, docs, package/config files, and Skill Catalog internal skills under `skills/`. It must not publish the private planning corpus, private or external skill-library content, Codex plugin packaging, or bundled integration artifacts.

## Config Sketch

```yaml
server:
  transport: streamable-http
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
    writable: false
  - name: ai-dev-skills
    path: ${AI_DEV_ROOT}/_infra/skills/skills
    default_trust_status: trusted
    writable: false
  - name: ai-dev-agent-skills
    path: ${AI_DEV_ROOT}/.agents/skills
    default_trust_status: trusted
    writable: false
  - name: skill-catalog-managed-skills
    path: ${AI_DEV_ROOT}/_infra/skill-catalog/managed-skills
    default_trust_status: review_required
    writable: true

storage:
  sqlite_path: ~/.cache/skill-catalog/catalog.sqlite

config:
  overlay_path: ~/.config/skill-catalog/config.local.yaml

search:
  default_limit: 5
  max_limit: 20
  include_review_required_by_default: true
  qmd:
    enabled: false
    collection: skill-catalog
    command: qmd

limits:
  max_skill_bytes: 262144
  max_inline_reference_bytes: 131072
  max_http_body_bytes: 1048576
  follow_symlinks: false
  rate_limit:
    enabled: true
    window_ms: 60000
    max_requests: 120
    max_entries: 1000
```

Config loading and runtime services expose Effect-returning methods, but V1 composes the runtime directly in `buildRuntime()` instead of wiring an unused Effect `Layer` graph.

Skill Catalog should keep durable configuration in files, not SQLite runtime overrides. Configuration precedence should be:

```text
package defaults < main config < config overlay < environment variables
```

The admin UI may update a dedicated config overlay file such as `~/.config/skill-catalog/config.local.yaml`. Overlay edits should not silently mutate live runtime behavior. They should require an explicit config reload action or service restart.

Reload must validate the full effective config before applying it. If validation fails, the previous runtime config stays active and the admin UI reports the validation errors. The effective-config view should show each setting's effective value, source layer, overlay path, and whether unapplied overlay changes are pending. This preserves AI-native inspectability, Git diffs where desired, backup/restore simplicity, and avoids hidden split-brain behavior where the config file and SQLite disagree.

Configured paths are expanded and validated at startup. V1 supports environment-variable substitution for portable deployment configs and fails fast when a configured root does not exist, is not a directory, or is a symlink while `limits.follow_symlinks` is false. Scan-time sync errors remain for files and directories discovered below valid roots, and scanner-level root checks remain as defense-in-depth if filesystem state changes before an admin rebuild.

Path values may be absolute, home-relative with `~`, environment-substituted such as `${AI_DEV_ROOT}/_infra/skill-catalog/skills` or `${AI_DEV_ROOT}/_infra/skills/skills`, or relative to the config file directory. The preferred integration-test default is repo-root-relative derivation with an explicit environment override for unusual layouts.

Roots default to `writable: false`. Phase 4 write tools may mutate only roots explicitly configured with `writable: true`; `create_skill` should use the only configured writable root when exactly one exists, and require `target_root` when multiple writable roots exist. `update_skill` should refuse to modify skills outside writable roots. This keeps internal product skills, private library roots, and external synced roots read-only unless deliberately configured otherwise. Future deployments may configure multiple writable roots as the skill library grows.

`create_skill.package_path` is optional. When omitted, the catalog should derive a safe package directory from `name`. When provided, it may contain nested safe segments such as `gog-cli/drive` to support grouped libraries while preserving the globally unique skill name, such as `gog-cli-drive`. Package paths are relative to the selected writable root and must reject absolute paths, empty segments, `..`, symlinks, and traversal.

Nested grouping directories are allowed, but nested skill packages are not. A package path must not be an ancestor or descendant of another package path in the same root; otherwise one skill's reference boundary would contain another skill's `SKILL.md`.

`server.session_mode` accepts `stateful` or `stateless`. Stateful is the default and should use secure random session IDs. Stateless mode should set the SDK transport's session ID generator to `undefined`.

`server.max_sessions` and `server.session_idle_ttl_ms` bound V1 in-memory stateful MCP sessions. Expired sessions are pruned on each `/mcp` request and before accepting a new initialize request; when the cap remains full after pruning, new stateful initialize requests receive a JSON-RPC `429`.

`limits.rate_limit` controls the V1 in-memory `/mcp` and `/admin/api/*` request limiters. It is intended to stop accidental local overload and simple private-network abuse, not to provide strong multi-tenant security. Later enterprise-ready deployments should replace it with auth-aware rate limiting backed by a reverse proxy, API gateway, or shared store.

`limits.max_http_body_bytes` controls Express JSON body parsing for MCP and admin API requests. The server applies the parser before MCP transport handling or admin operations so oversized request bodies are rejected with HTTP 413 before expensive request work begins.

## MCP Tools

### `search_skills`

Purpose: select relevant skills for a task.

Input:

```json
{
  "query": "write a PRD for a new feature",
  "limit": 5,
  "include_incomplete_metadata": true
}
```

Output:

```json
{
  "query": "write a PRD for a new feature",
  "results": [
    {
      "id": "skill_abc123",
      "name": "prd",
      "description": "Generate a Product Requirements Document...",
      "category": "planning",
      "author": {"name": "David Helmus"},
      "version": "0.1.0",
      "source": {"type": "self", "name": "ai-dev"},
      "triggers": ["create a prd", "write prd for"],
      "when_to_use": ["Planning a new feature"],
      "when_not_to_use": ["Implementing a code change directly"],
      "source_root": "ai-dev-skills",
      "trust_status": "trusted",
      "warnings": [],
      "score": 0.94,
      "matched_backends": ["fts", "qmd"],
      "matched_fields": ["description", "triggers"],
      "why_match": "Matched PRD planning trigger text."
    }
  ]
}
```

Rules:

- Return metadata only.
- Define public input/output schemas with Zod.
- Default to small result sets. `limit` is dynamically clamped at runtime to `1..search.max_limit`; the static Zod schema only enforces that provided limits are positive integers.
- Include backend attribution.
- Prefer exact metadata matches over weak semantic matches.
- Include normalized portable metadata (`author`, `version`, `source`) and catalog-owned operational metadata (`source_root`, `trust_status`, `warnings`).
- `include_incomplete_metadata` defaults to `true`. When set to `false`, search excludes results with metadata warnings or empty selection metadata arrays (`triggers`, `when_to_use`, `when_not_to_use`). The same filter is applied to FTS results and to the candidate skill set passed to QMD.
- Keep ranking relevance-only in V1; trust status and warnings do not change score ordering.
- Include `review_required` skills by default when `search.include_review_required_by_default` is true. Phase 4 admin UI should expose this policy. When disabled, normal search excludes `review_required` skills while status/admin diagnostics still show them.
- Exclude review-required skills that contain scripts from normal search until approved, regardless of `search.include_review_required_by_default`.
- Exclude `blocked` skills from normal search results. Blocked skills remain indexed for status and admin diagnostics only.

### `read_skill`

Purpose: return the selected skill's full `SKILL.md`.

Input:

```json
{
  "name_or_id": "prd"
}
```

Output:

```json
{
  "id": "skill_abc123",
  "name": "prd",
  "path": "prd/SKILL.md",
  "content": "---\nname: prd\n..."
}
```

Rules:

- Return only `SKILL.md`.
- Do not include companion file manifests in v1.
- Enforce `max_skill_bytes`; oversized `SKILL.md` reads return an error in V1 rather than a metadata-only response.
- Allow `review_required` reads by default when the review-required visibility policy allows them, and return trust/warning metadata once Phase 4 registry review state exists.
- Reject normal reads for review-required skills that contain scripts until approved; expose them through status/admin/review surfaces instead.
- Reject `blocked` skills.

### `read_skill_reference`

Purpose: return one explicitly requested file under a selected skill directory.

Input:

```json
{
  "name_or_id": "prd",
  "relative_path": "template.md"
}
```

Output for inline text:

```json
{
  "id": "skill_abc123",
  "name": "prd",
  "relative_path": "template.md",
  "size_bytes": 4218,
  "mime": "text/plain",
  "sha256": "...",
  "content": "# Template\n..."
}
```

Output for blocked inline content:

```json
{
  "id": "skill_abc123",
  "name": "prd",
  "relative_path": "assets/diagram.png",
  "size_bytes": 482193,
  "mime": "image/png",
  "sha256": "...",
  "content": null,
  "inline_blocked_reason": "binary_file"
}
```

Output for oversized content:

```json
{
  "id": "skill_abc123",
  "name": "prd",
  "relative_path": "docs/large.md",
  "size_bytes": 482193,
  "mime": "text/markdown",
  "sha256": null,
  "content": null,
  "inline_blocked_reason": "size_limit"
}
```

Rules:

- Resolve the path against the skill directory.
- Reject path traversal.
- Reject `blocked` skills.
- Reject normal reference reads for review-required skills that contain scripts until approved; expose them through status/admin/review surfaces instead.
- Reject symlinks in v1.
- Never execute files.
- Check file size before reading contents; oversized files return metadata with `sha256: null`.
- Inline only text-like content under the configured limit. Binary files that are small enough to inspect return metadata with a populated `sha256`.
- Allow all file extensions under the directory subject to those guards.

### `skill_catalog_status`

Purpose: report service health and index status.

Output:

```json
{
  "roots": [
    {
      "name": "ai-dev-skills",
      "path": "/Users/david.helmus/repos/ai-dev/_infra/skills/skills",
      "default_trust_status": "trusted",
      "skills_indexed": 37,
      "errors": [
        {
          "source_root": "ai-dev-skills",
          "path": "broken/SKILL.md",
          "code": "parse_error",
          "message": "Could not parse skill frontmatter."
        }
      ]
    }
  ],
  "duplicate_names": [],
  "metadata_warnings": [
    {
      "skill": "writing-plans",
      "source_root": "ai-dev-skills",
      "trust_status": "trusted",
      "missing_fields": ["when_not_to_use", "author", "version", "source"],
      "warnings": [
        {"code": "missing_source", "message": "Skill frontmatter is missing source metadata."}
      ]
    }
  ],
  "search_backends": {
    "fts": "ready",
    "qmd": "disabled"
  },
  "search_backend_warnings": []
}
```

## Sync Flow

1. Read config.
2. Scan each configured root recursively for `SKILL.md`.
3. Parse frontmatter.
4. Validate required fields:
   - `name`
   - `description`
5. Derive category from frontmatter or relative path.
6. Enforce globally unique names. In V1, duplicate names cause all copies of that name to be dropped from the searchable/readable index and reported in `duplicate_names` plus sync errors; this avoids violating the SQLite `name UNIQUE` constraint while registry-owned duplicate resolution is still out of scope.
7. Store metadata and sync diagnostics in SQLite.
8. Rebuild FTS index.
9. If QMD is enabled, query QMD at search time; do not make QMD required for sync success.

Rebuilds replace derived skill/index/sync-error state but preserve `audit_log`. A successful rebuild records a `rebuild_index` audit event.

## Search Ranking

The ranker merges backend candidates with reciprocal-rank style fusion:

- FTS/BM25 over parsed metadata is the baseline.
- QMD query over `SKILL.md` files is optional.
- QMD receives only nonblocked skills as match candidates.
- The adapter invokes `qmd query --full-path`. QMD result files must be filesystem paths: absolute paths are matched exactly after path normalization against allowed `skill.skillFile` values, and `./...` paths are resolved against the QMD process cwd before exact matching. Default `qmd://...` URI output is ignored rather than guessed or suffix-matched.
- Strong exact metadata hits outrank vague semantic hits.
- FTS-only mode weights `name`, `description`, `triggers`, `when_to_use`, and `when_not_to_use` before weaker body text, so stale or unavailable QMD does not make routing unusable. The SQLite FTS table columns are `id UNINDEXED`, `name`, `description`, `triggers`, `when_to_use`, `when_not_to_use`, and `body_text`; the BM25 weight order intentionally includes `0.0` for the unindexed `id` column before the content weights: `0.0, 10.0, 6.0, 5.0, 4.0, 3.0, 0.25`.
- Every returned result includes backend attribution and match explanation.

## SQLite Sketch

```sql
skills(
  id text primary key,
  name text not null unique,
  description text not null,
  category text,
  author_json text,
  version text,
  source_json text,
  source_root text not null,
  root_path text not null,
  skill_dir text not null,
  skill_file text not null,
  trust_status text not null,
  warnings_json text not null,
  triggers_json text not null,
  when_to_use_json text not null,
  when_not_to_use_json text not null,
  metadata_json text not null,
  content_hash text not null,
  updated_at text not null
)

skill_sync_errors(
  id integer primary key,
  source_root text not null,
  path text not null,
  code text not null,
  message text not null,
  seen_at text not null
)

audit_log(
  id integer primary key,
  tool text not null,
  skill_name text,
  path text,
  caller text,
  duration_ms integer not null,
  created_at text not null
)

skills_fts(
  id UNINDEXED,
  name,
  description,
  triggers,
  when_to_use,
  when_not_to_use,
  body_text
)
```

The store keeps raw frontmatter in `metadata_json` and promotes normalized `author`, `version`, and `source` to first-class columns for search/status/API responses. Existing local skills may omit these fields and remain indexable with metadata warnings, but external roots should default to `review_required` until review workflows exist.

`source` is portable skill metadata for the original or maintained origin. `source_root` remains catalog-owned indexing metadata for the configured root that discovered the skill. Future acquisition history should be modeled as catalog state rather than written into skill frontmatter.

Initial `source.type` values are `self`, `local_catalog`, `remote_catalog`, `git`, `website`, and `npm`.

External sourcing has three distinct architecture paths:

- Indexed External Root: scan externally sourced files already present under a configured Source Root, usually defaulting to `review_required`.
- Skill-Assisted External Intake: let an agent fetch/inspect external content and submit a package through `create_skill`; the server validates and stores the submitted package but does not own acquisition.
- External Import: a later server-owned acquisition pipeline that resolves sources, fetches files, records acquisition metadata, runs import/security checks, and integrates packages.

`source` is required for new skills and imported skills. Existing legacy skills remain indexable without `source`, but metadata warnings should report missing source metadata.

`author` is required for new skills. Imported skills may use `author: unknown` only when `source` metadata is explicit enough to trace the origin. Existing legacy skills remain indexable without `author`, but metadata warnings should report missing author metadata.

Frontmatter may represent `author` as either a string or an object. The catalog should normalize both forms to `{ name: string, url?: string }` in stored/search response metadata.

Recommended frontmatter shape:

```yaml
author: David Helmus
version: 0.1.0
source:
  type: git
  url: "https://github.com/mattpocock/skills"
  path: "skills/productivity/grill-me/SKILL.md"
  ref: "main"
  commit: "abc123"
```

Top-level `version` is the individual skill's declared version. Upstream package or repository locators live under `source`, such as `source.version`, `source.ref`, and `source.commit`.

New self-created skills should require top-level `version`, starting at `0.1.0`. Imported skills may omit top-level `version` when the upstream skill has no declared version, provided `source` includes locator metadata where possible. Existing legacy skills remain indexable without `version`, but metadata warnings should report missing version metadata.

A future internal Skill Catalog `skill-patch` tool or skill should own version changes when skills are modified. It should use SemVer-style significance rules: patch for non-behavioral fixes, minor for compatible additions, and major for breaking trigger/input/output/workflow changes. The catalog should read and report versions; it should not infer or mutate skill versions in V1.

Source metadata does not imply trust. Until an import security review exists, external unreviewed skills may be indexed, but tool/status/UI responses should surface them as `review_required` rather than automatically trusted.

A later import workflow should run a skill security review before external skills are integrated into the catalog. After that gate exists, active catalog skills should be trusted by construction because external imports must pass the review before integration.

Trust and review status belong in catalog-owned state, not skill frontmatter. Search/status/UI responses should combine portable skill metadata from frontmatter with local catalog metadata such as `source_root`, `trust_status`, review result, actor string where available, timestamp, and warnings.

Trust status values:

- `trusted`: catalog-local trust is satisfied
- `review_required`: catalog trust is not satisfied yet; visibility follows the review-required visibility policy
- `blocked`: indexed for operator diagnostics but excluded from normal search and read surfaces

Default trust status comes from root configuration. Catalog-owned per-skill trust state can override the root default later. Do not derive trust solely from frontmatter `source`: a skill with a Git source can become trusted after review by moving into or being approved under a trusted catalog root.

V1 search ranking remains relevance-only. Do not apply a trust penalty or boost in ranking until FTS and QMD scores are normalized well enough for trust-aware ranking to be predictable. Instead, include trust status and warning metadata in result/status/UI responses. `blocked` is the exception: it is an active deny state, not a ranking signal.

## Security Guardrails

V1:

- Streamable HTTP on localhost or private network.
- Bearer token authentication.
- In-memory `/mcp` and `/admin/api/*` rate limiting for V1 operational safety.
- Zod validation at MCP tool boundaries.
- Effect typed errors inside the service core.
- Configured roots only.
- Read-only API.
- No script execution.
- No symlink following.
- Path traversal rejection.
- Binary and oversized reference files return metadata only.
- Audit every read and search.

V3+:

- OAuth identity.
- ACLs by root, category, and skill.
- Strong auth-aware rate limiting at the gateway or shared backing store.
- Current-state registry source metadata, review IDs, and optional content digests.
- Enterprise contribution proposal state, promotion workflows, and version-aware review audit history.
- Review event webhooks or workflow integrations for ticket systems, Slack, and similar tools.
- Skill security review before external skill import/integration.
- Ingestion-time secret scan.
- Trusted/untrusted skill states.
- Organization-wide audit retention.

## Agent Integration

V1 ships a router skill artifact and config examples.

Router skill behavior:

- Search before complex, unfamiliar, multi-step, high-risk, or domain-specific work.
- Skip search for trivial tasks.
- If the user names a skill, read it directly.

Install target:

```text
~/.agents/skills/skill-router/SKILL.md
```

Do not install every cataloged skill into native global skill locations.

Future Invocation Shortcut behavior:

- Generate shortcuts only for an explicit pinned subset of trusted skills.
- Keep generated `SKILL.md` shortcut content minimal: frontmatter plus one instruction to call `read_skill` for the catalog skill.
- Do not copy catalog references, scripts, or assets into shortcuts.
- Include catalog provenance such as skill name, registry ID when available, version, and content hash.
- Use client-specific manual-only metadata where supported, for example Codex `allow_implicit_invocation: false` and Claude Code `disable-model-invocation: true`.
- Count shortcuts in token-cost evals before shipping any install workflow.
- Treat Codex app slash-list visibility as native enabled-skill visibility, not a separate slash-command file.
- Keep install/sync tooling out of the MCP server until packaging or a dedicated client integration exists.

`skills/skill-install` is the narrow internal helper for explicit local shortcut installs. It belongs to the Skill Catalog product package and may be indexed as `skill-catalog-internal-skills`, but it does not add a server-side write API or broad shortcut sync. The future user-facing product action should be named `install-slash-command`; the durable domain object is an Invocation Shortcut.

## Management UI

V1 includes a lightweight admin UI for operating the server. The UI sits beside the MCP service and uses the same Effect-returning services for read-only status/search/read operations plus tightly scoped administrative actions.

Initial UI scope:

- status dashboard for roots, indexed counts, duplicate names, metadata warnings, FTS, and QMD
- smoke-test panel for `search_skills`, `read_skill`, and `read_skill_reference`
- audit-log viewer for searches and reads
- derived-index controls such as rebuild/resync
- effective-config view for session mode, roots, limits, QMD, auth environment variables, config overlay path, and source layer per value
- config overlay write and explicit reload controls after full effective-config validation exists
- Phase 4 control for whether `review_required` skills appear in normal search/read surfaces

Out of scope until registry work exists:

- editing skill source files
- importing external skills directly from the UI
- making skills trusted/active or approving skills through the UI
- installing or syncing Invocation Shortcuts on client machines
- managing ACLs beyond displaying current auth mode

## Later MCP Resources

V1 uses tools only. Later versions can add resources:

```text
skill://prd/SKILL.md
skill://prd/template.md
```

Resources would improve browse/read UX, but tools are the compatibility-first contract for v1.
