import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig, RootConfig } from "../src/types.js";
import { scanSkillRoots } from "../src/skills/scanner.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const tempDir of tempDirs.splice(0)) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("skill root scanner edge cases", () => {
  it("rejects a symlinked root with a symlink error and indexes nothing from it", async () => {
    const base = await tempDir("scanner-symlink-root-");
    const realRoot = path.join(base, "real");
    await writeSkill(realRoot, "inside", "inside", "Skill behind a symlinked root.");
    const linkedRoot = path.join(base, "linked");
    await symlink(realRoot, linkedRoot);

    const sync = await Effect.runPromise(scanSkillRoots(config([root("linked-root", linkedRoot)])));

    expect(sync.skills).toHaveLength(0);
    expect(sync.errors).toMatchObject([
      { sourceRoot: "linked-root", path: linkedRoot, code: "symlink_root" }
    ]);
  });

  it("rejects a root that is a file, not a directory", async () => {
    const base = await tempDir("scanner-file-root-");
    const filePath = path.join(base, "not-a-dir");
    await writeFile(filePath, "plain file", "utf8");

    const sync = await Effect.runPromise(scanSkillRoots(config([root("file-root", filePath)])));

    expect(sync.skills).toHaveLength(0);
    expect(sync.errors).toMatchObject([{ sourceRoot: "file-root", code: "invalid_root" }]);
  });

  it("reports nested symlink directories and files as sync errors without indexing them", async () => {
    const base = await tempDir("scanner-nested-symlink-");
    const rootPath = path.join(base, "root");
    await writeSkill(rootPath, "honest", "honest", "Regular skill next to symlinks.");
    const outside = path.join(base, "outside");
    await writeSkill(outside, "escape", "escape", "Skill outside the root.");
    await symlink(path.join(outside, "escape"), path.join(rootPath, "linked-dir"));
    await symlink(
      path.join(outside, "escape", "SKILL.md"),
      path.join(rootPath, "honest", "linked-file.md")
    );

    const sync = await Effect.runPromise(scanSkillRoots(config([root("test-root", rootPath)])));

    expect(sync.skills.map((skill) => skill.name)).toEqual(["honest"]);
    const symlinkErrors = sync.errors.filter((error) => error.code === "symlink_rejected");
    expect(symlinkErrors.map((error) => error.path).sort()).toEqual([
      path.join("honest", "linked-file.md"),
      "linked-dir"
    ]);
  });

  it("keeps scanning a root when one SKILL.md has malformed frontmatter", async () => {
    const base = await tempDir("scanner-malformed-");
    const rootPath = path.join(base, "root");
    await writeSkill(rootPath, "good", "good", "Valid skill in the same root.");
    await writeCustomSkill(rootPath, "no-name", "---\ndescription: Missing name.\n---\n\n# Broken\n");
    await writeCustomSkill(rootPath, "bad-yaml", "---\nname: [unclosed\n---\n\n# Broken YAML\n");

    const sync = await Effect.runPromise(scanSkillRoots(config([root("test-root", rootPath)])));

    expect(sync.skills.map((skill) => skill.name)).toEqual(["good"]);
    expect(sync.errors).toHaveLength(2);
    expect(sync.errors).toContainEqual(
      expect.objectContaining({
        sourceRoot: "test-root",
        path: path.join("no-name", "SKILL.md"),
        code: "missing_required_metadata"
      })
    );
    expect(sync.errors).toContainEqual(
      expect.objectContaining({
        sourceRoot: "test-root",
        path: path.join("bad-yaml", "SKILL.md"),
        code: "parse_error"
      })
    );
  });

  it("reports duplicate names across roots and excludes them from the indexed set", async () => {
    const base = await tempDir("scanner-cross-root-dupes-");
    const first = path.join(base, "first");
    const second = path.join(base, "second");
    await writeSkill(first, "shared", "shared", "First copy.");
    await writeSkill(first, "unique-a", "unique-a", "Unique to the first root.");
    await writeSkill(second, "shared", "shared", "Second copy.");
    await writeSkill(second, "unique-b", "unique-b", "Unique to the second root.");

    const sync = await Effect.runPromise(
      scanSkillRoots(config([root("first-root", first), root("second-root", second)]))
    );

    expect(sync.duplicateNames).toEqual(["shared"]);
    expect(sync.skills.map((skill) => skill.name).sort()).toEqual(["unique-a", "unique-b"]);
    expect(sync.errors).toContainEqual(
      expect.objectContaining({ sourceRoot: "global", code: "duplicate_skill_name", path: "shared" })
    );
  });

  it("discovers deeply nested packages, including packages below another package", async () => {
    const base = await tempDir("scanner-nested-packages-");
    const rootPath = path.join(base, "root");
    await writeSkill(rootPath, path.join("group-a", "alpha"), "alpha", "Nested under group-a.");
    await writeSkill(rootPath, path.join("group-b", "sub", "beta"), "beta", "Deeply nested.");
    await writeSkill(rootPath, "parent", "parent", "Package with a nested package inside.");
    await writeSkill(rootPath, path.join("parent", "child"), "child", "Nested below parent.");

    const sync = await Effect.runPromise(scanSkillRoots(config([root("test-root", rootPath)])));

    expect(sync.skills.map((skill) => skill.name).sort()).toEqual(["alpha", "beta", "child", "parent"]);
    expect(sync.errors).toHaveLength(0);
  });
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeSkill(root: string, dir: string, name: string, description: string): Promise<void> {
  await writeCustomSkill(
    root,
    dir,
    `---
name: ${name}
description: ${JSON.stringify(description)}
---

# ${name}
`
  );
}

async function writeCustomSkill(root: string, dir: string, content: string): Promise<void> {
  const skillDir = path.join(root, dir);
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), content, "utf8");
}

function root(name: string, rootPath: string): RootConfig {
  return { name, path: rootPath, defaultTrustStatus: "trusted" };
}

function config(roots: readonly RootConfig[]): AppConfig {
  return {
    server: {
      transport: "streamable-http",
      host: "127.0.0.1",
      port: 0,
      allowedHosts: [],
      maxSessions: 100,
      sessionIdleTtlMs: 1800000,
      bearerTokenEnv: undefined,
      sessionMode: "stateful"
    },
    roots: [...roots],
    storage: { sqlitePath: ":memory:" },
    search: {
      defaultLimit: 5,
      maxLimit: 20,
      qmd: {
        enabled: false,
        collection: "skill-catalog",
        command: "qmd"
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
