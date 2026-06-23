# Skill Catalog Context

## Glossary

### Public Split Repo

A public repository that receives a publishable copy of the Skill Catalog project from the private `ai-dev` monorepo. It is a server package for other people to access, not a Codex plugin, skill bundle, or marketplace distribution.

### Server Package

The runnable Skill Catalog MCP server, its package metadata, documentation, and configuration examples. It does not include private planning content or bundled skill-library content.

### Source

Where a skill originally came from or is maintained. A source can be self-created local work, another catalog on the same machine, a catalog on another machine, a cloned public Git repository, a website, or a package-driven import such as an `npx` workflow. Source does not record every local place the skill passed through during acquisition or indexing.

Initial source types are `self`, `local_catalog`, `remote_catalog`, `git`, `website`, and `npm`.

Source is required for new skills and imported skills. Existing legacy skills may omit Source, but the catalog should warn when source metadata is missing.

### Author

The person or organization credited with creating or maintaining a skill. Author is required for new skills. Imported skills may use `unknown` only when Source metadata is explicit enough to trace the origin.

Author may be written as a string or object in skill frontmatter. The catalog should normalize it to an object with `name` and optional `url`.

### Source Root

A configured filesystem root scanned by the current Skill Catalog instance. It answers "where did this catalog find the skill during indexing?" Source root is not the same thing as Source: a skill may be indexed from a local source root while its source is an external Git repository. Source roots define the default Trust status for skills discovered under them.

### Acquisition History

Catalog-owned history of how a skill was fetched, synced, copied, or imported into local roots over time. Acquisition history is derived operational state, not portable skill frontmatter.

### Indexed External Root

A configured Source Root that points at externally sourced skills already present on disk. Skill Catalog scans it like any other root, usually with `default_trust_status: review_required`. This is discovery/indexing, not server-owned import.

### Skill-Assisted External Intake

A Phase 4 workflow where the user asks an agent to fetch or inspect an external skill, normalize frontmatter, assemble a Skill Package, and submit it through `create_skill`. The server validates and stores the submitted package, but it does not own GitHub/npm/website download logic in this phase.

### External Import

A later server-owned acquisition workflow where Skill Catalog resolves an external source, fetches files, records acquisition metadata, runs import/security checks, and then integrates the package. External Import is different from both Indexed External Roots and Skill-Assisted External Intake.

### Skill Version

The version declared by the skill author for the individual skill. It changes when the skill's own behavior, instructions, references, or compatibility changes.

Skill Version is required for new self-created skills, starting at `0.1.0`. Imported skills may omit Skill Version when the upstream skill has no declared version, but Source Locator metadata should identify the imported snapshot where possible.

### Source Locator

Version-like information that identifies the upstream source snapshot, such as an npm package version, Git ref, or Git commit. Source locators belong under `source`; they are not the same as Skill Version.

### Skill Registry

Catalog-owned current-state records for known skills. The registry links stable skill identity to the current Source Root, current path, parsed metadata, Trust state, review state, and Content Digest.

The Skill Registry is not catalog-native version control and does not imply staging or production environments for skills. Git can remain the version-control mechanism for skill source changes.

### Skill Library Scope

The audience and sharing boundary for a skill library. Initial Skill Catalog use is a single-person system. Later enterprise deployments may distinguish personal, team, department, and company shared libraries.

### Skill Promotion

A later enterprise workflow that moves a skill from a narrower Skill Library Scope to a broader shared scope after review. Skill Promotion is not part of the single-person proof of concept.

### Skill Contribution Pipeline

A write-capable Skill Catalog workflow that helps agents create, update, validate, and store skills through Skill Catalog MCP tools. The single-person proof of concept includes `create_skill`, `update_skill`, `list_skill_reviews`, `get_skill_review`, `approve_skill`, `reject_skill`, and `request_skill_changes`, but contribution and review remain separate workflows.

The Skill Contribution Pipeline stores skill bodies as files in catalog-managed writable skill roots. Registry, approval, audit, and review state belong to the catalog database.

Phase 4 is a one-person system that may use different AI agents for contribution and review. Write and review tools may accept optional `actor` strings for audit metadata, with a server fallback such as `local:mcp-client` or `unknown`. Actor metadata is not authorization state; roles, users, reviewer separation, and SSO belong to later enterprise phases.

The single-person proof of concept uses a soft review gate: `create_skill` and `update_skill` write and index skills as `review_required`, return validation and security findings plus a `review_id` in the MCP result, and require `approve_skill` with that `review_id` before the skill can become `trusted`. This nudges the user and their reviewing agent; it is not a hard multi-user approval workflow.

Skill Catalog should ship internal skills for the one-person workflows: an authoring/contribution skill that teaches an agent how to structure, test, and write a Skill Package through MCP tools; and a review skill that teaches an agent how to inspect a review-required package, write an assessment, and call the appropriate review tool. External skill intake can be skill-assisted first; server-side import automation belongs after the contribution path is proven.

Phase 4 should not support `auto_approve` on `create_skill` or `update_skill`. Creation/update and approval are separate actions so the proof of concept exercises the review nudge and audit trail without pretending to enforce independent reviewers.

`create_skill` and `update_skill` should support `dry_run: true` for preflight validation. Dry runs return the same validation and security findings shape but do not write files, create review records, or mutate indexes.

Blocking findings prevent mutation. A non-dry-run `create_skill` or `update_skill` with blocking findings returns findings with `written: false`; it does not write files, create review records, or mutate indexes.

`update_skill` is full-package replacement. Companion files omitted from the submitted package are deleted from the existing skill directory, and dry runs should report the resulting manifest diff before mutation.

`update_skill` should not rename or move a skill in Phase 4. It must keep the existing `name`, `target_root`, and `package_path`; rename or move flows should create a new skill and reject or block the old one.

Findings have `info`, `warning`, or `blocking` severity. `approve_skill` may accept `info` and `warning` findings, but it must reject a review ID with any unresolved `blocking` finding. `approve_skill` requires `approval_note` when warnings are present and makes it optional when only info findings or no findings exist. `reject_skill` and `request_skill_changes` require reviewer assessment text.

The Skill Contribution Pipeline is separate from enterprise Skill Promotion. It proves the registry, write, guardrail, and lightweight review model before multi-user library scopes exist.

### Lightweight Skill Review

Catalog-owned review records and state transitions for skills that need human assessment. In the single-person proof of concept, review is user-and-agent driven: the server stores review state, findings, assessment text, and trust changes, but it does not run an internal review agent or enforce independent reviewer separation. Later enterprise deployments should restrict review tools to admins or skill reviewers.

### Review Status

Catalog-owned review state for a lightweight review record. Initial values are `pending`, `changes_requested`, `approved`, and `rejected`. Review Status is separate from Trust: Trust controls normal agent-facing availability, while Review Status records the human-and-agent review outcome.

`request_skill_changes` sets Review Status to `changes_requested` and keeps Trust as `review_required`, but hides the current package from normal search and read surfaces until `update_skill` creates a new pending review. `reject_skill` sets Review Status to `rejected` and Trust to `blocked`, leaving the package visible only in review/admin diagnostics.

When `update_skill` replaces a trusted Skill Package, the old approval no longer applies. Trust resets to `review_required`, Review Status becomes `pending`, and a new `review_id` is created.

In the proof of concept, rejecting a skill does not delete or move package files. Rejection is a catalog state transition so the rejected package remains available for audit, review diagnostics, and Git inspection.

Rejected packages keep their skill name reserved in Phase 4. A rejected skill should be retried with `update_skill`, which creates a new pending review, rather than by creating another package with the same name.

### Review Event

A durable event emitted when a skill is created, updated, reviewed, approved, rejected, or sent back for changes. Phase 4 should record Review Events internally; later phases may forward them through webhooks to ticket systems, Slack, or similar workflow tools.

### Writable Skill Root

A configured Source Root that Skill Catalog write tools may mutate. Read/index roots and writable roots are separate by default. A Skill Catalog instance may have multiple Writable Skill Roots, but `create_skill` and `update_skill` may write only to roots explicitly configured as writable.

### Skill Package

The filesystem package for one skill: required `SKILL.md` plus allowed companion files. Phase 4 Skill Packages may include reference/docs files and scripts, commonly under `references/`, `docs/`, and `scripts/`.

`create_skill` and `update_skill` should accept Skill Package content directly: a small amount of routing metadata such as `name`, optional `target_root`, and optional `package_path`, the complete `SKILL.md` text, and optional companion files. The server validates parsed frontmatter against the structured routing fields; it should not synthesize `SKILL.md` from many separate metadata fields.

`name` is the globally unique skill identity. `package_path` is optional filesystem placement relative to the selected writable root. If `package_path` is omitted on create, the catalog derives a safe default from `name`; when provided, nested paths such as `gog-cli/drive` are allowed for curated grouping. Absolute paths, empty segments, `..`, symlinks, and traversal are invalid.

Group directories may contain multiple skill packages, but skill packages must not be nested inside other skill packages. In a single root, one package path cannot be an ancestor or descendant of another package path.

Full-package replacement prevents stale companion files from surviving after review. Deletes must be limited to files inside the existing skill directory; symlinks, path traversal, and unsafe paths remain blocking findings.

Scripts are package content, not catalog-executed behavior. Skill Catalog may store, index, read, validate, and review script files, but it must not execute scripts found inside skill packages.

Review-required Skill Packages that contain scripts are hidden from normal search and read surfaces until approved. This is a Phase 4 visibility rule, not a full script-security review.

### Content Digest

A fingerprint of the current catalog-visible skill content. A Content Digest can help detect drift between reviewed catalog state, Invocation Shortcuts, and the source files currently indexed by the catalog. It is not the same as Skill Version.

Content Digest approval is deferred until a more sophisticated review or enterprise promotion pipeline exists. The single-person proof of concept may compute hashes for audit/debugging, but `approve_skill` should use `review_id` rather than requiring a strict content digest.

### Skill Patch

An internal Skill Catalog tool or skill for modifying existing skills. It should manage Skill Version changes according to the significance of the patch.

Skill Patch uses SemVer-style significance rules: patch for non-behavioral fixes, minor for compatible additions, and major for breaking trigger/input/output/workflow changes.

### Invocation Shortcut

A client-local entry that makes a catalog skill available through a native explicit invocation surface such as a slash menu or skill picker. An Invocation Shortcut is not the skill itself: the full skill remains catalog-managed and is not moved into the client.

`install-slash-command` is product language for creating an Invocation Shortcut. The user-facing name describes the visible outcome, while Invocation Shortcut is the domain term.

### Trust

Catalog-owned state describing whether a skill has passed the catalog's safety expectations. Trust is separate from Source; external skills are not trusted automatically just because their source is known. Trust status values are `trusted`, `review_required`, and `blocked`.

`review_required` means catalog trust is not satisfied yet. In Phase 4 this is a lightweight one-person review nudge and guardrail state; in later import phases it may also reflect a real security-review gate.

Trust defaults come from Source Root configuration. Catalog-owned per-skill trust state can override the root default later.

### Review-Required Visibility Policy

Catalog policy that controls whether `review_required` skills appear in normal search and read surfaces. The default policy keeps them visible with warnings. The policy must be configurable through the config file and the admin UI.

Review-required Skill Packages that contain scripts are excluded from normal search and read surfaces until approved, regardless of this policy.

`blocked` skills are not controlled by this policy: they remain unavailable to normal search and read surfaces.

### Config Overlay

A durable config file written by local admin tooling or the admin UI to override selected Skill Catalog settings. Config Overlays are preferred over SQLite-stored runtime config because coding agents can inspect, edit, diff, and review files directly.

Skill Catalog config precedence is package defaults, then main config, then Config Overlay, then environment variables.

Config Overlay changes require an explicit reload or service restart before they affect runtime behavior. Reload validates the full effective config first; if validation fails, the current runtime config remains active.

### Skill Security Review

A later-version import gate that checks a skill before it is integrated into the catalog. Review results are catalog-owned state, not portable skill frontmatter. After this gate exists, integrated catalog skills should be trusted by construction because external imports must pass the review before integration.
