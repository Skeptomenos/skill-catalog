import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { StorageError } from "../errors.js";
import type {
  AppConfig,
  CatalogStatus,
  MetadataWarning,
  RootStatus,
  SearchBackendWarning,
  SearchResultItem,
  SkillRecord,
  SyncError,
  SyncStatusError,
  SyncResult
} from "../types.js";

interface SkillRow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: string | null;
  readonly author_json: string | null;
  readonly version: string | null;
  readonly source_json: string | null;
  readonly source_root: string;
  readonly root_path: string;
  readonly relative_path: string;
  readonly skill_dir: string;
  readonly skill_file: string;
  readonly trust_status: string;
  readonly warnings_json: string;
  readonly triggers_json: string;
  readonly when_to_use_json: string;
  readonly when_not_to_use_json: string;
  readonly metadata_json: string;
  readonly content_hash: string;
  readonly updated_at: string;
  readonly body_text: string;
}

interface SearchRow extends SkillRow {
  readonly rank: number;
}

export interface AuditLogEntry {
  readonly id: number;
  readonly tool: string;
  readonly skill_name: string | null;
  readonly path: string | null;
  readonly caller: string | null;
  readonly duration_ms: number;
  readonly created_at: string;
}

export class CatalogStore {
  private readonly db: Database.Database;
  private readonly lastSyncErrors: SyncError[] = [];
  private readonly duplicateNames: string[] = [];
  private readonly searchBackendWarnings: SearchBackendWarning[] = [];
  private qmdBackendState: "ready" | "unavailable" | null = null;

  constructor(private readonly config: AppConfig) {
    if (config.storage.sqlitePath !== ":memory:") {
      mkdirSync(path.dirname(config.storage.sqlitePath), { recursive: true });
    }
    this.db = new Database(config.storage.sqlitePath);
    this.db.pragma("journal_mode = WAL");
    this.initializeSchema();
  }

  rebuild(sync: SyncResult): Effect.Effect<void, StorageError> {
    return Effect.try({
      try: () => {
        const tx = this.db.transaction(() => {
          this.db.exec("DELETE FROM skills_fts");
          this.db.exec("DELETE FROM skills");
          this.db.exec("DELETE FROM skill_sync_errors");
          const insertSkill = this.db.prepare(`
            INSERT INTO skills (
              id, name, description, category, author_json, version, source_json,
              source_root, root_path, relative_path, skill_dir, skill_file, trust_status, warnings_json,
              triggers_json, when_to_use_json, when_not_to_use_json,
              metadata_json, content_hash, updated_at, body_text
            ) VALUES (
              @id, @name, @description, @category, @author_json, @version, @source_json,
              @source_root, @root_path, @relative_path, @skill_dir, @skill_file, @trust_status, @warnings_json,
              @triggers_json, @when_to_use_json, @when_not_to_use_json,
              @metadata_json, @content_hash, @updated_at, @body_text
            )
          `);
          const insertFts = this.db.prepare(`
            INSERT INTO skills_fts (
              id, name, description, triggers, when_to_use, when_not_to_use, body_text
            ) VALUES (
              @id, @name, @description, @triggers, @when_to_use, @when_not_to_use, @body_text
            )
          `);
          const insertError = this.db.prepare(`
            INSERT INTO skill_sync_errors (source_root, path, code, message, seen_at)
            VALUES (@source_root, @path, @code, @message, @seen_at)
          `);

          for (const skill of sync.skills) {
            insertSkill.run(toSkillDbRow(skill));
            insertFts.run({
              id: skill.id,
              name: skill.name,
              description: skill.description,
              triggers: skill.triggers.join("\n"),
              when_to_use: skill.whenToUse.join("\n"),
              when_not_to_use: skill.whenNotToUse.join("\n"),
              body_text: skill.bodyText
            });
          }

          const seenAt = new Date().toISOString();
          for (const error of sync.errors) {
            insertError.run({
              source_root: error.sourceRoot,
              path: error.path,
              code: error.code,
              message: error.message,
              seen_at: seenAt
            });
          }
        });
        tx();
        this.lastSyncErrors.splice(0, this.lastSyncErrors.length, ...sync.errors);
        this.duplicateNames.splice(0, this.duplicateNames.length, ...sync.duplicateNames);
        this.audit("rebuild_index", null, null, 0);
      },
      catch: (error) => new StorageError(error instanceof Error ? error.message : String(error))
    });
  }

  searchFts(
    query: string,
    limit: number,
    options: { readonly completeOnly?: boolean } = {}
  ): Effect.Effect<readonly SearchResultItem[], StorageError> {
    return Effect.try({
      try: () => {
        const ftsQuery = toFtsQuery(query);
        if (!ftsQuery) {
          return [];
        }
        const completeMetadataWhere = options.completeOnly
          ? `
              AND s.warnings_json = '[]'
              AND s.triggers_json <> '[]'
              AND s.when_to_use_json <> '[]'
              AND s.when_not_to_use_json <> '[]'
            `
          : "";
        const rows = this.db
          .prepare(
            `
            SELECT s.*, bm25(skills_fts, 0.0, 10.0, 6.0, 5.0, 4.0, 3.0, 0.25) AS rank
            FROM skills_fts
            JOIN skills s ON s.id = skills_fts.id
            WHERE skills_fts MATCH ?
              AND s.trust_status <> 'blocked'
              ${completeMetadataWhere}
            ORDER BY rank ASC
            LIMIT ?
          `
          )
          .all(ftsQuery, limit) as SearchRow[];
        return rows.map((row, index) => toSearchResult(row, query, index));
      },
      catch: (error) => new StorageError(error instanceof Error ? error.message : String(error))
    });
  }

  getSkillByNameOrId(nameOrId: string): Effect.Effect<SkillRecord, StorageError> {
    return Effect.try({
      try: () => {
        const row = this.db
          .prepare("SELECT * FROM skills WHERE name = ? OR id = ? LIMIT 1")
          .get(nameOrId, nameOrId) as SkillRow | undefined;
        if (!row) {
          throw new StorageError(`Skill not found: ${nameOrId}`);
        }
        return fromSkillDbRow(row);
      },
      catch: (error) => (error instanceof StorageError ? error : new StorageError(String(error)))
    });
  }

  getAllSkills(): Effect.Effect<readonly SkillRecord[], StorageError> {
    return Effect.try({
      try: () => {
        const rows = this.db.prepare("SELECT * FROM skills ORDER BY name ASC").all() as SkillRow[];
        return rows.map(fromSkillDbRow);
      },
      catch: (error) => new StorageError(error instanceof Error ? error.message : String(error))
    });
  }

  status(): Effect.Effect<CatalogStatus, StorageError> {
    return Effect.try({
      try: () => {
        const skillRows = this.db
          .prepare("SELECT source_root, root_path, COUNT(*) as count FROM skills GROUP BY source_root, root_path")
          .all() as Array<{ source_root: string; root_path: string; count: number }>;
        const roots: RootStatus[] = this.config.roots.map((root) => {
          const row = skillRows.find((candidate) => candidate.source_root === root.name);
          return {
            name: root.name,
            path: root.path,
            default_trust_status: root.defaultTrustStatus,
            skills_indexed: row?.count ?? 0,
            errors: this.lastSyncErrors
              .filter((error) => error.sourceRoot === root.name)
              .map(toSyncStatusError)
          };
        });
        return {
          roots,
          duplicate_names: [...this.duplicateNames],
          metadata_warnings: this.metadataWarnings(),
          search_backends: {
            fts: this.countSkills() > 0 ? "ready" : "empty",
            qmd: this.qmdStatus()
          },
          search_backend_warnings: [...this.searchBackendWarnings]
        };
      },
      catch: (error) => new StorageError(error instanceof Error ? error.message : String(error))
    });
  }

  audit(tool: string, skillName: string | null, refPath: string | null, durationMs: number): void {
    this.db
      .prepare(
        `
        INSERT INTO audit_log (tool, skill_name, path, caller, duration_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `
      )
      .run(tool, skillName, refPath, null, durationMs, new Date().toISOString());
  }

  auditLog(limit = 100): Effect.Effect<readonly AuditLogEntry[], StorageError> {
    return Effect.try({
      try: () => {
        const normalizedLimit = Math.min(Math.max(1, limit), 500);
        return this.db
          .prepare(
            `
            SELECT id, tool, skill_name, path, caller, duration_ms, created_at
            FROM audit_log
            ORDER BY id DESC
            LIMIT ?
          `
          )
          .all(normalizedLimit) as AuditLogEntry[];
      },
      catch: (error) => new StorageError(error instanceof Error ? error.message : String(error))
    });
  }

  recordSearchBackendWarning(warning: SearchBackendWarning): void {
    if (warning.backend === "qmd") {
      this.qmdBackendState = "unavailable";
    }
    this.searchBackendWarnings.unshift(warning);
    this.searchBackendWarnings.splice(20);
  }

  recordSearchBackendReady(backend: "qmd"): void {
    if (backend === "qmd") {
      this.qmdBackendState = "ready";
    }
  }

  close(): void {
    this.db.close();
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skills(
        id text primary key,
        name text not null unique,
        description text not null,
        category text,
        author_json text,
        version text,
        source_json text,
        source_root text not null,
        root_path text not null,
        relative_path text not null,
        skill_dir text not null,
        skill_file text not null,
        trust_status text not null default 'trusted',
        warnings_json text not null default '[]',
        triggers_json text not null,
        when_to_use_json text not null,
        when_not_to_use_json text not null,
        metadata_json text not null,
        content_hash text not null,
        updated_at text not null,
        body_text text not null
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
        id UNINDEXED,
        name,
        description,
        triggers,
        when_to_use,
        when_not_to_use,
        body_text
      );

      CREATE TABLE IF NOT EXISTS skill_sync_errors(
        id integer primary key,
        source_root text not null,
        path text not null,
        code text not null,
        message text not null,
        seen_at text not null
      );

      CREATE TABLE IF NOT EXISTS audit_log(
        id integer primary key,
        tool text not null,
        skill_name text,
        path text,
        caller text,
        duration_ms integer not null,
        created_at text not null
      );
    `);
    this.ensureSkillsColumn("author_json", "text");
    this.ensureSkillsColumn("version", "text");
    this.ensureSkillsColumn("source_json", "text");
    this.ensureSkillsColumn("trust_status", "text not null default 'trusted'");
    this.ensureSkillsColumn("warnings_json", "text not null default '[]'");
  }

  private countSkills(): number {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM skills").get() as { count: number };
    return row.count;
  }

  private ensureSkillsColumn(name: string, definition: string): void {
    const columns = this.db.prepare("PRAGMA table_info(skills)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === name)) {
      this.db.exec(`ALTER TABLE skills ADD COLUMN ${name} ${definition}`);
    }
  }

  private qmdStatus(): "disabled" | "ready" | "unavailable" {
    if (!this.config.search.qmd.enabled) {
      return "disabled";
    }
    return this.qmdBackendState ?? "ready";
  }

  private metadataWarnings(): readonly MetadataWarning[] {
    const rows = this.db.prepare("SELECT * FROM skills").all() as SkillRow[];
    return rows.flatMap((row) => {
      const skill = fromSkillDbRow(row);
      const missing = [
        [skill.triggers.length, "triggers"],
        [skill.whenToUse.length, "when_to_use"],
        [skill.whenNotToUse.length, "when_not_to_use"],
        [skill.author ? 1 : 0, "author"],
        [hasWarning(skill, "missing_version") || hasWarning(skill, "invalid_version") ? 0 : 1, "version"],
        [skill.source ? 1 : 0, "source"]
      ].flatMap(([count, field]) => (count === 0 ? [field as string] : []));
      return missing.length > 0 || skill.warnings.length > 0
        ? [
            {
              skill: skill.name,
              source_root: skill.sourceRoot,
              trust_status: skill.trustStatus,
              missing_fields: missing,
              warnings: skill.warnings
            }
          ]
        : [];
    });
  }
}

function toSyncStatusError(error: SyncError): SyncStatusError {
  return {
    source_root: error.sourceRoot,
    path: error.path,
    code: error.code,
    message: error.message
  };
}

function toSkillDbRow(skill: SkillRecord): SkillRow {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    category: skill.category,
    author_json: skill.author ? JSON.stringify(skill.author) : null,
    version: skill.version,
    source_json: skill.source ? JSON.stringify(skill.source) : null,
    source_root: skill.sourceRoot,
    root_path: skill.rootPath,
    relative_path: skill.relativePath,
    skill_dir: skill.skillDir,
    skill_file: skill.skillFile,
    trust_status: skill.trustStatus,
    warnings_json: JSON.stringify(skill.warnings),
    triggers_json: JSON.stringify(skill.triggers),
    when_to_use_json: JSON.stringify(skill.whenToUse),
    when_not_to_use_json: JSON.stringify(skill.whenNotToUse),
    metadata_json: JSON.stringify(skill.metadata),
    content_hash: skill.contentHash,
    updated_at: skill.updatedAt,
    body_text: skill.bodyText
  };
}

function fromSkillDbRow(row: SkillRow): SkillRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    author: parseNullableJson<NonNullable<SkillRecord["author"]>>(row.author_json),
    version: row.version,
    source: parseNullableJson<NonNullable<SkillRecord["source"]>>(row.source_json),
    sourceRoot: row.source_root,
    rootPath: row.root_path,
    relativePath: row.relative_path,
    skillDir: row.skill_dir,
    skillFile: row.skill_file,
    trustStatus: row.trust_status as SkillRecord["trustStatus"],
    warnings: JSON.parse(row.warnings_json) as SkillRecord["warnings"],
    triggers: JSON.parse(row.triggers_json) as readonly string[],
    whenToUse: JSON.parse(row.when_to_use_json) as readonly string[],
    whenNotToUse: JSON.parse(row.when_not_to_use_json) as readonly string[],
    metadata: JSON.parse(row.metadata_json) as Readonly<Record<string, unknown>>,
    contentHash: row.content_hash,
    updatedAt: row.updated_at,
    bodyText: row.body_text
  };
}

function hasWarning(skill: SkillRecord, code: string): boolean {
  return skill.warnings.some((warning) => warning.code === code);
}

function parseNullableJson<T>(value: string | null): T | null {
  return value ? (JSON.parse(value) as T) : null;
}

function toFtsQuery(query: string): string {
  const tokens = tokenizeQuery(query);
  return tokens.length > 0 ? tokens.map((token) => `${token}*`).join(" OR ") : "";
}

function toSearchResult(row: SearchRow, query: string, index: number): SearchResultItem {
  const skill = fromSkillDbRow(row);
  const matchedFields = matchedFieldsFor(skill, query);
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    category: skill.category,
    author: skill.author,
    version: skill.version,
    source: skill.source,
    triggers: skill.triggers,
    when_to_use: skill.whenToUse,
    when_not_to_use: skill.whenNotToUse,
    source_root: skill.sourceRoot,
    trust_status: skill.trustStatus,
    warnings: skill.warnings,
    score: Number((1 / (index + 1)).toFixed(4)),
    matched_backends: ["fts"],
    matched_fields: matchedFields,
    why_match:
      matchedFields.length > 0
        ? `Matched ${matchedFields.join(", ")} via SQLite FTS.`
        : "Matched via SQLite FTS."
  };
}

function matchedFieldsFor(skill: SkillRecord, query: string): readonly string[] {
  const tokens = tokenizeQuery(query);
  const fields: Array<[string, string]> = [
    ["name", skill.name],
    ["description", skill.description],
    ["triggers", skill.triggers.join("\n")],
    ["when_to_use", skill.whenToUse.join("\n")],
    ["when_not_to_use", skill.whenNotToUse.join("\n")],
    ["body", skill.bodyText]
  ];
  return fields
    .filter(([, value]) => tokens.some((token) => value.toLowerCase().includes(token.toLowerCase())))
    .map(([field]) => field);
}

function tokenizeQuery(query: string): readonly string[] {
  return [...new Set(query.toLowerCase().match(/[a-z0-9]+/gi) ?? [])];
}
