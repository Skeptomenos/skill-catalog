import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig, RootConfig, TrustStatus } from "../../src/types.js";

export interface FixtureRoots {
  readonly trusted: string;
  readonly reviewRequired: string;
  readonly blocked: string;
  readonly cleanup: () => Promise<void>;
}

export interface FixtureConfigOverrides {
  readonly bearerTokenEnv?: string;
  readonly maxHttpBodyBytes?: number;
  readonly maxInlineReferenceBytes?: number;
  readonly maxRequests?: number;
  readonly maxSessions?: number;
  readonly maxSkillBytes?: number;
  readonly sessionIdleTtlMs?: number;
  readonly sessionMode?: "stateful" | "stateless";
  readonly sqlitePath?: string;
}

const SKILL_BODY_FILLER = Array.from({ length: 60 }, () => "fixturecalibration").join(" ");

export async function createFixtureRoots(): Promise<FixtureRoots> {
  const base = await mkdtemp(path.join(os.tmpdir(), "skill-catalog-e2e-"));
  const trusted = path.join(base, "trusted");
  const reviewRequired = path.join(base, "review-required");
  const blocked = path.join(base, "blocked");
  await mkdir(trusted, { recursive: true });
  await mkdir(reviewRequired, { recursive: true });
  await mkdir(blocked, { recursive: true });

  // Trusted, complete-metadata skill with text + binary + oversized references.
  await writeSkillPackage(trusted, "fixture-prd", {
    frontmatter: [
      "name: fixture-prd",
      "description: Generate a product requirements document for fixture planning.",
      "author: Fixture Author",
      "version: 1.0.0",
      "source:",
      "  type: self",
      "triggers:",
      "  - zqfixtureprd",
      "when_to_use:",
      "  - Writing a fixture PRD.",
      "when_not_to_use:",
      "  - Trivial fixture edits."
    ],
    body: `# Fixture PRD\n\nFixture PRD body. zqfixtureprd ${SKILL_BODY_FILLER}\n`
  });
  const prdDocs = path.join(trusted, "fixture-prd", "docs");
  await mkdir(prdDocs, { recursive: true });
  await writeFile(path.join(prdDocs, "template.md"), "Fixture template body", "utf8");
  await writeFile(path.join(prdDocs, "binary.bin"), Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x42]));
  await writeFile(path.join(prdDocs, "oversized.md"), "y".repeat(4096), "utf8");

  // Trusted skill with incomplete metadata (no triggers/when_to_use/when_not_to_use/author/version/source).
  await writeSkillPackage(trusted, "fixture-incomplete", {
    frontmatter: [
      "name: fixture-incomplete",
      "description: Incomplete fixture metadata skill for zqfixtureincomplete search checks."
    ],
    body: `# Fixture Incomplete\n\nIncomplete metadata body. zqfixtureincomplete ${SKILL_BODY_FILLER}\n`
  });

  // Trusted skill whose SKILL.md exceeds small maxSkillBytes overrides.
  await writeSkillPackage(trusted, "fixture-oversized", {
    frontmatter: [
      "name: fixture-oversized",
      "description: Oversized fixture skill for zqfixtureoversized read checks.",
      "author: Fixture Author",
      "version: 1.0.0",
      "source:",
      "  type: self",
      "triggers:",
      "  - zqfixtureoversized",
      "when_to_use:",
      "  - Oversized read checks.",
      "when_not_to_use:",
      "  - Anything else."
    ],
    body: `# Fixture Oversized\n\n${"z".repeat(8192)}\n`
  });

  // Review-required, non-script external skill.
  await writeSkillPackage(reviewRequired, "fixture-external", {
    frontmatter: [
      "name: fixture-external",
      "description: External fixture skill for zqfixtureexternal review-required checks.",
      "author: External Author",
      "source:",
      "  type: git",
      "  url: https://example.com/fixture-external.git"
    ],
    body: `# Fixture External\n\nExternal body. zqfixtureexternal ${SKILL_BODY_FILLER}\n`
  });
  const externalDocs = path.join(reviewRequired, "fixture-external", "docs");
  await mkdir(externalDocs, { recursive: true });
  await writeFile(path.join(externalDocs, "notes.md"), "External fixture notes", "utf8");

  // Blocked skill.
  await writeSkillPackage(blocked, "fixture-blocked", {
    frontmatter: [
      "name: fixture-blocked",
      "description: Blocked fixture skill for zqfixtureblocked denial checks."
    ],
    body: `# Fixture Blocked\n\nBlocked body. zqfixtureblocked ${SKILL_BODY_FILLER}\n`
  });

  // Duplicate name across trusted and review-required roots.
  for (const root of [trusted, reviewRequired]) {
    await writeSkillPackage(root, "fixture-duplicate", {
      frontmatter: [
        "name: fixture-duplicate",
        "description: Duplicate fixture skill for zqfixtureduplicate status checks."
      ],
      body: `# Fixture Duplicate\n\nDuplicate body. zqfixtureduplicate ${SKILL_BODY_FILLER}\n`
    });
  }

  return {
    trusted,
    reviewRequired,
    blocked,
    cleanup: async () => {
      await rm(base, { recursive: true, force: true });
    }
  };
}

export function fixtureConfig(roots: FixtureRoots, overrides: FixtureConfigOverrides = {}): AppConfig {
  const rootConfigs: RootConfig[] = [
    { name: "fixture-trusted", path: roots.trusted, defaultTrustStatus: "trusted" as TrustStatus },
    {
      name: "fixture-review-required",
      path: roots.reviewRequired,
      defaultTrustStatus: "review_required" as TrustStatus
    },
    { name: "fixture-blocked", path: roots.blocked, defaultTrustStatus: "blocked" as TrustStatus }
  ];
  return {
    server: {
      transport: "streamable-http",
      host: "127.0.0.1",
      port: 0,
      allowedHosts: [],
      maxSessions: overrides.maxSessions ?? 100,
      sessionIdleTtlMs: overrides.sessionIdleTtlMs ?? 1800000,
      bearerTokenEnv: overrides.bearerTokenEnv,
      sessionMode: overrides.sessionMode ?? "stateful"
    },
    roots: rootConfigs,
    storage: { sqlitePath: overrides.sqlitePath ?? ":memory:" },
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
      maxSkillBytes: overrides.maxSkillBytes ?? 262144,
      maxInlineReferenceBytes: overrides.maxInlineReferenceBytes ?? 1024,
      maxHttpBodyBytes: overrides.maxHttpBodyBytes ?? 1048576,
      followSymlinks: false,
      rateLimit: {
        enabled: true,
        windowMs: 60000,
        maxRequests: overrides.maxRequests ?? 1000,
        maxEntries: 1000
      }
    }
  };
}

async function writeSkillPackage(
  root: string,
  dirName: string,
  skill: { readonly frontmatter: readonly string[]; readonly body: string }
): Promise<void> {
  const dir = path.join(root, dirName);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), `---\n${skill.frontmatter.join("\n")}\n---\n\n${skill.body}`, "utf8");
}
