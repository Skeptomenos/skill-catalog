import { afterEach, describe, expect, it } from "vitest";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { Effect } from "effect";
import { createHttpApp, type SkillCatalogRuntime } from "../src/mcp/mcp-server.js";
import type { AppConfig, CatalogStatus, SyncResult } from "../src/types.js";

const servers: Array<{ close: () => void }> = [];
const TEST_TOKEN_ENV = "SKILL_CATALOG_TEST_TOKEN";

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
  delete process.env[TEST_TOKEN_ENV];
});

describe("MCP HTTP server", () => {
  it("rate limits repeated MCP requests in memory", async () => {
    const app = createHttpApp(testRuntime());
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/mcp`;

    const first = await fetch(url);
    expect(first.status).toBe(400);

    const second = await fetch(url);
    expect(second.status).toBe(429);
    await expect(second.json()).resolves.toMatchObject({
      error: {
        message: "Too Many Requests"
      }
    });
  });

  it("rejects oversized MCP JSON bodies before transport handling", async () => {
    const app = createHttpApp(testRuntime({ maxHttpBodyBytes: 64, maxRequests: 10 }));
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/mcp`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: "x".repeat(2048) })
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        message: "Request body too large"
      }
    });
  });

  it("renders the management UI shell", async () => {
    const app = createHttpApp(testRuntime({ maxRequests: 10 }));
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/admin`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Skill Catalog Admin");
  });

  it("accepts configured MagicDNS host headers and rejects unrelated hosts", async () => {
    const app = createHttpApp(
      testRuntime({
        host: "100.64.0.10",
        allowedHosts: ["skillbox.tailnet.ts.net"],
        maxRequests: 10
      })
    );
    const { url } = await listen(app);

    const tailscaleIp = await requestStatusWithHost(url, "100.64.0.10");
    expect(tailscaleIp).toBe(200);

    const magicDns = await requestStatusWithHost(url, "skillbox.tailnet.ts.net");
    expect(magicDns).toBe(200);

    const unrelated = await requestStatusWithHost(url, "evil.example");
    expect(unrelated).toBe(403);
  });

  it("requires auth before admin rebuild requests can reach POST guards", async () => {
    process.env[TEST_TOKEN_ENV] = "admin-secret";
    const { runtime } = testAdminRuntime({ bearerTokenEnv: TEST_TOKEN_ENV, maxRequests: 10 });
    const { url } = await listen(createHttpApp(runtime));

    const response = await fetch(`${url}/admin/api/rebuild`, { method: "POST" });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "Unauthorized" });
  });

  it("rejects authenticated admin POSTs without the custom admin header", async () => {
    process.env[TEST_TOKEN_ENV] = "admin-secret";
    const { runtime, calls } = testAdminRuntime({ bearerTokenEnv: TEST_TOKEN_ENV, maxRequests: 10 });
    const { url } = await listen(createHttpApp(runtime));

    const response = await fetch(`${url}/admin/api/rebuild`, {
      method: "POST",
      headers: { authorization: "Bearer admin-secret" }
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "Forbidden",
      code: "admin_post_guard_failed"
    });
    expect(calls.rebuilds).toBe(0);
  });

  it("rejects cross-origin admin POSTs even with auth and the custom admin header", async () => {
    process.env[TEST_TOKEN_ENV] = "admin-secret";
    const { runtime, calls } = testAdminRuntime({ bearerTokenEnv: TEST_TOKEN_ENV, maxRequests: 10 });
    const { url } = await listen(createHttpApp(runtime));

    const response = await fetch(`${url}/admin/api/rebuild`, {
      method: "POST",
      headers: {
        authorization: "Bearer admin-secret",
        origin: "http://evil.example",
        "x-skill-catalog-admin": "true"
      }
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "Forbidden",
      code: "admin_post_guard_failed"
    });
    expect(calls.rebuilds).toBe(0);
  });

  it("allows same-origin authenticated admin POSTs with the custom admin header", async () => {
    process.env[TEST_TOKEN_ENV] = "admin-secret";
    const { runtime, calls } = testAdminRuntime({ bearerTokenEnv: TEST_TOKEN_ENV, maxRequests: 10 });
    const { url } = await listen(createHttpApp(runtime));

    const response = await fetch(`${url}/admin/api/rebuild`, {
      method: "POST",
      headers: {
        authorization: "Bearer admin-secret",
        origin: url,
        "x-skill-catalog-admin": "true"
      }
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: testStatus() });
    expect(calls.rebuilds).toBe(1);
  });

  it("accepts only well-formed configured bearer tokens on MCP requests", async () => {
    process.env[TEST_TOKEN_ENV] = "admin-secret";
    const { runtime } = testAdminRuntime({ bearerTokenEnv: TEST_TOKEN_ENV, maxRequests: 10 });
    const { url } = await listen(createHttpApp(runtime));

    for (const authorization of [undefined, "Basic admin-secret", "Bearer wrong-secret", "Bearer admin-secret extra"]) {
      const response = await fetch(`${url}/mcp`, {
        headers: authorization ? { authorization } : undefined
      });
      expect(response.status).toBe(401);
    }

    const accepted = await fetch(`${url}/mcp`, {
      headers: { authorization: "Bearer admin-secret" }
    });
    expect(accepted.status).toBe(400);
  });

  it("accepts only well-formed configured bearer tokens on admin API requests", async () => {
    process.env[TEST_TOKEN_ENV] = "admin-secret";
    const { runtime } = testAdminRuntime({ bearerTokenEnv: TEST_TOKEN_ENV, maxRequests: 10 });
    const { url } = await listen(createHttpApp(runtime));

    for (const authorization of [undefined, "Basic admin-secret", "Bearer wrong-secret", "Bearer admin-secret extra"]) {
      const response = await fetch(`${url}/admin/api/status`, {
        headers: authorization ? { authorization } : undefined
      });
      expect(response.status).toBe(401);
    }

    const accepted = await fetch(`${url}/admin/api/status`, {
      headers: { authorization: "Bearer admin-secret" }
    });
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toEqual(testStatus());
  });

  it("initializes and reuses a stateful MCP session id", async () => {
    const { url } = await listen(createHttpApp(testRuntime({ maxRequests: 10 })));
    const mcpUrl = `${url}/mcp`;

    const sessionId = await initializeMcpSession(mcpUrl);
    const initialized = await postMcp(mcpUrl, initializedNotification(), sessionId);

    expect(sessionId).toBeTruthy();
    expect(initialized.status).toBe(202);
    await initialized.text();
  });

  it("removes a stateful MCP session on DELETE", async () => {
    const { url } = await listen(createHttpApp(testRuntime({ maxRequests: 10 })));
    const mcpUrl = `${url}/mcp`;
    const sessionId = await initializeMcpSession(mcpUrl);

    const deleted = await fetch(mcpUrl, {
      method: "DELETE",
      headers: {
        "mcp-session-id": sessionId,
        "mcp-protocol-version": "2025-03-26"
      }
    });
    expect(deleted.status).toBe(200);
    await deleted.text();

    const reuse = await postMcp(mcpUrl, initializedNotification(), sessionId);
    expect(reuse.status).toBe(400);
    await reuse.text();
  });

  it("rejects unknown stateful MCP session ids", async () => {
    const { url } = await listen(createHttpApp(testRuntime({ maxRequests: 10 })));
    const response = await postMcp(`${url}/mcp`, initializedNotification(), "missing-session");

    expect(response.status).toBe(400);
    await response.text();
  });

  it("prunes expired stateful MCP sessions before enforcing the max-session cap", async () => {
    const { url } = await listen(
      createHttpApp(testRuntime({ maxRequests: 10, maxSessions: 1, sessionIdleTtlMs: 1 }))
    );
    const mcpUrl = `${url}/mcp`;

    const firstSessionId = await initializeMcpSession(mcpUrl);
    await sleep(5);
    const secondSessionId = await initializeMcpSession(mcpUrl, 2);

    expect(firstSessionId).toBeTruthy();
    expect(secondSessionId).toBeTruthy();
    expect(secondSessionId).not.toBe(firstSessionId);
  });

  it("enforces the stateful MCP max-session cap", async () => {
    const { url } = await listen(
      createHttpApp(testRuntime({ maxRequests: 10, maxSessions: 1, sessionIdleTtlMs: 60000 }))
    );
    const mcpUrl = `${url}/mcp`;

    await initializeMcpSession(mcpUrl);
    const second = await postMcp(mcpUrl, initializeRequest(2));

    expect(second.status).toBe(429);
    await expect(second.json()).resolves.toMatchObject({
      error: {
        message: "Too Many Stateful Sessions"
      }
    });
  });

  it("rate limits repeated authenticated admin rebuild requests", async () => {
    process.env[TEST_TOKEN_ENV] = "admin-secret";
    const { runtime, calls } = testAdminRuntime({ bearerTokenEnv: TEST_TOKEN_ENV, maxRequests: 1 });
    const { url } = await listen(createHttpApp(runtime));
    const request = () =>
      fetch(`${url}/admin/api/rebuild`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-secret",
          "x-skill-catalog-admin": "true"
        }
      });

    const first = await request();
    expect(first.status).toBe(200);

    const second = await request();
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBeTruthy();
    await expect(second.json()).resolves.toMatchObject({
      error: "Too Many Requests",
      code: "rate_limited"
    });
    expect(calls.rebuilds).toBe(1);
  });
});

function testRuntime(
  overrides: {
    readonly allowedHosts?: readonly string[];
    readonly host?: string;
    readonly maxHttpBodyBytes?: number;
    readonly maxRequests?: number;
    readonly maxSessions?: number;
    readonly sessionIdleTtlMs?: number;
  } = {}
): SkillCatalogRuntime {
  return {
    config: testConfig(overrides),
    store: {} as SkillCatalogRuntime["store"],
    search: {} as SkillCatalogRuntime["search"],
    references: {} as SkillCatalogRuntime["references"]
  };
}

function testAdminRuntime(
  overrides: { readonly bearerTokenEnv?: string; readonly maxRequests?: number } = {}
): { readonly runtime: SkillCatalogRuntime; readonly calls: { rebuilds: number } } {
  const calls = { rebuilds: 0 };
  const runtime: SkillCatalogRuntime = {
    config: testConfig({ bearerTokenEnv: overrides.bearerTokenEnv, maxRequests: overrides.maxRequests ?? 10 }),
    store: {
      rebuild: (_sync: SyncResult) =>
        Effect.sync(() => {
          calls.rebuilds += 1;
        }),
      status: () => Effect.succeed(testStatus())
    } as unknown as SkillCatalogRuntime["store"],
    search: {} as SkillCatalogRuntime["search"],
    references: {} as SkillCatalogRuntime["references"]
  };
  return { runtime, calls };
}

async function listen(app: ReturnType<typeof createHttpApp>): Promise<{ readonly url: string }> {
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}` };
}

async function requestStatusWithHost(url: string, host: string): Promise<number> {
  const parsed = new URL(url);
  return await new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: "/health",
        method: "GET",
        headers: { Host: host }
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function testStatus(): CatalogStatus {
  return {
    roots: [],
    duplicate_names: [],
    metadata_warnings: [],
    search_backends: { fts: "empty", qmd: "disabled" },
    search_backend_warnings: []
  };
}

function testConfig(
  overrides: {
    readonly allowedHosts?: readonly string[];
    readonly bearerTokenEnv?: string;
    readonly host?: string;
    readonly maxHttpBodyBytes?: number;
    readonly maxRequests?: number;
    readonly maxSessions?: number;
    readonly sessionIdleTtlMs?: number;
  } = {}
): AppConfig {
  return {
    server: {
      transport: "streamable-http",
      host: overrides.host ?? "127.0.0.1",
      port: 7421,
      allowedHosts: overrides.allowedHosts ?? [],
      maxSessions: overrides.maxSessions ?? 100,
      sessionIdleTtlMs: overrides.sessionIdleTtlMs ?? 1800000,
      bearerTokenEnv: overrides.bearerTokenEnv,
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
      maxInlineReferenceBytes: 1024,
      maxHttpBodyBytes: overrides.maxHttpBodyBytes ?? 1048576,
      followSymlinks: false,
      rateLimit: {
        enabled: true,
        windowMs: 60000,
        maxRequests: overrides.maxRequests ?? 1,
        maxEntries: 1000
      }
    }
  };
}

async function initializeMcpSession(url: string, id = 1): Promise<string> {
  const response = await postMcp(url, initializeRequest(id));
  expect(response.status).toBe(200);
  const sessionId = response.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();
  await response.text();
  return sessionId ?? "";
}

async function postMcp(url: string, body: Record<string, unknown>, sessionId?: string): Promise<Response> {
  return await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId
        ? {
            "mcp-session-id": sessionId,
            "mcp-protocol-version": "2025-03-26"
          }
        : {})
    },
    body: JSON.stringify(body)
  });
}

function initializeRequest(id: number): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.0.0" }
    }
  };
}

function initializedNotification(): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {}
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
