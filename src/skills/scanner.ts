import { lstat, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import type { AppConfig, RootConfig, SkillRecord, SyncError, SyncResult } from "../types.js";
import { parseSkillFile } from "./metadata.js";

export function scanSkillRoots(config: AppConfig): Effect.Effect<SyncResult, never> {
  return Effect.promise(async () => {
    const skills: SkillRecord[] = [];
    const errors: SyncError[] = [];

    for (const root of config.roots) {
      const rootResult = await scanRoot(root);
      skills.push(...rootResult.skills);
      errors.push(...rootResult.errors);
    }

    const { filteredSkills, duplicateNames } = removeDuplicates(skills);
    for (const duplicateName of duplicateNames) {
      errors.push({
        sourceRoot: "global",
        path: duplicateName,
        code: "duplicate_skill_name",
        message: `Duplicate skill name: ${duplicateName}`
      });
    }

    return {
      skills: filteredSkills,
      errors,
      duplicateNames
    };
  });
}

async function scanRoot(root: RootConfig): Promise<{ skills: SkillRecord[]; errors: SyncError[] }> {
  const skills: SkillRecord[] = [];
  const errors: SyncError[] = [];
  try {
    const rootStat = await lstat(root.path);
    if (rootStat.isSymbolicLink()) {
      return {
        skills,
        errors: [
          {
            sourceRoot: root.name,
            path: root.path,
            code: "symlink_root",
            message: "Configured root cannot be a symlink"
          }
        ]
      };
    }
    if (!rootStat.isDirectory()) {
      return {
        skills,
        errors: [
          {
            sourceRoot: root.name,
            path: root.path,
            code: "invalid_root",
            message: "Configured root is not a directory"
          }
        ]
      };
    }

    const skillFiles = await findSkillFiles(root.path, root, errors);
    for (const skillFile of skillFiles) {
      const fileStat = await stat(skillFile);
      const content = await readFile(skillFile, "utf8");
      const parsed = parseSkillFile({
        sourceRoot: root,
        skillFile,
        content,
        mtimeMs: fileStat.mtimeMs
      });
      if (parsed.skill) {
        skills.push(parsed.skill);
      }
      if (parsed.error) {
        errors.push(parsed.error);
      }
    }
  } catch (error) {
    errors.push({
      sourceRoot: root.name,
      path: root.path,
      code: "root_read_error",
      message: error instanceof Error ? error.message : String(error)
    });
  }
  return { skills, errors };
}

async function findSkillFiles(rootPath: string, root: RootConfig, errors: SyncError[]): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootPath, entry.name);
    if (entry.isSymbolicLink()) {
      errors.push({
        sourceRoot: root.name,
        path: path.relative(root.path, fullPath),
        code: "symlink_rejected",
        message: "Symlinks are rejected in v1"
      });
      continue;
    }
    if (entry.isDirectory()) {
      found.push(...(await findSkillFiles(fullPath, root, errors)));
    } else if (entry.isFile() && entry.name === "SKILL.md") {
      found.push(fullPath);
    }
  }
  return found;
}

function removeDuplicates(skills: readonly SkillRecord[]): {
  readonly filteredSkills: readonly SkillRecord[];
  readonly duplicateNames: readonly string[];
} {
  const counts = new Map<string, number>();
  for (const skill of skills) {
    counts.set(skill.name, (counts.get(skill.name) ?? 0) + 1);
  }
  const duplicateNames = [...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name);
  const duplicates = new Set(duplicateNames);
  return {
    filteredSkills: skills.filter((skill) => !duplicates.has(skill.name)),
    duplicateNames
  };
}
