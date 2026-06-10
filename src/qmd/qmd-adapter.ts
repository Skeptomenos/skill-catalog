import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import type { AppConfig, SearchBackendWarning, SearchResultItem, SkillRecord } from "../types.js";

const execFileAsync = promisify(execFile);

export interface QmdSearchResponse {
  readonly results: readonly SearchResultItem[];
  readonly attempted: boolean;
  readonly warning?: SearchBackendWarning;
}

export function searchQmd(
  config: AppConfig,
  query: string,
  limit: number,
  skills: readonly SkillRecord[]
): Effect.Effect<QmdSearchResponse, never> {
  if (!config.search.qmd.enabled) {
    return Effect.succeed({ results: [], attempted: false });
  }

  return Effect.promise(async () => {
    try {
      const { stdout } = await execFileAsync(
        config.search.qmd.command,
        [
          "query",
          query,
          "-c",
          config.search.qmd.collection,
          "--json",
          "--full-path",
          "-n",
          String(limit),
          "--no-rerank"
        ],
        { timeout: 10000 }
      );
      const parsed = JSON.parse(stdout) as Array<{ file?: string; score?: number }>;
      const byNormalizedSkillFile = new Map(skills.map((skill) => [normalizedAbsolutePath(skill.skillFile), skill]));
      const matches = parsed.flatMap((result, index) => {
        const skill = matchQmdFileToSkill(result.file ?? "", process.cwd(), byNormalizedSkillFile);
        if (!skill) {
          return [];
        }
        return [
          {
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
            score: typeof result.score === "number" ? result.score : Number((1 / (index + 1)).toFixed(4)),
            matched_backends: ["qmd"],
            matched_fields: ["body"],
            why_match: "Matched by optional QMD hybrid search."
          } satisfies SearchResultItem
        ];
      });
      return { results: matches, attempted: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        results: [],
        attempted: true,
        warning: {
          backend: "qmd",
          code: "qmd_search_failed",
          message,
          observed_at: new Date().toISOString()
        }
      };
    }
  });
}

function matchQmdFileToSkill(
  file: string,
  qmdProcessCwd: string,
  byNormalizedSkillFile: ReadonlyMap<string, SkillRecord>
): SkillRecord | undefined {
  const normalizedInput = normalizeSeparators(file.trim());
  if (!normalizedInput) {
    return undefined;
  }

  if (path.isAbsolute(normalizedInput)) {
    return byNormalizedSkillFile.get(normalizedAbsolutePath(normalizedInput));
  }

  if (!normalizedInput.startsWith("./")) {
    return undefined;
  }

  const relativePath = normalizedInput.slice(2);
  if (relativePath.includes("\0") || path.isAbsolute(relativePath)) {
    return undefined;
  }

  const normalizedRelativePath = path.normalize(relativePath);
  if (normalizedRelativePath === "." || normalizedRelativePath.startsWith("..") || path.isAbsolute(normalizedRelativePath)) {
    return undefined;
  }

  return byNormalizedSkillFile.get(normalizedAbsolutePath(path.join(qmdProcessCwd, normalizedRelativePath)));
}

function normalizedAbsolutePath(file: string): string {
  return normalizeSeparators(path.resolve(normalizeSeparators(file)));
}

function normalizeSeparators(file: string): string {
  return file.replaceAll("\\", "/");
}
