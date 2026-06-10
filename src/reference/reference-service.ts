import { createHash } from "node:crypto";
import { lstat, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { lookup } from "mime-types";
import { Effect } from "effect";
import { LimitError, PathGuardError, StorageError } from "../errors.js";
import type { AppConfig, ReadReferenceResponse, ReadSkillResponse, SkillRecord } from "../types.js";
import { CatalogStore } from "../storage/catalog-store.js";

export class ReferenceService {
  constructor(
    private readonly config: AppConfig,
    private readonly store: CatalogStore
  ) {}

  readSkill(nameOrId: string): Effect.Effect<ReadSkillResponse, StorageError | LimitError> {
    const store = this.store;
    const maxBytes = this.config.limits.maxSkillBytes;
    return Effect.gen(function* () {
      const started = Date.now();
      const skill = yield* store.getSkillByNameOrId(nameOrId);
      yield* rejectBlockedSkill(skill);
      const fileStat = yield* Effect.tryPromise({
        try: () => stat(skill.skillFile),
        catch: toStorageError
      });
      if (fileStat.size > maxBytes) {
        return yield* Effect.fail(new LimitError(`Skill exceeds max_skill_bytes: ${skill.name}`));
      }
      const content = yield* Effect.tryPromise({
        try: () => readFile(skill.skillFile, "utf8"),
        catch: toStorageError
      });
      store.audit("read_skill", skill.name, "SKILL.md", Date.now() - started);
      return {
        id: skill.id,
        name: skill.name,
        path: path.posix.join(skill.relativePath, "SKILL.md"),
        content
      };
    });
  }

  readReference(
    nameOrId: string,
    relativePath: string
  ): Effect.Effect<ReadReferenceResponse, StorageError | PathGuardError> {
    const store = this.store;
    const maxBytes = this.config.limits.maxInlineReferenceBytes;
    return Effect.gen(function* () {
      const started = Date.now();
      const skill = yield* store.getSkillByNameOrId(nameOrId);
      yield* rejectBlockedSkill(skill);
      const resolved = yield* Effect.tryPromise({
        try: () => resolveReferencePath(skill, relativePath),
        catch: toPathGuardError
      });
      const fileStat = yield* Effect.tryPromise({
        try: () => stat(resolved.absolutePath),
        catch: toStorageError
      });
      const mime = lookup(resolved.absolutePath) || "application/octet-stream";
      if (fileStat.size > maxBytes) {
        store.audit("read_skill_reference", skill.name, resolved.relativePath, Date.now() - started);
        return {
          id: skill.id,
          name: skill.name,
          relative_path: resolved.relativePath,
          size_bytes: fileStat.size,
          mime,
          sha256: null,
          content: null,
          inline_blocked_reason: "size_limit"
        };
      }

      const bytes = yield* Effect.tryPromise({
        try: () => readFile(resolved.absolutePath),
        catch: toStorageError
      });
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const binary = isBinary(bytes, mime);
      store.audit("read_skill_reference", skill.name, resolved.relativePath, Date.now() - started);
      if (binary) {
        return {
          id: skill.id,
          name: skill.name,
          relative_path: resolved.relativePath,
          size_bytes: fileStat.size,
          mime,
          sha256,
          content: null,
          inline_blocked_reason: "binary_file"
        };
      }
      return {
        id: skill.id,
        name: skill.name,
        relative_path: resolved.relativePath,
        size_bytes: fileStat.size,
        mime,
        sha256,
        content: bytes.toString("utf8")
      };
    });
  }
}

function toStorageError(error: unknown): StorageError {
  return error instanceof StorageError
    ? error
    : new StorageError(error instanceof Error ? error.message : String(error));
}

function toPathGuardError(error: unknown): PathGuardError {
  return error instanceof PathGuardError
    ? error
    : new PathGuardError(error instanceof Error ? error.message : String(error));
}

function rejectBlockedSkill(skill: SkillRecord): Effect.Effect<void, StorageError> {
  if (skill.trustStatus === "blocked") {
    return Effect.fail(new StorageError(`Skill is blocked and cannot be read: ${skill.name}`));
  }
  return Effect.void;
}

async function resolveReferencePath(
  skill: SkillRecord,
  requestedRelativePath: string
): Promise<{ absolutePath: string; relativePath: string }> {
  if (requestedRelativePath.includes("\0")) {
    throw new PathGuardError("Reference path contains an invalid null byte");
  }
  if (path.isAbsolute(requestedRelativePath)) {
    throw new PathGuardError("Reference path must be relative");
  }
  const normalized = path.normalize(requestedRelativePath);
  if (normalized === "." || normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw new PathGuardError("Reference path cannot traverse outside the skill directory");
  }

  const absolutePath = path.resolve(skill.skillDir, normalized);
  const relativeFromSkillDir = path.relative(skill.skillDir, absolutePath);
  if (relativeFromSkillDir.startsWith("..") || path.isAbsolute(relativeFromSkillDir)) {
    throw new PathGuardError("Reference path cannot traverse outside the skill directory");
  }

  const parts = relativeFromSkillDir.split(path.sep).filter(Boolean);
  let current = skill.skillDir;
  for (const part of parts) {
    current = path.join(current, part);
    const currentStat = await lstat(current);
    if (currentStat.isSymbolicLink()) {
      throw new PathGuardError("Symlinks are rejected in v1");
    }
  }

  const targetStat = await lstat(absolutePath);
  if (!targetStat.isFile()) {
    throw new PathGuardError("Reference path must point to a file");
  }

  return {
    absolutePath,
    relativePath: parts.join("/")
  };
}

function isBinary(bytes: Buffer, mime: string): boolean {
  if (bytes.subarray(0, Math.min(bytes.length, 4096)).includes(0)) {
    return true;
  }
  return !(
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/javascript" ||
    mime === "application/xml" ||
    mime === "application/x-javascript"
  );
}
