import { existsSync } from "node:fs";
import { lstat, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import YAML from "yaml";
import { z } from "zod/v4";
import { ConfigError } from "../errors.js";
import type { AppConfig } from "../types.js";

const TrustStatusSchema = z.enum(["trusted", "review_required", "blocked"]);

const RawConfigSchema = z.object({
  server: z
    .object({
      transport: z.literal("streamable-http").optional(),
      host: z.string().optional(),
      port: z.number().int().min(1).max(65535).optional(),
      allowed_hosts: z.array(z.string().min(1)).optional(),
      max_sessions: z.number().int().min(1).optional(),
      session_idle_ttl_ms: z.number().int().min(1000).optional(),
      bearer_token_env: z.string().optional(),
      session_mode: z.enum(["stateful", "stateless"]).optional()
    })
    .optional(),
  roots: z
    .array(
      z.object({
        name: z.string().min(1),
        path: z.string().min(1),
        default_trust_status: TrustStatusSchema.optional()
      })
    )
    .min(1),
  storage: z
    .object({
      sqlite_path: z.string().min(1).optional()
    })
    .optional(),
  search: z
    .object({
      default_limit: z.number().int().min(1).optional(),
      max_limit: z.number().int().min(1).optional(),
      qmd: z
        .object({
          enabled: z.boolean().optional(),
          collection: z.string().min(1).optional(),
          command: z.string().min(1).optional()
        })
        .optional()
    })
    .optional(),
  limits: z
    .object({
      max_skill_bytes: z.number().int().min(1).optional(),
      max_inline_reference_bytes: z.number().int().min(1).optional(),
      max_http_body_bytes: z.number().int().min(1024).optional(),
      follow_symlinks: z.boolean().optional(),
      rate_limit: z
        .object({
          enabled: z.boolean().optional(),
          window_ms: z.number().int().min(1000).optional(),
          max_requests: z.number().int().min(1).optional(),
          max_entries: z.number().int().min(1).optional()
        })
        .optional()
    })
    .optional()
});

export type RawConfig = z.infer<typeof RawConfigSchema>;

export function loadConfig(configPath?: string): Effect.Effect<AppConfig, ConfigError> {
  return Effect.tryPromise({
    try: async () => {
      const raw = configPath ? await readConfigFile(configPath) : defaultRawConfig();
      const parsed = RawConfigSchema.parse(raw);
      const baseDir = configPath ? path.dirname(path.resolve(configPath)) : process.cwd();
      if (parsed.limits?.follow_symlinks) {
        throw new ConfigError("limits.follow_symlinks must be false in v1");
      }
      const appConfig: AppConfig = {
        server: {
          transport: parsed.server?.transport ?? "streamable-http",
          host: parsed.server?.host ?? "127.0.0.1",
          port: parsed.server?.port ?? 7421,
          allowedHosts: parsed.server?.allowed_hosts ?? [],
          maxSessions: parsed.server?.max_sessions ?? 100,
          sessionIdleTtlMs: parsed.server?.session_idle_ttl_ms ?? 1800000,
          bearerTokenEnv: parsed.server?.bearer_token_env,
          sessionMode: parsed.server?.session_mode ?? "stateful"
        },
        roots: parsed.roots.map((root) => ({
          name: root.name,
          path: expandConfiguredPath(root.path, baseDir),
          defaultTrustStatus: root.default_trust_status ?? "trusted"
        })),
        storage: {
          sqlitePath: expandConfiguredPath(parsed.storage?.sqlite_path ?? "~/.cache/skill-catalog/catalog.sqlite", baseDir)
        },
        search: {
          defaultLimit: parsed.search?.default_limit ?? 5,
          maxLimit: parsed.search?.max_limit ?? 20,
          qmd: {
            enabled: parsed.search?.qmd?.enabled ?? false,
            collection: parsed.search?.qmd?.collection ?? "skill-catalog",
            command: parsed.search?.qmd?.command ?? "qmd"
          }
        },
        limits: {
          maxSkillBytes: parsed.limits?.max_skill_bytes ?? 262144,
          maxInlineReferenceBytes: parsed.limits?.max_inline_reference_bytes ?? 131072,
          maxHttpBodyBytes: parsed.limits?.max_http_body_bytes ?? 1048576,
          followSymlinks: false,
          rateLimit: {
            enabled: parsed.limits?.rate_limit?.enabled ?? true,
            windowMs: parsed.limits?.rate_limit?.window_ms ?? 60000,
            maxRequests: parsed.limits?.rate_limit?.max_requests ?? 120,
            maxEntries: parsed.limits?.rate_limit?.max_entries ?? 1000
          }
        }
      };

      if (appConfig.search.defaultLimit > appConfig.search.maxLimit) {
        throw new ConfigError("search.default_limit cannot exceed search.max_limit");
      }

      await validateConfiguredRoots(appConfig);

      if (appConfig.storage.sqlitePath !== ":memory:") {
        await mkdir(path.dirname(appConfig.storage.sqlitePath), { recursive: true });
      }

      return appConfig;
    },
    catch: (error) =>
      error instanceof ConfigError
        ? error
        : new ConfigError(error instanceof Error ? error.message : String(error))
  });
}

async function readConfigFile(configPath: string): Promise<unknown> {
  const content = await readFile(configPath, "utf8");
  return YAML.parse(content);
}

function defaultRawConfig(): RawConfig {
  const aiDevRoot = process.env.AI_DEV_ROOT ?? path.resolve(process.cwd(), "../..");
  return {
    server: {
      transport: "streamable-http",
      host: "127.0.0.1",
      port: 7421,
      allowed_hosts: [],
      max_sessions: 100,
      session_idle_ttl_ms: 1800000,
      bearer_token_env: "SKILL_CATALOG_TOKEN",
      session_mode: "stateful"
    },
    roots: [
      {
        name: "skill-catalog-internal-skills",
        path: path.join(aiDevRoot, "_infra/skill-catalog/skills"),
        default_trust_status: "trusted"
      },
      {
        name: "ai-dev-skills",
        path: path.join(aiDevRoot, "_infra/skills/skills"),
        default_trust_status: "trusted"
      }
    ],
    storage: {
      sqlite_path: "~/.cache/skill-catalog/catalog.sqlite"
    },
    search: {
      default_limit: 5,
      max_limit: 20,
      qmd: {
        enabled: false,
        collection: "skill-catalog",
        command: "qmd"
      }
    },
    limits: {
      max_skill_bytes: 262144,
      max_inline_reference_bytes: 131072,
      max_http_body_bytes: 1048576,
      follow_symlinks: false,
      rate_limit: {
        enabled: true,
        window_ms: 60000,
        max_requests: 120,
        max_entries: 1000
      }
    }
  };
}

export function expandConfiguredPath(value: string, baseDir = process.cwd()): string {
  const substituted = value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_match, name: string) => {
    const envValue = process.env[name];
    if (envValue === undefined) {
      throw new ConfigError(`Environment variable ${name} is not set`);
    }
    return envValue;
  });

  const expandedHome = substituted === "~" ? os.homedir() : substituted.replace(/^~(?=\/)/, os.homedir());
  return path.isAbsolute(expandedHome) || expandedHome === ":memory:"
    ? path.normalize(expandedHome)
    : path.resolve(baseDir, expandedHome);
}

async function validateConfiguredRoots(config: AppConfig): Promise<void> {
  for (const root of config.roots) {
    let rootStat;
    try {
      rootStat = await lstat(root.path);
    } catch {
      throw new ConfigError(`Configured root "${root.name}" does not exist: ${root.path}`);
    }
    if (!config.limits.followSymlinks && rootStat.isSymbolicLink()) {
      throw new ConfigError(`Configured root "${root.name}" cannot be a symlink: ${root.path}`);
    }
    if (!rootStat.isDirectory()) {
      throw new ConfigError(`Configured root "${root.name}" is not a directory: ${root.path}`);
    }
  }
}

export function resolveBearerToken(config: AppConfig): string | undefined {
  if (!config.server.bearerTokenEnv) {
    return undefined;
  }
  return process.env[config.server.bearerTokenEnv];
}

/**
 * Fail fast when auth is configured but cannot take effect.
 *
 * When `server.bearer_token_env` names an environment variable that is unset
 * or empty, the server would otherwise boot with authentication silently
 * disabled on both `/mcp` and `/admin/api/*`. Running without auth must be an
 * explicit choice (omit `bearer_token_env`), never an accident.
 */
export function assertResolvedBearerToken(config: AppConfig): void {
  if (!config.server.bearerTokenEnv) {
    return;
  }
  const token = process.env[config.server.bearerTokenEnv];
  if (token === undefined || token.trim() === "") {
    throw new ConfigError(
      `server.bearer_token_env is set to "${config.server.bearerTokenEnv}" but that environment variable is unset or empty. ` +
        "Refusing to start with authentication silently disabled. " +
        "Export the token variable, or remove bearer_token_env from the config to run without auth intentionally."
    );
  }
}

export function configFileExists(configPath: string): boolean {
  return existsSync(configPath);
}
