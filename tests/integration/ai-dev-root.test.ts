import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/types.js";
import { scanSkillRoots } from "../../src/skills/scanner.js";
import { CatalogStore } from "../../src/storage/catalog-store.js";
import { SearchService } from "../../src/search/search-service.js";

const currentFile = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(currentFile), "../..");
const defaultAiDevRoot = path.resolve(projectRoot, "../..");
const aiDevSkillsRoot =
  process.env.SKILL_CATALOG_INTEGRATION_ROOT ?? path.join(defaultAiDevRoot, "_infra/skills/skills");

describe("ai-dev skill root integration", () => {
  it.runIf(existsSync(aiDevSkillsRoot))("indexes the current skill library and searches core skills", async () => {
    const config = integrationConfig(aiDevSkillsRoot);
    const store = new CatalogStore(config);
    try {
      const sync = await Effect.runPromise(scanSkillRoots(config));
      await Effect.runPromise(store.rebuild(sync));
      const status = await Effect.runPromise(store.status());
      expect(status.roots[0]?.skills_indexed).toBeGreaterThanOrEqual(30);
      expect(status.duplicate_names).toEqual([]);

      const search = new SearchService(config, store);
      const prd = await Effect.runPromise(search.search({ query: "create a prd", limit: 5 }));
      expect(prd.results.map((result) => result.name)).toContain("prd");
      const browser = await Effect.runPromise(search.search({ query: "browser automation screenshots", limit: 5 }));
      expect(browser.results.map((result) => result.name)).toContain("agent-browser");
    } finally {
      store.close();
    }
  });
});

function integrationConfig(root: string): AppConfig {
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
    roots: [{ name: "ai-dev-skills", path: root, defaultTrustStatus: "trusted" }],
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
      maxInlineReferenceBytes: 131072,
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
