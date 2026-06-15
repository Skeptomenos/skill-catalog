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
      expect(
        status.metadata_warnings.map((warning) => warning.skill),
        "Expected ai-dev first-party skill root to have no metadata warnings"
      ).toEqual([]);

      const search = new SearchService(config, store);
      const prd = await Effect.runPromise(search.search({ query: "create a prd", limit: 5 }));
      expect(prd.results.map((result) => result.name)).toContain("prd");
      const browser = await Effect.runPromise(search.search({ query: "browser automation screenshots", limit: 5 }));
      expect(browser.results.map((result) => result.name)).toContain("agent-browser");
    } finally {
      store.close();
    }
  });

  it.runIf(existsSync(aiDevSkillsRoot))("routes dogfood prompts to expected core skills", async () => {
    const config = integrationConfig(aiDevSkillsRoot);
    const store = new CatalogStore(config);
    try {
      const sync = await Effect.runPromise(scanSkillRoots(config));
      await Effect.runPromise(store.rebuild(sync));
      const search = new SearchService(config, store);

      await expectSearchContains(search, "risky multi-step change planning validation handoff", [
        "writing-plans",
        "self-correction-loop"
      ]);
      await expectSearchContains(search, "update instructions file AGENTS.md project configuration", [
        "create-agents-md"
      ]);
      await expectSearchContains(search, "browser automation local web app safest command pattern", [
        "agent-browser"
      ]);
      await expectSearchContains(search, "messy git branch open PR repo workflow cleanup", [
        "git-workflow",
        "ai-dev-repo-git-cleanup"
      ]);
      await expectSearchContains(search, "where should I put a new project naming convention", [
        "repo-navigation",
        "repo-conventions"
      ]);
    } finally {
      store.close();
    }
  });

  it.runIf(existsSync(aiDevSkillsRoot))("routes Phase 2 eval prompts within expected ranks", async () => {
    const config = integrationConfig(aiDevSkillsRoot);
    const store = new CatalogStore(config);
    try {
      const sync = await Effect.runPromise(scanSkillRoots(config));
      await Effect.runPromise(store.rebuild(sync));
      const search = new SearchService(config, store);

      const routingEvaluations = [
        {
          query: "write a product requirements document for a new feature",
          expected: [{ name: "prd", maxRank: 3 }]
        },
        {
          query: "create a new project in ai-dev and update indexes",
          expected: [
            { name: "create-project", maxRank: 5 },
            { name: "update-index", maxRank: 5 }
          ]
        },
        {
          query: "start a Linear issue and open a PR",
          expected: [
            { name: "linear-workflow", maxRank: 5 },
            { name: "git-workflow", maxRank: 5 }
          ]
        },
        {
          query: "test a local web app in the browser and collect screenshots",
          expected: [
            { name: "agent-browser", maxRank: 5 },
            { name: "dogfood", maxRank: 5 }
          ]
        },
        {
          query: "use xcodebuildmcp to run an iOS simulator workflow",
          expected: [{ name: "xcodebuildmcp", maxRank: 3 }]
        },
        {
          query: "check TypeScript testing security and architecture standards",
          expected: [
            { name: "ts-standards", maxRank: 10 },
            { name: "testing-standards", maxRank: 10 },
            { name: "security-standards", maxRank: 10 },
            { name: "architecture-standards", maxRank: 10 }
          ]
        }
      ];

      for (const evaluation of routingEvaluations) {
        for (const expected of evaluation.expected) {
          await expectSearchRank(search, evaluation.query, expected.name, expected.maxRank);
        }
      }

      await expectSearchRank(search, "write a product requirements document for a new feature", "prd", 3, {
        includeIncompleteMetadata: false
      });
    } finally {
      store.close();
    }
  });
});

async function expectSearchContains(
  search: SearchService,
  query: string,
  expectedNames: readonly string[]
): Promise<void> {
  const result = await Effect.runPromise(search.search({ query, limit: 10 }));
  const names = result.results.map((item) => item.name);
  for (const expectedName of expectedNames) {
    expect(names, `Expected ${expectedName} in top 10 for query "${query}", got: ${names.join(", ")}`).toContain(
      expectedName
    );
  }
}

async function expectSearchRank(
  search: SearchService,
  query: string,
  expectedName: string,
  maxRank: number,
  options: { readonly includeIncompleteMetadata?: boolean } = {}
): Promise<void> {
  const result = await Effect.runPromise(search.search({ query, limit: 10, ...options }));
  const names = result.results.map((item) => item.name);
  const rank = names.indexOf(expectedName) + 1;
  expect(
    rank > 0 && rank <= maxRank,
    `Expected ${expectedName} within rank ${maxRank} for query "${query}", got: ${names.join(", ")}`
  ).toBe(true);
}

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
