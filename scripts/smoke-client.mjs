// End-to-end MCP client checks for the smoke gate (invoked by scripts/smoke.sh).
// Connects to the running server with a real Streamable HTTP MCP client and
// asserts the public tool contract: tool listing, search_skills relevance and
// trust metadata, read_skill, read_skill_reference, skill_catalog_status, and
// blocked-skill denial on search and read surfaces.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.SMOKE_URL;
const token = process.env.SMOKE_TOKEN;
if (!url || !token) {
  console.error("SMOKE CLIENT FAIL: SMOKE_URL and SMOKE_TOKEN must be set");
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) {
    console.error(`SMOKE CLIENT FAIL: ${message}`);
    process.exit(1);
  }
}

const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { authorization: `Bearer ${token}` } }
});
const client = new Client({ name: "skill-catalog-smoke", version: "0.0.0" });

try {
  await client.connect(transport);

  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name).sort();
  for (const expected of ["read_skill", "read_skill_reference", "search_skills", "skill_catalog_status"]) {
    assert(toolNames.includes(expected), `tool ${expected} missing from tools/list (got: ${toolNames.join(", ")})`);
  }

  const search = await client.callTool({
    name: "search_skills",
    arguments: { query: "zqsmokeprd planning" }
  });
  assert(!search.isError, "search_skills returned isError");
  const searchResults = search.structuredContent?.results ?? [];
  assert(searchResults.length > 0, "search_skills returned no results for fixture query");
  assert(
    searchResults[0].name === "smoke-prd",
    `search_skills top result was ${searchResults[0]?.name}, expected smoke-prd`
  );
  assert(
    (searchResults[0].matched_backends ?? []).includes("fts"),
    "search_skills top result missing fts backend attribution"
  );

  const blockedSearch = await client.callTool({
    name: "search_skills",
    arguments: { query: "zqsmokeblocked" }
  });
  const blockedNames = (blockedSearch.structuredContent?.results ?? []).map((result) => result.name);
  assert(
    !blockedNames.includes("smoke-blocked-skill"),
    "blocked skill surfaced in search_skills results"
  );

  const skill = await client.callTool({
    name: "read_skill",
    arguments: { name_or_id: "smoke-prd" }
  });
  assert(!skill.isError, "read_skill smoke-prd returned isError");
  assert(
    (skill.structuredContent?.content ?? "").includes("Smoke PRD body"),
    "read_skill content missing fixture body"
  );

  const blockedRead = await client.callTool({
    name: "read_skill",
    arguments: { name_or_id: "smoke-blocked-skill" }
  });
  assert(blockedRead.isError === true, "read_skill on a blocked skill did not return an error");

  const reference = await client.callTool({
    name: "read_skill_reference",
    arguments: { name_or_id: "smoke-prd", relative_path: "docs/template.md" }
  });
  assert(!reference.isError, "read_skill_reference returned isError");
  assert(
    (reference.structuredContent?.content ?? "").includes("Smoke template body"),
    "read_skill_reference content missing fixture body"
  );

  const traversal = await client.callTool({
    name: "read_skill_reference",
    arguments: { name_or_id: "smoke-prd", relative_path: "../smoke-git/SKILL.md" }
  });
  assert(traversal.isError === true, "read_skill_reference allowed path traversal");

  const status = await client.callTool({ name: "skill_catalog_status", arguments: {} });
  assert(!status.isError, "skill_catalog_status returned isError");
  const statusBody = status.structuredContent;
  const trustedRoot = (statusBody?.roots ?? []).find((root) => root.name === "smoke-trusted");
  const blockedRoot = (statusBody?.roots ?? []).find((root) => root.name === "smoke-blocked");
  assert(trustedRoot, "status missing smoke-trusted root");
  assert(blockedRoot, "status missing smoke-blocked root");
  assert(
    trustedRoot.skills_indexed === 2,
    `smoke-trusted skills_indexed was ${trustedRoot?.skills_indexed}, expected 2`
  );
  assert(
    statusBody?.search_backends?.fts === "ready",
    `status fts backend was ${statusBody?.search_backends?.fts}, expected ready`
  );

  console.log("SMOKE CLIENT OK");
} finally {
  await client.close().catch(() => {});
}
