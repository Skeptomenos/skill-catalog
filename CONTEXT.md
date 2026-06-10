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

### Skill Version

The version declared by the skill author for the individual skill. It changes when the skill's own behavior, instructions, references, or compatibility changes.

Skill Version is required for new self-created skills, starting at `0.1.0`. Imported skills may omit Skill Version when the upstream skill has no declared version, but Source Locator metadata should identify the imported snapshot where possible.

### Source Locator

Version-like information that identifies the upstream source snapshot, such as an npm package version, Git ref, or Git commit. Source locators belong under `source`; they are not the same as Skill Version.

### Skill Patch

An internal Skill Catalog tool or skill for modifying existing skills. It should manage Skill Version changes according to the significance of the patch.

Skill Patch uses SemVer-style significance rules: patch for non-behavioral fixes, minor for compatible additions, and major for breaking trigger/input/output/workflow changes.

### Trust

Catalog-owned state describing whether a skill has passed the catalog's safety expectations. Trust is separate from Source; external skills are not trusted automatically just because their source is known. Trust status values are `trusted`, `review_required`, and `blocked`.

Trust defaults come from Source Root configuration. Catalog-owned per-skill trust state can override the root default later.

### Skill Security Review

A later-version import gate that checks a skill before it is integrated into the catalog. Review results are catalog-owned state, not portable skill frontmatter. After this gate exists, integrated catalog skills should be trusted by construction because external imports must pass the review before integration.
