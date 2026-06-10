import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/types.js";
import { scanSkillRoots } from "../src/skills/scanner.js";
import { CatalogStore } from "../src/storage/catalog-store.js";
import { SearchService } from "../src/search/search-service.js";
import { ReferenceService } from "../src/reference/reference-service.js";

const stores: CatalogStore[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const tempDir of tempDirs.splice(0)) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("catalog store and search", () => {
  it("indexes skills and finds relevant FTS results with QMD disabled", async () => {
    const root = await createSkillRoot({
      prd: "Generate a PRD. Triggers on: create a prd, write prd for.",
      "git-workflow": "Git branching, commits, PRs, and review workflow.",
      "agent-browser": "Browser automation for screenshots and web testing."
    });
    const config = testConfig(root);
    const store = new CatalogStore(config);
    stores.push(store);
    const sync = await Effect.runPromise(scanSkillRoots(config));
    await Effect.runPromise(store.rebuild(sync));

    const search = new SearchService(config, store);
    const result = await Effect.runPromise(search.search({ query: "write a prd", limit: 3 }));

    expect(result.results[0]?.name).toBe("prd");
    await expectTopSearchResult(search, "create a prd", "prd");
    await expectTopSearchResult(search, "git workflow", "git-workflow");
    await expectTopSearchResult(search, "browser automation screenshots", "agent-browser");
    const status = await Effect.runPromise(store.status());
    expect(status.search_backends.qmd).toBe("disabled");
    expect(status.roots[0]?.skills_indexed).toBe(3);
  });

  it("weights name matches above repeated body-only matches", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "skill-catalog-rank-"));
    await writeCustomSkill(
      root,
      "name-hit",
      `---
name: calibrationtarget
description: General routing helper.
---

# Name Match

This body intentionally avoids the query marker.
`
    );
    await writeCustomSkill(
      root,
      "body-heavy",
      `---
name: body-heavy
description: General routing helper.
---

# Body Heavy

${Array.from({ length: 80 }, () => "calibrationtarget").join(" ")}
`
    );
    const config = testConfig(root);
    const store = new CatalogStore(config);
    stores.push(store);
    const sync = await Effect.runPromise(scanSkillRoots(config));
    await Effect.runPromise(store.rebuild(sync));

    const result = await Effect.runPromise(store.searchFts("calibrationtarget", 2));

    expect(result.map((item) => item.name)).toEqual(["calibrationtarget", "body-heavy"]);
    expect(result[0]?.matched_fields).toContain("name");
    expect(result[1]?.matched_fields).toContain("body");
  });

  it("excludes duplicate skill names and reports sync errors", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "skill-catalog-dupes-"));
    await writeSkill(root, "one", "same", "First skill.");
    await writeSkill(root, "two", "same", "Second skill.");
    const config = testConfig(root);
    const sync = await Effect.runPromise(scanSkillRoots(config));

    expect(sync.skills).toHaveLength(0);
    expect(sync.duplicateNames).toEqual(["same"]);
    expect(sync.errors.some((error) => error.code === "duplicate_skill_name")).toBe(true);
  });

  it("serializes status sync errors with public snake_case fields", async () => {
    const missingRoot = path.join(os.tmpdir(), `skill-catalog-missing-${Date.now()}`);
    const config = testConfig(missingRoot);
    const store = new CatalogStore(config);
    stores.push(store);
    const sync = await Effect.runPromise(scanSkillRoots(config));
    await Effect.runPromise(store.rebuild(sync));

    const status = await Effect.runPromise(store.status());
    const error = status.roots[0]?.errors[0] as unknown as Record<string, unknown> | undefined;

    expect(error).toMatchObject({
      source_root: "test-root",
      path: missingRoot,
      code: "root_read_error"
    });
    expect(error).not.toHaveProperty("sourceRoot");
  });

  it("persists normalized metadata, root trust status, and warnings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "skill-catalog-metadata-"));
    const skillDir = path.join(root, "external", "grill-me");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      `---
name: grill-me
description: Challenge a plan until it is clear.
author: Matt Pocock
source:
  type: git
  url: "https://github.com/mattpocock/skills"
  ref: main
  commit: abc123
---

# Grill Me
`,
      "utf8"
    );
    const config = testConfig(root, { trustStatus: "review_required" });
    const store = new CatalogStore(config);
    stores.push(store);
    const sync = await Effect.runPromise(scanSkillRoots(config));
    await Effect.runPromise(store.rebuild(sync));

    const search = new SearchService(config, store);
    const result = await Effect.runPromise(search.search({ query: "challenge plan", limit: 1 }));

    expect(result.results[0]).toMatchObject({
      name: "grill-me",
      author: { name: "Matt Pocock" },
      version: null,
      source: {
        type: "git",
        url: "https://github.com/mattpocock/skills",
        ref: "main",
        commit: "abc123"
      },
      trust_status: "review_required"
    });
    expect(result.results[0]?.warnings.map((warning) => warning.code)).toEqual(["review_required"]);
    const status = await Effect.runPromise(store.status());
    expect(status.roots[0]?.default_trust_status).toBe("review_required");
    expect(status.metadata_warnings[0]).toMatchObject({
      skill: "grill-me",
      trust_status: "review_required",
      missing_fields: ["triggers", "when_to_use", "when_not_to_use"]
    });
  });

  it("includes incomplete metadata by default and excludes it when requested", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "skill-catalog-incomplete-"));
    await writeCustomSkill(
      root,
      "complete-route",
      `---
name: complete-route
description: Complete routing metadata for legacyfilter.
author: Test Author
version: 1.0.0
source:
  type: self
  name: test
triggers:
  - legacyfilter
when_to_use:
  - Use for legacyfilter complete metadata checks.
when_not_to_use:
  - Do not use for unrelated tasks.
---

# Complete Route
`
    );
    await writeCustomSkill(
      root,
      "legacy-route",
      `---
name: legacy-route
description: Legacy routing metadata for legacyfilter.
---

# Legacy Route

legacyfilter body match.
`
    );
    const config = testConfig(root);
    const store = new CatalogStore(config);
    stores.push(store);
    const sync = await Effect.runPromise(scanSkillRoots(config));
    await Effect.runPromise(store.rebuild(sync));
    const search = new SearchService(config, store);

    const defaultResult = await Effect.runPromise(search.search({ query: "legacyfilter", limit: 10 }));
    expect(defaultResult.results.map((result) => result.name).sort()).toEqual(["complete-route", "legacy-route"]);

    const filteredResult = await Effect.runPromise(
      search.search({ query: "legacyfilter", limit: 10, includeIncompleteMetadata: false })
    );
    expect(filteredResult.results.map((result) => result.name)).toEqual(["complete-route"]);
  });

  it("fills filtered results from complete FTS hits below incomplete matches", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "skill-catalog-filter-fill-"));
    await writeCustomSkill(
      root,
      "complete-route",
      `---
name: complete-route
description: Complete routing metadata.
author: Test Author
version: 1.0.0
source:
  type: self
  name: test
triggers:
  - legacyfilter
when_to_use:
  - Use for legacyfilter complete metadata checks.
when_not_to_use:
  - Do not use for unrelated tasks.
---

# Complete Route
`
    );
    await writeCustomSkill(
      root,
      "legacyfilter",
      `---
name: legacyfilter
description: Incomplete metadata with a stronger name hit.
---

# Legacy Filter
`
    );
    const config = testConfig(root);
    const store = new CatalogStore(config);
    stores.push(store);
    const sync = await Effect.runPromise(scanSkillRoots(config));
    await Effect.runPromise(store.rebuild(sync));
    const search = new SearchService(config, store);

    const defaultResult = await Effect.runPromise(search.search({ query: "legacyfilter", limit: 2 }));
    expect(defaultResult.results.map((result) => result.name)).toEqual(["legacyfilter", "complete-route"]);

    const filteredResult = await Effect.runPromise(
      search.search({ query: "legacyfilter", limit: 1, includeIncompleteMetadata: false })
    );
    expect(filteredResult.results.map((result) => result.name)).toEqual(["complete-route"]);
  });

  it("reports QMD failures without breaking FTS search", async () => {
    const root = await createSkillRoot({
      prd: "Generate a PRD for product planning."
    });
    const config = testConfig(root, { qmdEnabled: true, qmdCommand: "missing-qmd-binary-for-test" });
    const store = new CatalogStore(config);
    stores.push(store);
    const sync = await Effect.runPromise(scanSkillRoots(config));
    await Effect.runPromise(store.rebuild(sync));

    const search = new SearchService(config, store);
    const result = await Effect.runPromise(search.search({ query: "prd", limit: 3 }));

    expect(result.results[0]?.name).toBe("prd");
    const status = await Effect.runPromise(store.status());
    expect(status.search_backends.qmd).toBe("unavailable");
    expect(status.search_backend_warnings[0]?.code).toBe("qmd_search_failed");
  });

  it("keeps blocked skills indexed for diagnostics but excludes search and reads", async () => {
    const root = await createSkillRoot({
      "blocked-skill": "Blocked skill for risky workflow."
    });
    await mkdir(path.join(root, "blocked-skill", "docs"), { recursive: true });
    await writeFile(path.join(root, "blocked-skill", "docs", "note.md"), "blocked note", "utf8");
    const config = testConfig(root, { trustStatus: "blocked" });
    const store = new CatalogStore(config);
    stores.push(store);
    const sync = await Effect.runPromise(scanSkillRoots(config));
    await Effect.runPromise(store.rebuild(sync));

    const status = await Effect.runPromise(store.status());
    expect(status.roots[0]?.skills_indexed).toBe(1);
    expect(status.metadata_warnings[0]).toMatchObject({
      skill: "blocked-skill",
      trust_status: "blocked"
    });

    const search = new SearchService(config, store);
    const result = await Effect.runPromise(search.search({ query: "blocked risky workflow", limit: 5 }));
    expect(result.results.map((item) => item.name)).not.toContain("blocked-skill");

    const refs = new ReferenceService(config, store);
    await expect(Effect.runPromise(refs.readSkill("blocked-skill"))).rejects.toThrow(/blocked/);
    await expect(Effect.runPromise(refs.readReference("blocked-skill", "docs/note.md"))).rejects.toThrow(
      /blocked/
    );
  });

  it("preserves audit history across rebuilds and records rebuild activity", async () => {
    const root = await createSkillRoot({
      prd: "Generate a PRD for product planning."
    });
    const config = testConfig(root);
    const store = new CatalogStore(config);
    stores.push(store);
    const sync = await Effect.runPromise(scanSkillRoots(config));
    await Effect.runPromise(store.rebuild(sync));

    const search = new SearchService(config, store);
    await Effect.runPromise(search.search({ query: "prd", limit: 1 }));
    await Effect.runPromise(store.rebuild(sync));

    const audit = await Effect.runPromise(store.auditLog(20));
    expect(audit.filter((entry) => entry.tool === "rebuild_index")).toHaveLength(2);
    expect(audit.some((entry) => entry.tool === "search_skills")).toBe(true);
  });

  it("recovers QMD status after a later successful backend call", async () => {
    const root = await createSkillRoot({
      prd: "Generate a PRD for product planning."
    });
    const marker = path.join(root, "qmd-success");
    const qmdCommand = path.join(root, "fake-qmd.js");
    await writeFakeQmd(qmdCommand, marker, path.join(root, "prd", "SKILL.md"));
    const config = testConfig(root, { qmdEnabled: true, qmdCommand });
    const store = new CatalogStore(config);
    stores.push(store);
    const sync = await Effect.runPromise(scanSkillRoots(config));
    await Effect.runPromise(store.rebuild(sync));
    const search = new SearchService(config, store);

    await Effect.runPromise(search.search({ query: "prd", limit: 3 }));
    const failedStatus = await Effect.runPromise(store.status());
    expect(failedStatus.search_backends.qmd).toBe("unavailable");
    expect(failedStatus.search_backend_warnings[0]?.code).toBe("qmd_search_failed");

    await writeFile(marker, "ok", "utf8");
    await Effect.runPromise(search.search({ query: "prd", limit: 3 }));
    const recoveredStatus = await Effect.runPromise(store.status());
    expect(recoveredStatus.search_backends.qmd).toBe("ready");
    expect(recoveredStatus.search_backend_warnings.some((warning) => warning.code === "qmd_search_failed")).toBe(
      true
    );
  });

  it("does not attribute a blocked absolute QMD hit to an allowed skill with the same relative path", async () => {
    const trustedRoot = await mkdtemp(path.join(os.tmpdir(), "skill-catalog-trusted-root-"));
    const blockedRoot = await mkdtemp(path.join(os.tmpdir(), "skill-catalog-blocked-root-"));
    await writeSkill(trustedRoot, "same-dir", "trusted-same", "Trusted skill for ordinary work.");
    await writeSkill(blockedRoot, "same-dir", "blocked-same", "Blocked skill for risky work.");
    const blockedSkillFile = path.join(blockedRoot, "same-dir", "SKILL.md");
    const qmdCommand = path.join(trustedRoot, "fake-qmd-blocked-path.js");
    await writeStaticFakeQmd(qmdCommand, blockedSkillFile);
    const config = testConfig(trustedRoot, {
      qmdEnabled: true,
      qmdCommand,
      extraRoots: [{ name: "blocked-root", path: blockedRoot, defaultTrustStatus: "blocked" }]
    });
    const store = new CatalogStore(config);
    stores.push(store);
    const sync = await Effect.runPromise(scanSkillRoots(config));
    await Effect.runPromise(store.rebuild(sync));

    const status = await Effect.runPromise(store.status());
    expect(status.roots.find((rootStatus) => rootStatus.name === "blocked-root")?.skills_indexed).toBe(1);

    const search = new SearchService(config, store);
    const result = await Effect.runPromise(search.search({ query: "vector-only-no-fts-hit", limit: 5 }));

    expect(result.results).toEqual([]);
  });

  it("returns QMD results for exact allowed skill file paths", async () => {
    const root = await createSkillRoot({
      "exact-qmd": "Plain skill without the vector query terms."
    });
    const skillFile = path.join(root, "exact-qmd", "SKILL.md");
    const qmdCommand = path.join(root, "fake-qmd-exact-path.js");
    await writeStaticFakeQmd(qmdCommand, skillFile);
    const config = testConfig(root, { qmdEnabled: true, qmdCommand });
    const store = new CatalogStore(config);
    stores.push(store);
    const sync = await Effect.runPromise(scanSkillRoots(config));
    await Effect.runPromise(store.rebuild(sync));

    const search = new SearchService(config, store);
    const result = await Effect.runPromise(search.search({ query: "vector-only-no-fts-hit", limit: 5 }));

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      name: "exact-qmd",
      matched_backends: ["qmd"]
    });
  });

  it("returns QMD results for cwd-relative full-path output", async () => {
    const root = await createCwdRelativeSkillRoot();
    await writeSkill(root, "cwd-qmd", "cwd-qmd", "Plain skill without the vector query terms.");
    const skillFile = path.join(root, "cwd-qmd", "SKILL.md");
    const relativeSkillFile = `./${path.relative(process.cwd(), skillFile).split(path.sep).join("/")}`;
    const qmdCommand = path.join(root, "fake-qmd-cwd-relative.js");
    await writeStaticFakeQmd(qmdCommand, relativeSkillFile);
    const config = testConfig(root, { qmdEnabled: true, qmdCommand });
    const store = new CatalogStore(config);
    stores.push(store);
    const sync = await Effect.runPromise(scanSkillRoots(config));
    await Effect.runPromise(store.rebuild(sync));

    const search = new SearchService(config, store);
    const result = await Effect.runPromise(search.search({ query: "vector-only-no-fts-hit", limit: 5 }));

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      name: "cwd-qmd",
      matched_backends: ["qmd"]
    });
  });

  it("ignores qmd URI output without suffix-based attribution", async () => {
    const root = await createSkillRoot({
      "uri-qmd": "Plain skill without the vector query terms."
    });
    const qmdCommand = path.join(root, "fake-qmd-uri.js");
    await writeStaticFakeQmd(qmdCommand, "qmd://skill-catalog/uri-qmd/SKILL.md");
    const config = testConfig(root, { qmdEnabled: true, qmdCommand });
    const store = new CatalogStore(config);
    stores.push(store);
    const sync = await Effect.runPromise(scanSkillRoots(config));
    await Effect.runPromise(store.rebuild(sync));

    const search = new SearchService(config, store);
    const result = await Effect.runPromise(search.search({ query: "vector-only-no-fts-hit", limit: 5 }));

    expect(result.results).toEqual([]);
  });
});

async function expectTopSearchResult(search: SearchService, query: string, expectedName: string): Promise<void> {
  const result = await Effect.runPromise(search.search({ query, limit: 3 }));
  expect(result.results[0]?.name).toBe(expectedName);
  expect(result.results[0]?.matched_backends).toContain("fts");
}

async function createSkillRoot(skills: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-catalog-root-"));
  for (const [dir, description] of Object.entries(skills)) {
    await writeSkill(root, dir, dir, description);
  }
  return root;
}

async function createCwdRelativeSkillRoot(): Promise<string> {
  const root = await mkdtemp(path.join(process.cwd(), ".tmp-qmd-cwd-"));
  tempDirs.push(root);
  return root;
}

async function writeSkill(root: string, dir: string, name: string, description: string): Promise<void> {
  const skillDir = path.join(root, dir);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: ${name}
description: ${JSON.stringify(description)}
---

# ${name}

## When to Use

- ${description}
`,
    "utf8"
  );
}

async function writeCustomSkill(root: string, dir: string, content: string): Promise<void> {
  const skillDir = path.join(root, dir);
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), content, "utf8");
}

async function writeFakeQmd(commandPath: string, markerPath: string, skillFile: string): Promise<void> {
  await writeFile(
    commandPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
if (!process.argv.includes("--full-path")) {
  console.error("missing --full-path");
  process.exit(2);
}
if (!fs.existsSync(${JSON.stringify(markerPath)})) {
  console.error("transient qmd failure");
  process.exit(1);
}
console.log(JSON.stringify([{ file: ${JSON.stringify(skillFile)}, score: 0.8 }]));
`,
    "utf8"
  );
  await chmod(commandPath, 0o755);
}

async function writeStaticFakeQmd(commandPath: string, skillFile: string): Promise<void> {
  await writeFile(
    commandPath,
    `#!/usr/bin/env node
if (!process.argv.includes("--full-path")) {
  console.error("missing --full-path");
  process.exit(2);
}
console.log(JSON.stringify([{ file: ${JSON.stringify(skillFile)}, score: 0.8 }]));
`,
    "utf8"
  );
  await chmod(commandPath, 0o755);
}

function testConfig(
  root: string,
  overrides: {
    readonly trustStatus?: AppConfig["roots"][number]["defaultTrustStatus"];
    readonly qmdEnabled?: boolean;
    readonly qmdCommand?: string;
    readonly extraRoots?: AppConfig["roots"];
  } = {}
): AppConfig {
  return {
    server: {
      transport: "streamable-http",
      host: "127.0.0.1",
      port: 7421,
      allowedHosts: [],
      maxSessions: 100,
      sessionIdleTtlMs: 1800000,
      bearerTokenEnv: undefined,
      sessionMode: "stateful"
    },
    roots: [
      { name: "test-root", path: root, defaultTrustStatus: overrides.trustStatus ?? "trusted" },
      ...(overrides.extraRoots ?? [])
    ],
    storage: { sqlitePath: ":memory:" },
    search: {
      defaultLimit: 5,
      maxLimit: 20,
      qmd: {
        enabled: overrides.qmdEnabled ?? false,
        collection: "skill-catalog",
        command: overrides.qmdCommand ?? "qmd"
      }
    },
    limits: {
      maxSkillBytes: 262144,
      maxInlineReferenceBytes: 1024,
      maxHttpBodyBytes: 1048576,
      followSymlinks: false,
      rateLimit: {
        enabled: true,
        windowMs: 60000,
        maxRequests: 120,
        maxEntries: 1000
      }
    }
  };
}
