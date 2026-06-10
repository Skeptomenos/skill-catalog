import { createHash } from "node:crypto";
import path from "node:path";
import matter from "gray-matter";
import type { RootConfig, SkillAuthor, SkillRecord, SkillSource, SkillSourceType, SkillWarning, SyncError } from "../types.js";

const SOURCE_TYPES = new Set<SkillSourceType>([
  "self",
  "local_catalog",
  "remote_catalog",
  "git",
  "website",
  "npm"
]);

const SOURCE_STRING_FIELDS = [
  "name",
  "url",
  "path",
  "ref",
  "commit",
  "package",
  "version",
  "command",
  "catalog"
] as const;

export interface ParsedSkillResult {
  readonly skill?: SkillRecord;
  readonly error?: SyncError;
}

export function parseSkillFile(params: {
  readonly sourceRoot: RootConfig;
  readonly skillFile: string;
  readonly content: string;
  readonly mtimeMs: number;
}): ParsedSkillResult {
  const relativeSkillFile = path.relative(params.sourceRoot.path, params.skillFile);
  const relativeSkillDir = path.dirname(relativeSkillFile);
  try {
    const parsed = matter(params.content);
    const metadata = normalizeMetadata(parsed.data);
    const name = stringField(metadata.name);
    const description = stringField(metadata.description);

    if (!name || !description) {
      return {
        error: {
          sourceRoot: params.sourceRoot.name,
          path: relativeSkillFile,
          code: "missing_required_metadata",
          message: "SKILL.md frontmatter must include non-empty name and description"
        }
      };
    }

    const bodySections = extractBodySections(parsed.content);
    const triggers = normalizeStringArray(metadata.triggers);
    const whenToUse = normalizeStringArray(metadata.when_to_use);
    const whenNotToUse = normalizeStringArray(metadata.when_not_to_use);
    const category = stringField(metadata.category) ?? categoryFromRelativePath(relativeSkillDir);
    const author = normalizeAuthor(metadata.author);
    const version = versionField(metadata.version, params.content);
    const source = normalizeSource(metadata.source);
    const warnings = metadataWarnings({
      author,
      rawAuthor: metadata.author,
      version,
      rawVersion: metadata.version,
      source,
      rawSource: metadata.source,
      sourceRoot: params.sourceRoot
    });

    const skill: SkillRecord = {
      id: stableSkillId(params.sourceRoot.name, relativeSkillDir),
      name,
      description,
      category,
      author,
      version,
      source,
      sourceRoot: params.sourceRoot.name,
      rootPath: params.sourceRoot.path,
      relativePath: relativeSkillDir === "." ? "" : relativeSkillDir,
      skillDir: path.dirname(params.skillFile),
      skillFile: params.skillFile,
      trustStatus: params.sourceRoot.defaultTrustStatus,
      warnings,
      triggers,
      whenToUse: whenToUse.length > 0 ? whenToUse : bodySections.whenToUse,
      whenNotToUse: whenNotToUse.length > 0 ? whenNotToUse : bodySections.whenNotToUse,
      metadata,
      contentHash: sha256(params.content),
      updatedAt: new Date(params.mtimeMs).toISOString(),
      bodyText: parsed.content
    };

    return { skill };
  } catch (error) {
    return {
      error: {
        sourceRoot: params.sourceRoot.name,
        path: relativeSkillFile,
        code: "parse_error",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

export function stableSkillId(sourceRootName: string, relativeSkillDir: string): string {
  const hash = createHash("sha256").update(`${sourceRootName}:${relativeSkillDir}`).digest("hex").slice(0, 16);
  return `skill_${hash}`;
}

function normalizeMetadata(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function versionField(value: unknown, content: string): string | null {
  const stringVersion = stringField(value);
  if (stringVersion) {
    return stringVersion;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return rawFrontmatterScalar(content, "version") ?? String(value);
}

function rawFrontmatterScalar(content: string, key: string): string | null {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1];
  if (!frontmatter) {
    return null;
  }
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const value = new RegExp(`^${escapedKey}:\\s*(.+?)\\s*$`, "m").exec(frontmatter)?.[1]?.trim();
  if (!value) {
    return null;
  }
  return stripMatchingQuotes(value);
}

function stripMatchingQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function normalizeStringArray(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => (typeof item === "string" && item.trim() ? [item.trim()] : []));
  }
  if (typeof value === "string" && value.trim()) {
    return value
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeAuthor(value: unknown): SkillAuthor | null {
  const name = stringField(value);
  if (name) {
    return { name };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const objectName = stringField(record.name);
  if (!objectName) {
    return null;
  }
  const url = stringField(record.url);
  return url ? { name: objectName, url } : { name: objectName };
}

function normalizeSource(value: unknown): SkillSource | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const type = stringField(record.type);
  if (!type || !SOURCE_TYPES.has(type as SkillSourceType)) {
    return null;
  }
  const source: Record<string, string> = { type };
  for (const field of SOURCE_STRING_FIELDS) {
    const fieldValue = stringField(record[field]);
    if (fieldValue) {
      source[field] = fieldValue;
    }
  }
  return source as unknown as SkillSource;
}

function metadataWarnings(params: {
  readonly author: SkillAuthor | null;
  readonly rawAuthor: unknown;
  readonly version: string | null;
  readonly rawVersion: unknown;
  readonly source: SkillSource | null;
  readonly rawSource: unknown;
  readonly sourceRoot: RootConfig;
}): readonly SkillWarning[] {
  const warnings: SkillWarning[] = [];

  if (!params.author) {
    warnings.push({
      code: params.rawAuthor === undefined ? "missing_author" : "invalid_author",
      message:
        params.rawAuthor === undefined
          ? "Skill frontmatter is missing author metadata."
          : "Skill frontmatter author metadata must be a string or object with a name."
    });
  }

  if (!params.source) {
    warnings.push({
      code: params.rawSource === undefined ? "missing_source" : "invalid_source",
      message:
        params.rawSource === undefined
          ? "Skill frontmatter is missing source metadata."
          : "Skill frontmatter source metadata must include a supported source.type."
    });
  }

  const imported = params.source ? params.source.type !== "self" : false;
  if (!params.version && !imported) {
    warnings.push({
      code: params.rawVersion === undefined ? "missing_version" : "invalid_version",
      message:
        params.rawVersion === undefined
          ? "Skill frontmatter is missing top-level version metadata."
          : "Skill frontmatter version metadata must be a non-empty string."
    });
  }

  if (params.sourceRoot.defaultTrustStatus === "review_required") {
    warnings.push({
      code: "review_required",
      message: `Root ${params.sourceRoot.name} marks indexed skills as review_required.`
    });
  }

  if (params.sourceRoot.defaultTrustStatus === "blocked") {
    warnings.push({
      code: "blocked",
      message: `Root ${params.sourceRoot.name} marks indexed skills as blocked.`
    });
  }

  return warnings;
}

function categoryFromRelativePath(relativeSkillDir: string): string | null {
  const normalized = relativeSkillDir.split(path.sep).join("/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join("/") : null;
}

function extractBodySections(body: string): {
  readonly whenToUse: readonly string[];
  readonly whenNotToUse: readonly string[];
} {
  const lines = body.split(/\r?\n/);
  const whenToUse: string[] = [];
  const whenNotToUse: string[] = [];
  let active: "whenToUse" | "whenNotToUse" | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const heading = line.match(/^#{2,6}\s+(.+)$/);
    if (heading) {
      const title = heading[1].toLowerCase();
      if (title.includes("when to use") || title.includes("when to activate") || title.includes("when to write")) {
        active = "whenToUse";
      } else if (title.includes("when not") || title.includes("do not")) {
        active = "whenNotToUse";
      } else {
        active = null;
      }
      continue;
    }

    if (/^\*\*do not use when:\*\*/i.test(line) || /^\*\*do not/i.test(line)) {
      active = "whenNotToUse";
      continue;
    }

    if (!active) {
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      const value = bullet[1].trim();
      if (active === "whenToUse") {
        whenToUse.push(value);
      } else {
        whenNotToUse.push(value);
      }
    } else if (line === "" || line === "---") {
      continue;
    } else if (!line.startsWith("<!--")) {
      active = null;
    }
  }

  return { whenToUse, whenNotToUse };
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
