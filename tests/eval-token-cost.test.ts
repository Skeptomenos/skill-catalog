import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildSkillRoutingCostEval,
  countText,
  loadTraceFixture,
  renderCandidateMcpToolManifestForTest,
  renderNativePreloadManifest,
  stableStringify,
  toPromptVisibleResultText,
  validateProjectedCandidateResponseForTest
} from "../scripts/eval-skill-routing-cost.js";

const currentFile = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(currentFile), "..");
const traceFixturePath = path.join(projectRoot, "tests/fixtures/eval-skill-routing-traces.json");
const canonicalSkillsRoot = "/Users/david.helmus/repos/ai-dev/_infra/skills/skills";

describe("skill routing token cost eval", () => {
  it("renders native preload entries deterministically with only name and description", () => {
    const first = renderNativePreloadManifest([
      {
        name: "zeta",
        description: "Last entry.",
        author: "ignored",
        triggers: ["ignored"]
      },
      {
        name: "alpha",
        description: "First entry.",
        source: { type: "self" }
      }
    ]);
    const second = renderNativePreloadManifest([
      {
        name: "alpha",
        description: "First entry.",
        source: { type: "self" }
      },
      {
        name: "zeta",
        description: "Last entry.",
        author: "ignored",
        triggers: ["ignored"]
      }
    ]);

    expect(first).toBe(second);
    expect(first).toBe("alpha: First entry.\nzeta: Last entry.\n");
    expect(first).not.toContain("author");
    expect(first).not.toContain("triggers");
    expect(first).not.toContain("source");
  });

  it("counts UTF-8 bytes, Unicode characters, and four-character approximate tokens", () => {
    expect(countText("abc😀")).toEqual({
      bytes: 7,
      characters: 4,
      approx_tokens_4char: 1
    });
    expect(countText("abcde")).toEqual({
      bytes: 5,
      characters: 5,
      approx_tokens_4char: 2
    });
  });

  it("matches the MCP structuredResult prompt-visible text shape", () => {
    const result = { query: "git workflow", results: [{ name: "git-workflow" }] };
    const text = toPromptVisibleResultText(result);

    expect(text).toBe(JSON.stringify(result, null, 2));
    expect(countText(text).characters).toBeGreaterThan(JSON.stringify(result).length);
  });

  it("loads a fixture with exact MCP calls, expectations, and no-skill traces", () => {
    const traces = loadTraceFixture(traceFixturePath);
    expect(traces.map((trace) => trace.id)).toEqual([...traces.map((trace) => trace.id)].sort());
    expect(traces.length).toBeGreaterThanOrEqual(8);
    expect(traces.some((trace) => trace.no_skill_task)).toBe(true);

    for (const trace of traces) {
      if (trace.no_skill_task) {
        expect(trace.mcp_calls).toEqual([]);
        expect(trace.expected_result_skill_names).toEqual([]);
        continue;
      }

      expect(trace.expected_result_skill_names.length, trace.id).toBeGreaterThan(0);
      for (const call of trace.mcp_calls) {
        if (call.tool === "search_skills") {
          expect(call.arguments).toHaveProperty("query");
          expect(call.arguments).toHaveProperty("limit");
          expect(call.arguments).toHaveProperty("include_incomplete_metadata");
        }
      }
    }
  });

  it.runIf(existsSync(canonicalSkillsRoot))(
    "builds a deterministic canonical-root report with passing trace expectations",
    async () => {
      const first = await buildSkillRoutingCostEval({
        root: canonicalSkillsRoot,
        traceFixturePath
      });
      const second = await buildSkillRoutingCostEval({
        root: canonicalSkillsRoot,
        traceFixturePath
      });

      const firstJson = stableStringify(first);
      expect(firstJson).toBe(stableStringify(second));
      expect(firstJson).not.toMatch(/generated_at|timestamp|created_at/);
      expect(first.corpus.skill_count).toBeGreaterThanOrEqual(60);
      expect(first.surfaces.native_preload_baseline.counts.characters).toBeGreaterThan(5000);
      expect(first.surfaces.native_preload_baseline.description).toContain("name + description");
      expect(first.summary.trace_count).toBe(first.summary.triggered_trace_count + first.summary.no_skill_trace_count);
      expect(first.summary.discovery_cheaper_than_native_triggered_trace_count).toBe(0);
      expect(first.summary.full_read_cheaper_than_native_triggered_trace_count).toBe(0);
      expect(first.summary.discovery_cheaper_than_native_all_trace_count).toBeGreaterThanOrEqual(
        first.summary.discovery_cheaper_than_native_triggered_trace_count
      );

      const searchCall = first.traces
        .flatMap((trace) => trace.calls)
        .find((call) => call.tool === "search_skills");
      expect(searchCall?.prompt_visible_result_text.counts.characters).toBeGreaterThan(
        searchCall?.structured_content_compact_json.counts.characters ?? 0
      );

      for (const trace of first.traces) {
        expect(trace.expectations.every((check) => check.ok), trace.id).toBe(true);
      }
    }
  );

  it("builds candidate reports against a temp skill root without the canonical ai-dev skills checkout", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "skill-catalog-eval-"));
    try {
      const skillsRoot = path.join(tempRoot, "skills");
      const tracePath = path.join(tempRoot, "traces.json");
      await mkdir(path.join(skillsRoot, "skill-router"), { recursive: true });
      await mkdir(path.join(skillsRoot, "temp-helper"), { recursive: true });
      await writeFile(
        path.join(skillsRoot, "skill-router", "SKILL.md"),
        [
          "---",
          "name: skill-router",
          "description: Route skill discovery requests through the catalog search preflight.",
          "triggers:",
          "  - route skill discovery",
          "when_to_use:",
          "  - Use when selecting skills through catalog search.",
          "when_not_to_use:",
          "  - Do not use for trivial no-skill tasks.",
          "---",
          "",
          "# Skill Router",
          "",
          "Use catalog search for routing skill discovery requests."
        ].join("\n"),
        "utf8"
      );
      await writeFile(
        path.join(skillsRoot, "temp-helper", "SKILL.md"),
        [
          "---",
          "name: temp-helper",
          "description: Temporary helper skill for unrelated fixture searches.",
          "triggers:",
          "  - temporary helper",
          "---",
          "",
          "# Temp Helper"
        ].join("\n"),
        "utf8"
      );
      await writeFile(
        tracePath,
        JSON.stringify(
          [
            {
              id: "temp_skill_router_search",
              prompt: "Route a skill discovery request through catalog search.",
              mode: "discovery_only",
              no_skill_task: false,
              mcp_calls: [
                {
                  tool: "search_skills",
                  arguments: {
                    query: "route skill discovery catalog search",
                    limit: 10,
                    include_incomplete_metadata: true
                  }
                }
              ],
              expected_result_skill_names: [
                {
                  call_index: 0,
                  name: "skill-router",
                  min_rank: 1,
                  max_rank: 5
                }
              ],
              selected_read_skill_names: [],
              read_skill_reference_paths: []
            },
            {
              id: "temp_no_skill",
              prompt: "What time is it?",
              mode: "discovery_only",
              no_skill_task: true,
              mcp_calls: [],
              expected_result_skill_names: [],
              selected_read_skill_names: [],
              read_skill_reference_paths: []
            }
          ],
          null,
          2
        ),
        "utf8"
      );

      const report = await buildSkillRoutingCostEval({
        root: skillsRoot,
        traceFixturePath: tracePath
      });

      expect(report.candidate_contracts.map((candidate) => candidate.id)).toEqual([
        "rich_limit_10",
        "rich_limit_5",
        "same_tool_sparse_schema",
        "same_tool_exact_union_without_score",
        "same_tool_exact_union_with_score",
        "same_tool_loose_schema_without_score",
        "same_tool_loose_schema_with_score",
        "additive_lightweight_tool_without_score",
        "additive_lightweight_tool_with_score"
      ]);
      for (const candidate of report.candidate_contracts) {
        expect(candidate.schema_validation.ok, candidate.id).toBe(true);
        expect(candidate.schema_validation.validated_projected_response_count, candidate.id).toBe(1);
        expect(candidate.expected_skill_rank_checks.every((check) => check.ok), candidate.id).toBe(true);
      }
      expect(
        report.candidate_contracts
          .filter((candidate) => candidate.public_contract_weakening)
          .map((candidate) => candidate.id)
      ).toEqual(["same_tool_loose_schema_without_score", "same_tool_loose_schema_with_score"]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("reports candidate schema-validation failures with candidate and trace context", () => {
    let thrown: unknown;
    try {
      validateProjectedCandidateResponseForTest(
        "additive_lightweight_tool_without_score",
        {
          query: "invalid projection",
          results: [
            {
              id: "missing-required-compact-fields"
            }
          ]
        },
        "negative_schema_trace",
        2
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("Candidate additive_lightweight_tool_without_score");
    expect(message).toContain("negative_schema_trace");
    expect(message).toContain("call 2");
  });

  it.runIf(existsSync(canonicalSkillsRoot))(
    "reports compact discovery candidate scenarios with deterministic static, triggered, and rank-check metrics",
    async () => {
      const first = await buildSkillRoutingCostEval({
        root: canonicalSkillsRoot,
        traceFixturePath
      });
      const second = await buildSkillRoutingCostEval({
        root: canonicalSkillsRoot,
        traceFixturePath
      });

      expect(stableStringify(first.candidate_contracts)).toBe(stableStringify(second.candidate_contracts));
      expect(first.candidate_contracts.map((candidate) => candidate.id)).toEqual([
        "rich_limit_10",
        "rich_limit_5",
        "same_tool_sparse_schema",
        "same_tool_exact_union_without_score",
        "same_tool_exact_union_with_score",
        "same_tool_loose_schema_without_score",
        "same_tool_loose_schema_with_score",
        "additive_lightweight_tool_without_score",
        "additive_lightweight_tool_with_score"
      ]);

      for (const candidate of first.candidate_contracts) {
        expect(candidate.mcp_tool_manifest_static_cost.counts.characters, candidate.id).toBeGreaterThan(0);
        expect(candidate.mcp_static_session_cost.counts.characters, candidate.id).toBeGreaterThan(0);
        expect(candidate.static_delta_vs_native_preload.characters, candidate.id).toBe(
          candidate.mcp_static_session_cost.counts.characters -
            first.surfaces.native_preload_baseline.counts.characters
        );
        expect(typeof candidate.preserves_static_mcp_advantage, candidate.id).toBe("boolean");
        expect(candidate.discovery_call_argument_characters.characters, candidate.id).toBeGreaterThanOrEqual(0);
        expect(candidate.prompt_visible_result_text_characters.characters, candidate.id).toBeGreaterThanOrEqual(0);
        expect(candidate.total_discovery_cost.characters, candidate.id).toBe(
          candidate.mcp_static_session_cost.counts.characters +
            first.surfaces.skill_router_full_body_when_triggered.counts.characters +
            candidate.discovery_call_argument_characters.characters +
            candidate.prompt_visible_result_text_characters.characters
        );
        expect(candidate.delta_vs_native_preload.characters, candidate.id).toBe(
          candidate.total_discovery_cost.characters - first.surfaces.native_preload_baseline.counts.characters
        );
        expect(candidate.delta_vs_current_rich_baseline.characters, candidate.id).toBe(
          candidate.total_discovery_cost.characters - first.candidate_contracts[0].total_discovery_cost.characters
        );
        expect(candidate.schema_validation.ok, candidate.id).toBe(true);
        expect(candidate.schema_validation.validated_projected_response_count, candidate.id).toBeGreaterThan(0);
        expect(candidate.expected_skill_rank_checks.length, candidate.id).toBeGreaterThan(0);
        expect(candidate.expected_skill_rank_checks.every((check) => check.trace_id && check.name), candidate.id).toBe(true);
        expect(candidate.expected_skill_rank_checks.every((check) => check.ok), candidate.id).toBe(true);
      }

      expect(
        first.candidate_contracts
          .filter((candidate) => candidate.public_contract_weakening)
          .map((candidate) => candidate.id)
      ).toEqual(["same_tool_loose_schema_without_score", "same_tool_loose_schema_with_score"]);

      for (const candidateId of ["additive_lightweight_tool_without_score", "additive_lightweight_tool_with_score"]) {
        const additive = first.candidate_contracts.find((candidate) => candidate.id === candidateId);
        expect(additive?.manifest_tool_names).toEqual([
          "search_skills",
          "read_skill",
          "read_skill_reference",
          "skill_catalog_status",
          "discover_skills_compact"
        ]);

        const manifest = JSON.parse(renderCandidateMcpToolManifestForTest(candidateId).text) as Array<{
          readonly name: string;
          readonly input_schema?: unknown;
          readonly output_schema_name?: string;
        }>;
        const searchTool = manifest.find((tool) => tool.name === "search_skills");
        const compactTool = manifest.find((tool) => tool.name === "discover_skills_compact");
        expect(searchTool?.output_schema_name).toBe("SearchOutputSchema");
        expect(JSON.stringify(searchTool?.input_schema)).not.toContain("response_mode");
        expect(compactTool?.output_schema_name).toBe(
          candidateId.endsWith("_with_score")
            ? "CompactSearchOutputWithScoreSchema"
            : "CompactSearchOutputWithoutScoreSchema"
        );
      }
    }
  );
});
