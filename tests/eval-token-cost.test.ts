import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildSkillRoutingCostEval,
  countText,
  loadTraceFixture,
  renderNativePreloadManifest,
  stableStringify,
  toPromptVisibleResultText
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
});
