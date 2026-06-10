import { chmod, mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/types.js";
import { ReferenceService } from "../src/reference/reference-service.js";
import { scanSkillRoots } from "../src/skills/scanner.js";
import { CatalogStore } from "../src/storage/catalog-store.js";

const stores: CatalogStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
});

describe("ReferenceService", () => {
  it("reads SKILL.md and text references", async () => {
    const { config, store } = await buildReferenceFixture();
    const refs = new ReferenceService(config, store);

    const skill = await Effect.runPromise(refs.readSkill("demo"));
    expect(skill.content).toContain("name: demo");

    const reference = await Effect.runPromise(refs.readReference("demo", "docs/template.md"));
    expect(reference.content).toContain("Template body");
    expect(reference.inline_blocked_reason).toBeUndefined();
  });

  it("rejects path traversal", async () => {
    const { config, store } = await buildReferenceFixture();
    const refs = new ReferenceService(config, store);

    await expect(Effect.runPromise(refs.readReference("demo", "../outside.md"))).rejects.toThrow(
      /traverse outside/
    );
  });

  it("rejects null bytes in reference paths", async () => {
    const { config, store } = await buildReferenceFixture();
    const refs = new ReferenceService(config, store);

    await expect(Effect.runPromise(refs.readReference("demo", "docs/template.md\0.md"))).rejects.toThrow(
      /null byte/
    );
  });

  it("rejects symlink reference paths", async () => {
    const { root, config, store } = await buildReferenceFixture();
    await writeFile(path.join(root, "outside.md"), "secret", "utf8");
    await symlink(path.join(root, "outside.md"), path.join(root, "demo", "docs", "linked.md"));
    const refs = new ReferenceService(config, store);

    await expect(Effect.runPromise(refs.readReference("demo", "docs/linked.md"))).rejects.toThrow(/Symlinks/);
  });

  it("returns metadata only for oversized references", async () => {
    const { root, config, store } = await buildReferenceFixture();
    await writeFile(path.join(root, "demo", "docs", "large.md"), "x".repeat(2048), "utf8");
    const refs = new ReferenceService(config, store);

    const reference = await Effect.runPromise(refs.readReference("demo", "docs/large.md"));
    expect(reference.content).toBeNull();
    expect(reference.inline_blocked_reason).toBe("size_limit");
    expect(reference.sha256).toBeNull();
  });

  it("does not read oversized references before returning size-limit metadata", async () => {
    const { root, config, store } = await buildReferenceFixture();
    const largePath = path.join(root, "demo", "docs", "large-unreadable.md");
    await writeFile(largePath, "x".repeat(2048), "utf8");
    await chmod(largePath, 0o000);
    const refs = new ReferenceService(config, store);

    const reference = await Effect.runPromise(refs.readReference("demo", "docs/large-unreadable.md"));
    expect(reference).toMatchObject({
      content: null,
      inline_blocked_reason: "size_limit",
      sha256: null
    });
  });
});

async function buildReferenceFixture(): Promise<{ root: string; config: AppConfig; store: CatalogStore }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-catalog-reference-"));
  await mkdir(path.join(root, "demo", "docs"), { recursive: true });
  await writeFile(
    path.join(root, "demo", "SKILL.md"),
    `---
name: demo
description: Demo skill.
---

# Demo
`,
    "utf8"
  );
  await writeFile(path.join(root, "demo", "docs", "template.md"), "Template body", "utf8");
  const config = testConfig(root);
  const store = new CatalogStore(config);
  stores.push(store);
  const sync = await Effect.runPromise(scanSkillRoots(config));
  await Effect.runPromise(store.rebuild(sync));
  return { root, config, store };
}

function testConfig(root: string): AppConfig {
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
    roots: [{ name: "test-root", path: root, defaultTrustStatus: "trusted" }],
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
