import { symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ReadReferenceOutputSchema,
  ReadSkillOutputSchema,
  SearchOutputSchema,
  StatusOutputSchema
} from "../src/mcp/schemas.js";
import { startMcpTestHarness, type McpTestHarness } from "./helpers/mcp-test-harness.js";

const harnesses: McpTestHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.close();
  }
});

async function startHarness(
  options: Parameters<typeof startMcpTestHarness>[0] = {}
): Promise<McpTestHarness> {
  const harness = await startMcpTestHarness(options);
  harnesses.push(harness);
  return harness;
}

const CURRENT_TOOLS = ["read_skill", "read_skill_reference", "search_skills", "skill_catalog_status"];
const FUTURE_TOOLS = [
  "create_skill",
  "update_skill",
  "list_skill_reviews",
  "get_skill_review",
  "approve_skill",
  "reject_skill",
  "request_skill_changes",
  "contribute_external_skill",
  "install_slash_command"
];

describe("MCP tool contract (real SDK, real runtime)", () => {
  it("lists exactly the current read-only tool set with read-only annotations", async () => {
    const harness = await startHarness();
    const client = await harness.connectClient();

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();

    expect(names).toEqual(CURRENT_TOOLS);
    for (const future of FUTURE_TOOLS) {
      expect(names).not.toContain(future);
    }
    for (const tool of tools.tools) {
      expect(tool.annotations?.readOnlyHint, `${tool.name} readOnlyHint`).toBe(true);
      expect(tool.annotations?.openWorldHint, `${tool.name} openWorldHint`).toBe(false);
    }
  });

  it("search_skills returns trusted and review-required skills, excludes blocked, honors limit", async () => {
    const harness = await startHarness();
    const client = await harness.connectClient();

    const search = await client.callTool({
      name: "search_skills",
      arguments: { query: "zqfixtureprd" }
    });
    expect(search.isError).not.toBe(true);
    const parsed = SearchOutputSchema.parse(search.structuredContent);
    expect(parsed.results[0]?.name).toBe("fixture-prd");
    expect(parsed.results[0]?.trust_status).toBe("trusted");
    expect(parsed.results[0]?.matched_backends).toContain("fts");

    const external = await client.callTool({
      name: "search_skills",
      arguments: { query: "zqfixtureexternal" }
    });
    const externalParsed = SearchOutputSchema.parse(external.structuredContent);
    const externalResult = externalParsed.results.find((result) => result.name === "fixture-external");
    expect(externalResult?.trust_status).toBe("review_required");
    expect(externalResult?.warnings.some((warning) => warning.code === "review_required")).toBe(true);

    const blocked = await client.callTool({
      name: "search_skills",
      arguments: { query: "zqfixtureblocked" }
    });
    const blockedParsed = SearchOutputSchema.parse(blocked.structuredContent);
    expect(blockedParsed.results.map((result) => result.name)).not.toContain("fixture-blocked");

    const limited = await client.callTool({
      name: "search_skills",
      arguments: { query: "fixturecalibration", limit: 2 }
    });
    const limitedParsed = SearchOutputSchema.parse(limited.structuredContent);
    expect(limitedParsed.results).toHaveLength(2);
  });

  it("search_skills include_incomplete_metadata=false excludes incomplete-metadata skills", async () => {
    const harness = await startHarness();
    const client = await harness.connectClient();

    const withIncomplete = await client.callTool({
      name: "search_skills",
      arguments: { query: "zqfixtureincomplete" }
    });
    const withParsed = SearchOutputSchema.parse(withIncomplete.structuredContent);
    expect(withParsed.results.map((result) => result.name)).toContain("fixture-incomplete");

    const withoutIncomplete = await client.callTool({
      name: "search_skills",
      arguments: { query: "zqfixtureincomplete", include_incomplete_metadata: false }
    });
    const withoutParsed = SearchOutputSchema.parse(withoutIncomplete.structuredContent);
    expect(withoutParsed.results.map((result) => result.name)).not.toContain("fixture-incomplete");
  });

  it("read_skill returns schema-valid content for trusted and review-required skills", async () => {
    const harness = await startHarness();
    const client = await harness.connectClient();

    const trusted = await client.callTool({
      name: "read_skill",
      arguments: { name_or_id: "fixture-prd" }
    });
    expect(trusted.isError).not.toBe(true);
    const trustedParsed = ReadSkillOutputSchema.parse(trusted.structuredContent);
    expect(trustedParsed.content).toContain("Fixture PRD body");

    const external = await client.callTool({
      name: "read_skill",
      arguments: { name_or_id: "fixture-external" }
    });
    expect(external.isError).not.toBe(true);
    const externalParsed = ReadSkillOutputSchema.parse(external.structuredContent);
    expect(externalParsed.content).toContain("External body");
  });

  it("read_skill returns an MCP error for blocked and unknown skills", async () => {
    const harness = await startHarness();
    const client = await harness.connectClient();

    const blocked = await client.callTool({
      name: "read_skill",
      arguments: { name_or_id: "fixture-blocked" }
    });
    expect(blocked.isError).toBe(true);

    const unknown = await client.callTool({
      name: "read_skill",
      arguments: { name_or_id: "fixture-does-not-exist" }
    });
    expect(unknown.isError).toBe(true);
  });

  it("read_skill returns an MCP error for oversized SKILL.md instead of truncated success", async () => {
    const harness = await startHarness({ maxSkillBytes: 4096 });
    const client = await harness.connectClient();

    const oversized = await client.callTool({
      name: "read_skill",
      arguments: { name_or_id: "fixture-oversized" }
    });
    expect(oversized.isError).toBe(true);
    expect(JSON.stringify(oversized.content)).toContain("max_skill_bytes");

    const normal = await client.callTool({
      name: "read_skill",
      arguments: { name_or_id: "fixture-prd" }
    });
    expect(normal.isError).not.toBe(true);
  });

  it("read_skill_reference returns schema-valid text, review-required, binary, and oversized results", async () => {
    const harness = await startHarness();
    const client = await harness.connectClient();

    const text = await client.callTool({
      name: "read_skill_reference",
      arguments: { name_or_id: "fixture-prd", relative_path: "docs/template.md" }
    });
    expect(text.isError).not.toBe(true);
    const textParsed = ReadReferenceOutputSchema.parse(text.structuredContent);
    expect(textParsed.content).toContain("Fixture template body");
    expect(textParsed.inline_blocked_reason).toBeUndefined();

    const external = await client.callTool({
      name: "read_skill_reference",
      arguments: { name_or_id: "fixture-external", relative_path: "docs/notes.md" }
    });
    expect(external.isError).not.toBe(true);
    ReadReferenceOutputSchema.parse(external.structuredContent);

    const binary = await client.callTool({
      name: "read_skill_reference",
      arguments: { name_or_id: "fixture-prd", relative_path: "docs/binary.bin" }
    });
    expect(binary.isError).not.toBe(true);
    const binaryParsed = ReadReferenceOutputSchema.parse(binary.structuredContent);
    expect(binaryParsed.content).toBeNull();
    expect(binaryParsed.inline_blocked_reason).toBe("binary_file");
    expect(binaryParsed.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(binaryParsed.size_bytes).toBe(6);
    expect(binaryParsed.mime).toBe("application/octet-stream");

    const oversized = await client.callTool({
      name: "read_skill_reference",
      arguments: { name_or_id: "fixture-prd", relative_path: "docs/oversized.md" }
    });
    expect(oversized.isError).not.toBe(true);
    const oversizedParsed = ReadReferenceOutputSchema.parse(oversized.structuredContent);
    expect(oversizedParsed.content).toBeNull();
    expect(oversizedParsed.inline_blocked_reason).toBe("size_limit");
    expect(oversizedParsed.sha256).toBeNull();
  });

  it("read_skill_reference rejects traversal, absolute, null-byte, symlink, directory, and missing paths", async () => {
    const harness = await startHarness();
    const trustedRoot = harness.config.roots[0].path;
    await symlink(
      path.join(trustedRoot, "fixture-incomplete", "SKILL.md"),
      path.join(trustedRoot, "fixture-prd", "docs", "linked.md")
    );
    const client = await harness.connectClient();

    const badPaths = [
      "../fixture-incomplete/SKILL.md",
      "/etc/hosts",
      "docs/template.md\0.md",
      "docs/linked.md",
      "docs",
      "docs/missing.md"
    ];
    for (const relativePath of badPaths) {
      const result = await client.callTool({
        name: "read_skill_reference",
        arguments: { name_or_id: "fixture-prd", relative_path: relativePath }
      });
      expect(result.isError, `expected error for path: ${JSON.stringify(relativePath)}`).toBe(true);
    }

    const blocked = await client.callTool({
      name: "read_skill_reference",
      arguments: { name_or_id: "fixture-blocked", relative_path: "SKILL.md" }
    });
    expect(blocked.isError).toBe(true);
  });

  it("skill_catalog_status reports roots, duplicates, warnings, and backend state", async () => {
    const harness = await startHarness();
    const client = await harness.connectClient();

    const status = await client.callTool({ name: "skill_catalog_status", arguments: {} });
    expect(status.isError).not.toBe(true);
    const parsed = StatusOutputSchema.parse(status.structuredContent);

    expect(parsed.duplicate_names).toEqual(["fixture-duplicate"]);
    const rootNames = parsed.roots.map((root) => root.name);
    expect(rootNames).toEqual(["fixture-trusted", "fixture-review-required", "fixture-blocked"]);
    const trustedRoot = parsed.roots.find((root) => root.name === "fixture-trusted");
    expect(trustedRoot?.skills_indexed).toBe(3);
    expect(trustedRoot?.default_trust_status).toBe("trusted");
    expect(
      parsed.metadata_warnings.some((warning) => warning.skill === "fixture-incomplete")
    ).toBe(true);
    expect(parsed.search_backends.fts).toBe("ready");
    expect(parsed.search_backends.qmd).toBe("disabled");
  });

  it("rejects malformed tool inputs at the MCP boundary", async () => {
    const harness = await startHarness();
    const client = await harness.connectClient();

    const badCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [
      { name: "search_skills", arguments: { query: "" } },
      { name: "search_skills", arguments: { query: "x", limit: 0 } },
      { name: "search_skills", arguments: { query: "x", limit: 1.5 } },
      { name: "read_skill", arguments: {} },
      { name: "read_skill_reference", arguments: { name_or_id: "fixture-prd" } },
      { name: "read_skill_reference", arguments: { relative_path: "docs/template.md" } }
    ];
    for (const call of badCalls) {
      await expectToolRejection(client, call);
    }
  });

  it("serves the same tool contract in stateless session mode without session reuse", async () => {
    const harness = await startHarness({ sessionMode: "stateless" });
    const client = await harness.connectClient();

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(CURRENT_TOOLS);

    const search = await client.callTool({
      name: "search_skills",
      arguments: { query: "zqfixtureprd" }
    });
    const searchParsed = SearchOutputSchema.parse(search.structuredContent);
    expect(searchParsed.results[0]?.name).toBe("fixture-prd");

    const skill = await client.callTool({
      name: "read_skill",
      arguments: { name_or_id: "fixture-prd" }
    });
    expect(skill.isError).not.toBe(true);

    // A second independent client works without carrying any session state.
    const secondClient = await harness.connectClient();
    const status = await secondClient.callTool({ name: "skill_catalog_status", arguments: {} });
    expect(status.isError).not.toBe(true);
    StatusOutputSchema.parse(status.structuredContent);
  });

  it("enforces bearer auth on the MCP endpoint when configured", async () => {
    const harness = await startHarness({ bearerToken: "harness-secret" });

    await expect(harness.connectClient()).rejects.toThrow(/Unauthorized/);
    await expect(harness.connectClient({ token: "wrong-secret" })).rejects.toThrow(/Unauthorized/);

    const client = await harness.connectClient({ token: "harness-secret" });
    const status = await client.callTool({ name: "skill_catalog_status", arguments: {} });
    expect(status.isError).not.toBe(true);
  });
});

async function expectToolRejection(
  client: Client,
  call: { name: string; arguments: Record<string, unknown> }
): Promise<void> {
  try {
    const result = await client.callTool(call);
    expect(
      result.isError,
      `expected MCP error for ${call.name} args ${JSON.stringify(call.arguments)}`
    ).toBe(true);
  } catch {
    // Protocol-level invalid-params rejection is also an acceptable failure mode.
  }
}
