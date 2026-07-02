import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/types.js";
import { scanSkillRoots } from "../src/skills/scanner.js";
import { CatalogStore } from "../src/storage/catalog-store.js";

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

// Columns added after the initial V1 schema; ensureSkillsColumn must add each
// one when opening an old database. Keep in sync with initializeSchema().
const MIGRATED_COLUMNS = ["author_json", "version", "source_json", "trust_status", "warnings_json"];

describe("catalog store SQLite migration", () => {
  it("opens a pre-current database, migrates columns, and keeps rebuild/search/status working", async () => {
    const sqlitePath = await createLegacyDatabase();
    const root = await createSkillRoot();
    const config = testConfig(root, sqlitePath);

    const store = new CatalogStore(config);
    stores.push(store);

    const migrated = new Database(sqlitePath, { readonly: true });
    const columns = (migrated.prepare("PRAGMA table_info(skills)").all() as Array<{ name: string }>).map(
      (column) => column.name
    );
    migrated.close();
    for (const column of MIGRATED_COLUMNS) {
      expect(columns, `migrated skills column ${column}`).toContain(column);
    }

    const sync = await Effect.runPromise(scanSkillRoots(config));
    await Effect.runPromise(store.rebuild(sync));

    const results = await Effect.runPromise(store.searchFts("migrationprobe", 5));
    expect(results[0]?.name).toBe("migration-probe");
    expect(results[0]?.trust_status).toBe("trusted");

    const status = await Effect.runPromise(store.status());
    expect(status.roots[0]?.skills_indexed).toBe(1);
    expect(status.search_backends.fts).toBe("ready");
  });

  it("preserves pre-existing audit rows across the schema update", async () => {
    const sqlitePath = await createLegacyDatabase();
    const root = await createSkillRoot();
    const config = testConfig(root, sqlitePath);

    const store = new CatalogStore(config);
    stores.push(store);
    store.audit("read_skill", "migration-probe", null, 3);

    const entries = await Effect.runPromise(store.auditLog(10));
    const tools = entries.map((entry) => entry.tool);
    expect(tools).toContain("legacy_search");
    expect(tools).toContain("read_skill");
    const legacyEntry = entries.find((entry) => entry.tool === "legacy_search");
    expect(legacyEntry).toMatchObject({ skill_name: "legacy-skill", duration_ms: 12 });
  });

  it("fails loudly if a required newer column cannot be selected after open", async () => {
    // Guards against a future schema change silently dropping migration
    // compatibility: after opening an old DB, every current query column must
    // exist. A raw SELECT of each migrated column must not throw.
    const sqlitePath = await createLegacyDatabase();
    const root = await createSkillRoot();
    const store = new CatalogStore(testConfig(root, sqlitePath));
    stores.push(store);

    const db = new Database(sqlitePath, { readonly: true });
    expect(() => db.prepare(`SELECT ${MIGRATED_COLUMNS.join(", ")} FROM skills`).all()).not.toThrow();
    db.close();
  });
});

// Replicates the original V1 skills/audit_log schema before author/version/
// source/trust/warnings columns existed.
async function createLegacyDatabase(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "skill-catalog-migration-db-"));
  tempDirs.push(dir);
  const sqlitePath = path.join(dir, "catalog.sqlite");
  const db = new Database(sqlitePath);
  db.exec(`
    CREATE TABLE skills(
      id text primary key,
      name text not null unique,
      description text not null,
      category text,
      source_root text not null,
      root_path text not null,
      relative_path text not null,
      skill_dir text not null,
      skill_file text not null,
      triggers_json text not null,
      when_to_use_json text not null,
      when_not_to_use_json text not null,
      metadata_json text not null,
      content_hash text not null,
      updated_at text not null,
      body_text text not null
    );

    CREATE VIRTUAL TABLE skills_fts USING fts5(
      id UNINDEXED,
      name,
      description,
      triggers,
      when_to_use,
      when_not_to_use,
      body_text
    );

    CREATE TABLE skill_sync_errors(
      id integer primary key,
      source_root text not null,
      path text not null,
      code text not null,
      message text not null,
      seen_at text not null
    );

    CREATE TABLE audit_log(
      id integer primary key,
      tool text not null,
      skill_name text,
      path text,
      caller text,
      duration_ms integer not null,
      created_at text not null
    );
  `);
  db.prepare(
    "INSERT INTO audit_log (tool, skill_name, path, caller, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run("legacy_search", "legacy-skill", null, null, 12, "2026-01-01T00:00:00.000Z");
  db.close();
  return sqlitePath;
}

async function createSkillRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-catalog-migration-root-"));
  tempDirs.push(root);
  const skillDir = path.join(root, "migration-probe");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: migration-probe
description: Probe skill for migrationprobe database compatibility checks.
---

# Migration Probe

migrationprobe body.
`,
    "utf8"
  );
  return root;
}

function testConfig(root: string, sqlitePath: string): AppConfig {
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
    roots: [{ name: "test-root", path: root, defaultTrustStatus: "trusted" }],
    storage: { sqlitePath },
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
