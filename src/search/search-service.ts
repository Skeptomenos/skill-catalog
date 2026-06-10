import { Effect } from "effect";
import type { AppConfig, SearchInput, SearchResponse, SearchResultItem, SkillRecord } from "../types.js";
import { CatalogStore } from "../storage/catalog-store.js";
import { searchQmd } from "../qmd/qmd-adapter.js";

export class SearchService {
  constructor(
    private readonly config: AppConfig,
    private readonly store: CatalogStore
  ) {}

  search(input: SearchInput): Effect.Effect<SearchResponse, never> {
    const limit = normalizeLimit(input.limit, this.config);
    const includeIncompleteMetadata = input.includeIncompleteMetadata ?? true;
    const store = this.store;
    const config = this.config;
    return Effect.gen(function* () {
      const started = Date.now();
      const [ftsResults, skills] = yield* Effect.all([
        store
          .searchFts(input.query, limit, { completeOnly: !includeIncompleteMetadata })
          .pipe(Effect.catchAll(() => Effect.succeed([]))),
        store.getAllSkills().pipe(Effect.catchAll(() => Effect.succeed([])))
      ]);
      const searchableSkills = skills
        .filter((skill) => skill.trustStatus !== "blocked")
        .filter((skill) => includeIncompleteMetadata || hasCompleteMetadata(skill));
      const qmd = yield* searchQmd(config, input.query, limit, searchableSkills);
      if (qmd.warning) {
        store.recordSearchBackendWarning(qmd.warning);
        console.warn(`Skill Catalog QMD warning: ${qmd.warning.message}`);
      } else if (qmd.attempted) {
        store.recordSearchBackendReady("qmd");
      }
      const results = mergeResults(ftsResults, qmd.results)
        .filter((result) => result.trust_status !== "blocked")
        .filter((result) => includeIncompleteMetadata || hasCompleteResultMetadata(result))
        .slice(0, limit);
      store.audit("search_skills", null, null, Date.now() - started);
      return {
        query: input.query,
        results
      };
    });
  }
}

function hasCompleteMetadata(skill: SkillRecord): boolean {
  return (
    skill.warnings.length === 0 &&
    skill.triggers.length > 0 &&
    skill.whenToUse.length > 0 &&
    skill.whenNotToUse.length > 0
  );
}

function hasCompleteResultMetadata(result: SearchResultItem): boolean {
  return (
    result.warnings.length === 0 &&
    result.triggers.length > 0 &&
    result.when_to_use.length > 0 &&
    result.when_not_to_use.length > 0
  );
}

function normalizeLimit(limit: number | undefined, config: AppConfig): number {
  if (!limit) {
    return config.search.defaultLimit;
  }
  return Math.min(Math.max(1, limit), config.search.maxLimit);
}

export function mergeResults(
  ftsResults: readonly SearchResultItem[],
  qmdResults: readonly SearchResultItem[]
): readonly SearchResultItem[] {
  const merged = new Map<string, SearchResultItem>();
  for (const result of [...ftsResults, ...qmdResults]) {
    const existing = merged.get(result.id);
    if (!existing) {
      merged.set(result.id, result);
      continue;
    }
    merged.set(result.id, {
      ...existing,
      score: Number(Math.max(existing.score, result.score).toFixed(4)),
      matched_backends: [...new Set([...existing.matched_backends, ...result.matched_backends])],
      matched_fields: [...new Set([...existing.matched_fields, ...result.matched_fields])],
      why_match: `${existing.why_match} ${result.why_match}`
    });
  }
  return [...merged.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}
