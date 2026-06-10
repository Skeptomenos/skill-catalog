import os from "node:os";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { assertResolvedBearerToken, expandConfiguredPath, loadConfig } from "../src/config/config.js";
import type { AppConfig } from "../src/types.js";

const ENV_KEYS = ["SKILL_CATALOG_TEST_TOKEN", "SKILL_CATALOG_TEST_PATH_VAR"];
const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));
const tempDirs: string[] = [];

afterEach(async () => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  for (const tempDir of tempDirs.splice(0)) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("assertResolvedBearerToken", () => {
  it("throws when bearer_token_env is configured but the variable is unset", () => {
    delete process.env.SKILL_CATALOG_TEST_TOKEN;
    expect(() => assertResolvedBearerToken(configWithTokenEnv("SKILL_CATALOG_TEST_TOKEN"))).toThrow(
      /unset or empty/
    );
  });

  it("throws when bearer_token_env is configured but the variable is empty", () => {
    process.env.SKILL_CATALOG_TEST_TOKEN = "   ";
    expect(() => assertResolvedBearerToken(configWithTokenEnv("SKILL_CATALOG_TEST_TOKEN"))).toThrow(
      /unset or empty/
    );
  });

  it("passes when the configured variable resolves to a token", () => {
    process.env.SKILL_CATALOG_TEST_TOKEN = "secret";
    expect(() => assertResolvedBearerToken(configWithTokenEnv("SKILL_CATALOG_TEST_TOKEN"))).not.toThrow();
  });

  it("passes when no bearer_token_env is configured (intentional no-auth)", () => {
    expect(() => assertResolvedBearerToken(configWithTokenEnv(undefined))).not.toThrow();
  });
});

describe("expandConfiguredPath", () => {
  it("substitutes environment variables", () => {
    process.env.SKILL_CATALOG_TEST_PATH_VAR = "/tmp/skill-catalog-test";
    expect(expandConfiguredPath("${SKILL_CATALOG_TEST_PATH_VAR}/skills")).toBe(
      path.normalize("/tmp/skill-catalog-test/skills")
    );
  });

  it("throws when a referenced environment variable is unset", () => {
    delete process.env.SKILL_CATALOG_TEST_PATH_VAR;
    expect(() => expandConfiguredPath("${SKILL_CATALOG_TEST_PATH_VAR}/skills")).toThrow(/is not set/);
  });

  it("expands home-relative paths", () => {
    expect(expandConfiguredPath("~/skills")).toBe(path.join(os.homedir(), "skills"));
  });

  it("resolves relative paths against the provided base directory", () => {
    expect(expandConfiguredPath("skills", "/srv/base")).toBe(path.normalize("/srv/base/skills"));
  });

  it("passes :memory: through unchanged", () => {
    expect(expandConfiguredPath(":memory:")).toBe(":memory:");
  });
});

describe("loadConfig root validation", () => {
  it("parses allowed_hosts from server config", async () => {
    const tempDir = await makeTempDir();
    const root = path.join(tempDir, "skills");
    await mkdir(root);
    const configPath = path.join(tempDir, "config.yaml");
    await writeFile(
      configPath,
      `server:
  transport: streamable-http
  host: 100.64.0.10
  port: 7421
  allowed_hosts:
    - skillbox.tailnet-name.ts.net
  session_mode: stateful

roots:
  - name: test-root
    path: ${JSON.stringify(root)}

storage:
  sqlite_path: ":memory:"
`,
      "utf8"
    );

    const config = await Effect.runPromise(loadConfig(configPath));
    expect(config.server.allowedHosts).toEqual(["skillbox.tailnet-name.ts.net"]);
  });

  it("parses stateful session bounds from server config", async () => {
    const tempDir = await makeTempDir();
    const root = path.join(tempDir, "skills");
    await mkdir(root);
    const configPath = path.join(tempDir, "config.yaml");
    await writeFile(
      configPath,
      `server:
  transport: streamable-http
  host: 127.0.0.1
  port: 7421
  max_sessions: 7
  session_idle_ttl_ms: 30000
  session_mode: stateful

roots:
  - name: test-root
    path: ${JSON.stringify(root)}

storage:
  sqlite_path: ":memory:"
`,
      "utf8"
    );

    const config = await Effect.runPromise(loadConfig(configPath));
    expect(config.server.maxSessions).toBe(7);
    expect(config.server.sessionIdleTtlMs).toBe(30000);
  });

  it("fails when a configured root does not exist", async () => {
    const tempDir = await makeTempDir();
    const configPath = path.join(tempDir, "config.yaml");
    const missingRoot = path.join(tempDir, "missing");
    await writeConfig(configPath, missingRoot);

    await expect(Effect.runPromise(loadConfig(configPath))).rejects.toThrow(/does not exist/);
  });

  it("fails when a configured root is a file", async () => {
    const tempDir = await makeTempDir();
    const rootFile = path.join(tempDir, "skills-file");
    await writeFile(rootFile, "not a directory", "utf8");
    const configPath = path.join(tempDir, "config.yaml");
    await writeConfig(configPath, rootFile);

    await expect(Effect.runPromise(loadConfig(configPath))).rejects.toThrow(/not a directory/);
  });

  it("fails when a configured root is a symlink", async () => {
    const tempDir = await makeTempDir();
    const realRoot = path.join(tempDir, "real-skills");
    const linkedRoot = path.join(tempDir, "linked-skills");
    await mkdir(realRoot);
    await symlink(realRoot, linkedRoot);
    const configPath = path.join(tempDir, "config.yaml");
    await writeConfig(configPath, linkedRoot);

    await expect(Effect.runPromise(loadConfig(configPath))).rejects.toThrow(/cannot be a symlink/);
  });
});

function configWithTokenEnv(bearerTokenEnv: string | undefined): AppConfig {
  return {
    server: {
      transport: "streamable-http",
      host: "127.0.0.1",
      port: 7421,
      allowedHosts: [],
      maxSessions: 100,
      sessionIdleTtlMs: 1800000,
      bearerTokenEnv,
      sessionMode: "stateful"
    },
    roots: [{ name: "test-root", path: "/tmp/skills", defaultTrustStatus: "trusted" }],
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

async function makeTempDir(): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "skill-catalog-config-"));
  tempDirs.push(tempDir);
  return tempDir;
}

async function writeConfig(configPath: string, rootPath: string): Promise<void> {
  await writeFile(
    configPath,
    `server:
  transport: streamable-http
  host: 127.0.0.1
  port: 7421
  session_mode: stateful

roots:
  - name: test-root
    path: ${JSON.stringify(rootPath)}
    default_trust_status: trusted

storage:
  sqlite_path: ":memory:"

limits:
  follow_symlinks: false
`,
    "utf8"
  );
}
