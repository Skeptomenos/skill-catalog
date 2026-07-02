import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startMcpTestHarness, type McpTestHarness } from "./helpers/mcp-test-harness.js";

const harnesses: McpTestHarness[] = [];
const ADMIN_TOKEN = "admin-integration-secret";

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.close();
  }
});

async function startAdminHarness(): Promise<McpTestHarness> {
  const harness = await startMcpTestHarness({ bearerToken: ADMIN_TOKEN });
  harnesses.push(harness);
  return harness;
}

function adminHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${ADMIN_TOKEN}`,
    ...extra
  };
}

function adminPostHeaders(harness: McpTestHarness): Record<string, string> {
  return adminHeaders({
    "content-type": "application/json",
    origin: harness.url,
    "x-skill-catalog-admin": "true"
  });
}

describe("admin API against the real runtime", () => {
  it("serves status, config, and audit log with auth; rejects unauthenticated requests", async () => {
    const harness = await startAdminHarness();

    for (const route of ["/admin/api/status", "/admin/api/config", "/admin/api/audit-log"]) {
      const denied = await fetch(`${harness.url}${route}`);
      expect(denied.status, `${route} without auth`).toBe(401);
      await denied.text();
    }

    const status = await fetch(`${harness.url}/admin/api/status`, { headers: adminHeaders() });
    expect(status.status).toBe(200);
    const statusBody = (await status.json()) as {
      roots: Array<{ name: string; skills_indexed: number }>;
      duplicate_names: string[];
    };
    expect(statusBody.duplicate_names).toEqual(["fixture-duplicate"]);
    expect(statusBody.roots.find((root) => root.name === "fixture-trusted")?.skills_indexed).toBe(3);

    const config = await fetch(`${harness.url}/admin/api/config`, { headers: adminHeaders() });
    expect(config.status).toBe(200);
    const configBody = (await config.json()) as {
      server: { bearer_token_configured: boolean };
      roots: Array<{ name: string }>;
    };
    expect(configBody.server.bearer_token_configured).toBe(true);
    expect(configBody.roots.map((root) => root.name)).toEqual([
      "fixture-trusted",
      "fixture-review-required",
      "fixture-blocked"
    ]);
    expect(JSON.stringify(configBody)).not.toContain(ADMIN_TOKEN);
  });

  it("reflects MCP tool calls and rebuilds in the audit log", async () => {
    const harness = await startAdminHarness();
    const client = await harness.connectClient({ token: ADMIN_TOKEN });

    await client.callTool({ name: "search_skills", arguments: { query: "zqfixtureprd" } });
    await client.callTool({ name: "read_skill", arguments: { name_or_id: "fixture-prd" } });
    await client.callTool({
      name: "read_skill_reference",
      arguments: { name_or_id: "fixture-prd", relative_path: "docs/template.md" }
    });

    const audit = await fetch(`${harness.url}/admin/api/audit-log`, { headers: adminHeaders() });
    expect(audit.status).toBe(200);
    const auditBody = (await audit.json()) as { entries: Array<{ tool: string; skill_name: string | null }> };
    const tools = auditBody.entries.map((entry) => entry.tool);
    expect(tools).toContain("rebuild_index");
    expect(tools).toContain("search_skills");
    expect(
      auditBody.entries.some((entry) => entry.tool === "read_skill" && entry.skill_name === "fixture-prd")
    ).toBe(true);
    expect(
      auditBody.entries.some(
        (entry) => entry.tool === "read_skill_reference" && entry.skill_name === "fixture-prd"
      )
    ).toBe(true);
  });

  it("rebuild reflects filesystem changes in indexed state", async () => {
    const harness = await startAdminHarness();

    await rm(path.join(harness.config.roots[0].path, "fixture-incomplete"), {
      recursive: true,
      force: true
    });

    const rebuild = await fetch(`${harness.url}/admin/api/rebuild`, {
      method: "POST",
      headers: adminPostHeaders(harness)
    });
    expect(rebuild.status).toBe(200);
    const rebuildBody = (await rebuild.json()) as {
      status: { roots: Array<{ name: string; skills_indexed: number }> };
    };
    expect(
      rebuildBody.status.roots.find((root) => root.name === "fixture-trusted")?.skills_indexed
    ).toBe(2);
  });

  it("smoke endpoints call real services and return structured success/failure payloads", async () => {
    const harness = await startAdminHarness();

    const search = await fetch(`${harness.url}/admin/api/smoke/search`, {
      method: "POST",
      headers: adminPostHeaders(harness),
      body: JSON.stringify({ query: "zqfixtureprd" })
    });
    expect(search.status).toBe(200);
    const searchBody = (await search.json()) as { results: Array<{ name: string }> };
    expect(searchBody.results[0]?.name).toBe("fixture-prd");

    const missingQuery = await fetch(`${harness.url}/admin/api/smoke/search`, {
      method: "POST",
      headers: adminPostHeaders(harness),
      body: JSON.stringify({})
    });
    expect(missingQuery.status).toBe(400);
    await expect(missingQuery.json()).resolves.toMatchObject({ error: "query is required" });

    const readSkill = await fetch(`${harness.url}/admin/api/smoke/read-skill`, {
      method: "POST",
      headers: adminPostHeaders(harness),
      body: JSON.stringify({ name_or_id: "fixture-prd" })
    });
    expect(readSkill.status).toBe(200);
    const readSkillBody = (await readSkill.json()) as { content: string };
    expect(readSkillBody.content).toContain("Fixture PRD body");

    const readReference = await fetch(`${harness.url}/admin/api/smoke/read-reference`, {
      method: "POST",
      headers: adminPostHeaders(harness),
      body: JSON.stringify({ name_or_id: "fixture-prd", relative_path: "docs/template.md" })
    });
    expect(readReference.status).toBe(200);
    const readReferenceBody = (await readReference.json()) as { content: string };
    expect(readReferenceBody.content).toContain("Fixture template body");

    const blockedRead = await fetch(`${harness.url}/admin/api/smoke/read-skill`, {
      method: "POST",
      headers: adminPostHeaders(harness),
      body: JSON.stringify({ name_or_id: "fixture-blocked" })
    });
    expect(blockedRead.status).toBe(500);
    await expect(blockedRead.json()).resolves.toMatchObject({ code: "admin_api_error" });
  });

  it("keeps POST guard behavior consistent with the mocked admin guard tests", async () => {
    const harness = await startAdminHarness();

    const noHeader = await fetch(`${harness.url}/admin/api/rebuild`, {
      method: "POST",
      headers: adminHeaders()
    });
    expect(noHeader.status).toBe(403);
    await expect(noHeader.json()).resolves.toMatchObject({ code: "admin_post_guard_failed" });

    const crossOrigin = await fetch(`${harness.url}/admin/api/rebuild`, {
      method: "POST",
      headers: adminHeaders({
        origin: "http://evil.example",
        "x-skill-catalog-admin": "true"
      })
    });
    expect(crossOrigin.status).toBe(403);
    await expect(crossOrigin.json()).resolves.toMatchObject({ code: "admin_post_guard_failed" });
  });

  it("does not expose skill editing, import, approval, or trust-mutation endpoints", async () => {
    const harness = await startAdminHarness();

    const forbiddenRoutes = [
      { method: "POST", route: "/admin/api/skills" },
      { method: "PUT", route: "/admin/api/skills/fixture-prd" },
      { method: "PATCH", route: "/admin/api/skills/fixture-prd" },
      { method: "DELETE", route: "/admin/api/skills/fixture-prd" },
      { method: "POST", route: "/admin/api/import" },
      { method: "POST", route: "/admin/api/skills/fixture-prd/approve" },
      { method: "POST", route: "/admin/api/skills/fixture-prd/trust" }
    ];
    for (const { method, route } of forbiddenRoutes) {
      const response = await fetch(`${harness.url}${route}`, {
        method,
        headers: adminPostHeaders(harness)
      });
      expect([404, 405], `${method} ${route} -> ${response.status}`).toContain(response.status);
      await response.text();
    }
  });
});
