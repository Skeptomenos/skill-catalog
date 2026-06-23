import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { z } from "zod/v4";
import {
  ReadReferenceInputSchema,
  ReadReferenceOutputSchema,
  ReadSkillInputSchema,
  ReadSkillOutputSchema,
  SearchInputSchema,
  SearchOutputSchema,
  StatusOutputSchema
} from "../src/mcp/schemas.js";
import { ReferenceService } from "../src/reference/reference-service.js";
import { SearchService } from "../src/search/search-service.js";
import { scanSkillRoots } from "../src/skills/scanner.js";
import { CatalogStore } from "../src/storage/catalog-store.js";
import type {
  AppConfig,
  ReadReferenceResponse,
  ReadSkillResponse,
  SearchResponse,
  SearchResultItem,
  SkillRecord,
  SyncResult
} from "../src/types.js";

export const DEFAULT_CANONICAL_SKILL_ROOT = "/Users/david.helmus/repos/ai-dev/_infra/skills/skills";

const currentFile = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(currentFile), "..");
const defaultTraceFixturePath = path.join(projectRoot, "tests/fixtures/eval-skill-routing-traces.json");
const reportJsonFileName = "skill-routing-token-cost.json";
const reportMarkdownFileName = "skill-routing-token-cost.md";

type ToolName = "search_skills" | "read_skill" | "read_skill_reference";
type TraceMode = "discovery_only" | "full_read";
type CandidateScoreVariant = "not_applicable" | "with_score" | "without_score";
type CandidateResultProjection = "rich" | "rich_limit_5" | "sparse" | "compact";

export interface TextCounts {
  readonly bytes: number;
  readonly characters: number;
  readonly approx_tokens_4char: number;
}

export interface SurfaceReport {
  readonly id: string;
  readonly description: string;
  readonly counts: TextCounts;
  readonly sha256: string;
}

export interface EvalTraceCall {
  readonly tool: ToolName;
  readonly arguments: Record<string, unknown>;
}

export interface ExpectedResultSkillName {
  readonly call_index: number;
  readonly name: string;
  readonly min_rank: number;
  readonly max_rank: number;
}

export interface ReadSkillReferencePath {
  readonly name_or_id: string;
  readonly relative_path: string;
}

export interface EvalTrace {
  readonly id: string;
  readonly prompt: string;
  readonly mode: TraceMode;
  readonly no_skill_task: boolean;
  readonly mcp_calls: readonly EvalTraceCall[];
  readonly expected_result_skill_names: readonly ExpectedResultSkillName[];
  readonly selected_read_skill_names: readonly string[];
  readonly read_skill_reference_paths: readonly ReadSkillReferencePath[];
}

interface ExecutedTraceCall {
  readonly index: number;
  readonly tool: ToolName;
  readonly arguments: Record<string, unknown>;
  readonly canonical_argument_json: SurfaceReport;
  readonly prompt_visible_result_text: SurfaceReport;
  readonly structured_content_compact_json: SurfaceReport;
  readonly result_skill_names: readonly string[];
  readonly top_payload_fields: readonly PayloadFieldReport[];
  readonly prompt_cost_counts: TextCounts;
  readonly result_kind: "search" | "skill" | "reference";
  readonly selected_body_cost?: SurfaceReport;
}

interface PayloadFieldReport {
  readonly field: string;
  readonly counts: TextCounts;
  readonly share_of_result_text_characters: number;
}

interface ExpectationReport {
  readonly call_index: number;
  readonly name: string;
  readonly min_rank: number;
  readonly max_rank: number;
  readonly actual_rank: number | null;
  readonly ok: boolean;
}

interface TraceReport {
  readonly id: string;
  readonly prompt: string;
  readonly mode: TraceMode;
  readonly no_skill_task: boolean;
  readonly calls: readonly ExecutedTraceCall[];
  readonly expectations: readonly ExpectationReport[];
  readonly discovery_variable_cost: TextCounts;
  readonly discovery_cost_including_static: TextCounts;
  readonly selected_skill_read_prompt_cost: TextCounts;
  readonly selected_skill_body_cost: TextCounts;
  readonly full_cost_including_selected_reads: TextCounts;
  readonly discovery_delta_vs_native_preload: TextCounts;
  readonly full_delta_vs_native_preload: TextCounts;
}

interface BreakEvenReport {
  readonly basis: string;
  readonly static_mcp_cost: TextCounts;
  readonly native_preload_cost: TextCounts;
  readonly static_delta_vs_native_preload: TextCounts;
  readonly average_triggered_discovery_variable_cost: TextCounts;
  readonly average_search_call_prompt_cost: TextCounts;
  readonly average_read_call_prompt_cost: TextCounts;
  readonly triggered_discoveries_before_exceeding_native_after_static: number | null;
  readonly search_calls_before_exceeding_native_after_static: number | null;
  readonly read_calls_before_exceeding_native_after_static: number | null;
}

interface CandidateTraceRankCheck {
  readonly trace_id: string;
  readonly call_index: number;
  readonly name: string;
  readonly min_rank: number;
  readonly max_rank: number;
  readonly actual_rank: number | null;
  readonly ok: boolean;
}

interface CandidateTraceReport {
  readonly trace_id: string;
  readonly discovery_call_argument_characters: TextCounts;
  readonly prompt_visible_result_text_characters: TextCounts;
  readonly total_discovery_cost: TextCounts;
  readonly delta_vs_native_preload: TextCounts;
  readonly validated_projected_response_count: number;
  readonly expected_skill_rank_checks: readonly CandidateTraceRankCheck[];
}

interface CandidateSchemaValidationReport {
  readonly ok: boolean;
  readonly output_schema_name: string;
  readonly validated_projected_response_count: number;
}

interface CandidateContractReport {
  readonly id: string;
  readonly family: string;
  readonly description: string;
  readonly score_variant: CandidateScoreVariant;
  readonly public_contract_weakening: boolean;
  readonly public_contract_note: string;
  readonly manifest_tool_names: readonly string[];
  readonly schema_validation: CandidateSchemaValidationReport;
  readonly mcp_tool_manifest_static_cost: SurfaceReport & { readonly approximation_note: string };
  readonly mcp_static_session_cost: SurfaceReport;
  readonly static_delta_vs_native_preload: TextCounts;
  readonly preserves_static_mcp_advantage: boolean;
  readonly discovery_call_argument_characters: TextCounts;
  readonly prompt_visible_result_text_characters: TextCounts;
  readonly total_discovery_cost: TextCounts;
  readonly delta_vs_native_preload: TextCounts;
  readonly delta_vs_current_rich_baseline: TextCounts;
  readonly expected_skill_rank_checks: readonly CandidateTraceRankCheck[];
  readonly traces: readonly CandidateTraceReport[];
}

export interface SkillRoutingCostEvalReport {
  readonly eval: string;
  readonly root: string;
  readonly trace_fixture: string;
  readonly tokenizer_policy: {
    readonly primary_metrics: readonly string[];
    readonly approx_tokens_4char: string;
    readonly exact_provider_billing_tokens: string;
  };
  readonly corpus: {
    readonly skill_count: number;
    readonly sync_error_count: number;
    readonly duplicate_names: readonly string[];
  };
  readonly native_preload_manifest: string;
  readonly surfaces: {
    readonly native_preload_baseline: SurfaceReport;
    readonly mcp_tool_manifest_static_cost: SurfaceReport & { readonly approximation_note: string };
    readonly skill_router_preload_name_description: SurfaceReport;
    readonly skill_router_full_body_when_triggered: SurfaceReport;
    readonly mcp_static_session_cost: SurfaceReport;
  };
  readonly candidate_contracts: readonly CandidateContractReport[];
  readonly traces: readonly TraceReport[];
  readonly summary: {
    readonly trace_count: number;
    readonly triggered_trace_count: number;
    readonly no_skill_trace_count: number;
    readonly discovery_cheaper_than_native_all_trace_count: number;
    readonly full_read_cheaper_than_native_all_trace_count: number;
    readonly discovery_cheaper_than_native_triggered_trace_count: number;
    readonly full_read_cheaper_than_native_triggered_trace_count: number;
    readonly break_even: BreakEvenReport;
    readonly conclusion: string;
  };
}

export function countText(text: string): TextCounts {
  const characters = [...text].length;
  return {
    bytes: Buffer.byteLength(text, "utf8"),
    characters,
    approx_tokens_4char: Math.ceil(characters / 4)
  };
}

export function renderNativePreloadManifest<T extends { readonly name: string; readonly description: string }>(
  entries: readonly T[]
): string {
  const lines = [...entries]
    .sort((a, b) => a.name.localeCompare(b.name) || a.description.localeCompare(b.description))
    .map((entry) => `${entry.name}: ${entry.description}`);
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

export function toPromptVisibleResultText(result: unknown): string {
  return JSON.stringify(result, null, 2);
}

export function stableStringify(value: unknown): string {
  return `${JSON.stringify(toStableJsonValue(value), null, 2)}\n`;
}

function stableCompactStringify(value: unknown): string {
  return JSON.stringify(toStableJsonValue(value));
}

export function loadTraceFixture(traceFixturePath = defaultTraceFixturePath): readonly EvalTrace[] {
  const raw = JSON.parse(readFileSyncUtf8(traceFixturePath)) as unknown;
  if (!Array.isArray(raw)) {
    throw new Error(`Trace fixture must be an array: ${traceFixturePath}`);
  }
  const traces = raw.map((trace, index) => parseTrace(trace, index));
  const sorted = [...traces].sort((a, b) => a.id.localeCompare(b.id));
  const ids = new Set<string>();
  for (const trace of sorted) {
    if (ids.has(trace.id)) {
      throw new Error(`Duplicate trace id: ${trace.id}`);
    }
    ids.add(trace.id);
    validateTrace(trace);
  }
  return sorted;
}

export async function buildSkillRoutingCostEval(options: {
  readonly root: string;
  readonly traceFixturePath?: string;
}): Promise<SkillRoutingCostEvalReport> {
  const root = path.resolve(options.root);
  const traceFixturePath = path.resolve(options.traceFixturePath ?? defaultTraceFixturePath);
  const traces = loadTraceFixture(traceFixturePath);
  const config = evalConfig(root);
  const sync = normalizeSyncResult(await Effect.runPromise(scanSkillRoots(config)));
  const store = new CatalogStore(config);

  try {
    await Effect.runPromise(store.rebuild(sync));
    const skills = [...(await Effect.runPromise(store.getAllSkills()))].sort(compareSkillsByName);
    const search = new SearchService(config, store);
    const references = new ReferenceService(config, store);
    const nativePreloadManifest = renderNativePreloadManifest(skills);
    const routerSkill = skills.find((skill) => skill.name === "skill-router");
    if (!routerSkill) {
      throw new Error(`Required router skill not found in root: ${root}`);
    }

    const routerBody = await readFile(routerSkill.skillFile, "utf8");
    const nativePreload = surface(
      "native_preload_baseline",
      "Stable native preload manifest containing only each indexed skill name + description.",
      nativePreloadManifest
    );
    const toolManifest = renderMcpToolManifest();
    const mcpToolManifest = {
      ...surface(
        "mcp_tool_manifest_static_cost",
        "Deterministic approximation of prompt-visible Skill Catalog MCP tool names, descriptions, schemas, and annotations.",
        toolManifest
      ),
      approximation_note:
        "The exact client-side MCP manifest exposure is harness-dependent, so this renders the server-registered tool contract deterministically from current Zod schemas."
    };
    const routerPreload = surface(
      "skill_router_preload_name_description",
      "Native preload entry for the router skill only.",
      renderNativePreloadManifest([routerSkill])
    );
    const routerFullBody = surface(
      "skill_router_full_body_when_triggered",
      "Full skill-router/SKILL.md body counted when a trace triggers routing.",
      routerBody
    );
    const staticSessionCost = syntheticSurface(
      "mcp_static_session_cost",
      "Static per-session MCP routing cost: Skill Catalog tool manifest plus router native name + description.",
      sumCounts([mcpToolManifest.counts, routerPreload.counts]),
      [mcpToolManifest.sha256, routerPreload.sha256].join("\n")
    );
    const traceReports: TraceReport[] = [];
    for (const trace of traces) {
      traceReports.push(await executeTrace(trace, search, references, nativePreload.counts, staticSessionCost.counts, routerFullBody));
    }
    const candidateContracts = await buildCandidateContractReports({
      traces,
      search,
      nativePreload,
      routerPreload,
      routerFullBody
    });

    const breakEven = buildBreakEven(nativePreload.counts, staticSessionCost.counts, traceReports);
    const triggeredTraceReports = traceReports.filter((trace) => !trace.no_skill_task);
    const discoveryCheaperAll = traceReports.filter(
      (trace) => trace.discovery_cost_including_static.characters < nativePreload.counts.characters
    ).length;
    const fullCheaperAll = traceReports.filter(
      (trace) => trace.full_cost_including_selected_reads.characters < nativePreload.counts.characters
    ).length;
    const discoveryCheaperTriggered = triggeredTraceReports.filter(
      (trace) => trace.discovery_cost_including_static.characters < nativePreload.counts.characters
    ).length;
    const fullCheaperTriggered = triggeredTraceReports.filter(
      (trace) => trace.full_cost_including_selected_reads.characters < nativePreload.counts.characters
    ).length;

    return {
      eval: "skill-routing-token-cost",
      root,
      trace_fixture: traceFixturePath,
      tokenizer_policy: {
        primary_metrics: ["utf8_bytes", "unicode_characters", "approx_tokens_4char"],
        approx_tokens_4char: "ceil(unicode_characters / 4), deterministic cross-harness approximation",
        exact_provider_billing_tokens:
          "not reported; Codex, Claude Code, OpenCode, and arbitrary model providers do not expose one shared authoritative tokenizer here"
      },
      corpus: {
        skill_count: skills.length,
        sync_error_count: sync.errors.length,
        duplicate_names: sync.duplicateNames
      },
      native_preload_manifest: nativePreloadManifest,
      surfaces: {
        native_preload_baseline: nativePreload,
        mcp_tool_manifest_static_cost: mcpToolManifest,
        skill_router_preload_name_description: routerPreload,
        skill_router_full_body_when_triggered: routerFullBody,
        mcp_static_session_cost: staticSessionCost
      },
      candidate_contracts: candidateContracts,
      traces: traceReports,
      summary: {
        trace_count: traceReports.length,
        triggered_trace_count: triggeredTraceReports.length,
        no_skill_trace_count: traceReports.filter((trace) => trace.no_skill_task).length,
        discovery_cheaper_than_native_all_trace_count: discoveryCheaperAll,
        full_read_cheaper_than_native_all_trace_count: fullCheaperAll,
        discovery_cheaper_than_native_triggered_trace_count: discoveryCheaperTriggered,
        full_read_cheaper_than_native_triggered_trace_count: fullCheaperTriggered,
        break_even: breakEven,
        conclusion: buildConclusion(nativePreload.counts, staticSessionCost.counts, traceReports)
      }
    };
  } finally {
    store.close();
  }
}

export async function writeEvalReports(
  report: SkillRoutingCostEvalReport,
  outDir: string
): Promise<{ readonly jsonPath: string; readonly markdownPath: string }> {
  await mkdir(outDir, { recursive: true });
  const jsonPath = path.join(outDir, reportJsonFileName);
  const markdownPath = path.join(outDir, reportMarkdownFileName);
  await writeFile(jsonPath, stableStringify(report), "utf8");
  await writeFile(markdownPath, renderMarkdownReport(report), "utf8");
  return { jsonPath, markdownPath };
}

async function buildCandidateContractReports(options: {
  readonly traces: readonly EvalTrace[];
  readonly search: SearchService;
  readonly nativePreload: SurfaceReport;
  readonly routerPreload: SurfaceReport;
  readonly routerFullBody: SurfaceReport;
}): Promise<readonly CandidateContractReport[]> {
  const candidateDefinitions = buildCandidateDefinitions();
  const reports: CandidateContractReport[] = [];
  for (const definition of candidateDefinitions) {
    const manifest = renderCandidateMcpToolManifest(definition);
    const mcpToolManifest = {
      ...surface(
        `${definition.id}_mcp_tool_manifest_static_cost`,
        "Deterministic approximation of prompt-visible Skill Catalog MCP tool names, descriptions, schemas, and annotations for this candidate contract.",
        manifest.text
      ),
      approximation_note:
        "The exact client-side MCP manifest exposure is harness-dependent, so this renders the candidate tool contract deterministically from Zod schemas without changing product code."
    };
    const staticSessionCost = syntheticSurface(
      `${definition.id}_mcp_static_session_cost`,
      "Static per-session MCP routing cost for this candidate: candidate tool manifest plus router native name + description.",
      sumCounts([mcpToolManifest.counts, options.routerPreload.counts]),
      [mcpToolManifest.sha256, options.routerPreload.sha256].join("\n")
    );
    const traces = await Promise.all(
      options.traces.map((trace) =>
        executeCandidateTrace(trace, definition, options.search, options.nativePreload.counts, staticSessionCost.counts, options.routerFullBody)
      )
    );
    const triggeredTraces = traces.filter((trace) => !options.traces.find((fixture) => fixture.id === trace.trace_id)?.no_skill_task);
    const argumentCounts = averageCounts(triggeredTraces.map((trace) => trace.discovery_call_argument_characters));
    const resultTextCounts = averageCounts(triggeredTraces.map((trace) => trace.prompt_visible_result_text_characters));
    const totalDiscoveryCost = sumCounts([staticSessionCost.counts, options.routerFullBody.counts, argumentCounts, resultTextCounts]);
    const rankChecks = traces.flatMap((trace) => trace.expected_skill_rank_checks);
    const failedRankChecks = rankChecks.filter((check) => !check.ok);
    if (failedRankChecks.length > 0) {
      throw new Error(
        `Candidate ${definition.id} failed expected skill rank checks: ${failedRankChecks
          .map((check) => `${check.trace_id}:${check.name} rank ${check.actual_rank ?? "missing"} expected ${check.min_rank}-${check.max_rank}`)
          .join("; ")}`
      );
    }
    const outputSchemaName = candidateSearchOutputSchemaName(definition);
    const report: CandidateContractReport = {
      id: definition.id,
      family: definition.family,
      description: definition.description,
      score_variant: definition.scoreVariant,
      public_contract_weakening: definition.publicContractWeakening,
      public_contract_note: definition.publicContractNote,
      manifest_tool_names: manifest.toolNames,
      schema_validation: {
        ok: true,
        output_schema_name: outputSchemaName,
        validated_projected_response_count: traces.reduce((sum, trace) => sum + trace.validated_projected_response_count, 0)
      },
      mcp_tool_manifest_static_cost: mcpToolManifest,
      mcp_static_session_cost: staticSessionCost,
      static_delta_vs_native_preload: diffCounts(staticSessionCost.counts, options.nativePreload.counts),
      preserves_static_mcp_advantage: staticSessionCost.counts.characters < options.nativePreload.counts.characters,
      discovery_call_argument_characters: argumentCounts,
      prompt_visible_result_text_characters: resultTextCounts,
      total_discovery_cost: totalDiscoveryCost,
      delta_vs_native_preload: diffCounts(totalDiscoveryCost, options.nativePreload.counts),
      delta_vs_current_rich_baseline: zeroCounts(),
      expected_skill_rank_checks: rankChecks,
      traces
    };
    reports.push(report);
  }
  const richBaselineCost = reports[0]?.total_discovery_cost ?? zeroCounts();
  return reports.map((report) => ({
    ...report,
    delta_vs_current_rich_baseline: diffCounts(report.total_discovery_cost, richBaselineCost)
  }));
}

interface CandidateDefinition {
  readonly id: string;
  readonly family: string;
  readonly description: string;
  readonly scoreVariant: CandidateScoreVariant;
  readonly publicContractWeakening: boolean;
  readonly publicContractNote: string;
  readonly projection: CandidateResultProjection;
  readonly searchLimit: "trace" | 5;
  readonly toolMode: "current_search" | "same_tool_response_mode" | "additive_lightweight_tool";
  readonly includeScore: boolean;
}

// MEASUREMENT ONLY - NOT PRODUCT CODE.
// These candidate contracts simulate possible MCP shapes for the token-cost eval
// preflight. Do not import them into the runtime MCP server.
function buildCandidateDefinitions(): readonly CandidateDefinition[] {
  return [
    {
      id: "rich_limit_10",
      family: "rich_limit_10",
      description: "Current rich search_skills contract and current trace limits.",
      scoreVariant: "not_applicable",
      publicContractWeakening: false,
      publicContractNote: "Preserves the existing rich search_skills public input and output contract.",
      projection: "rich",
      searchLimit: "trace",
      toolMode: "current_search",
      includeScore: true
    },
    {
      id: "rich_limit_5",
      family: "rich_limit_5",
      description: "Current rich search_skills contract with search trace limits reduced to 5.",
      scoreVariant: "not_applicable",
      publicContractWeakening: false,
      publicContractNote: "Preserves the existing rich search_skills public contract; only the evaluated call limit changes.",
      projection: "rich_limit_5",
      searchLimit: 5,
      toolMode: "current_search",
      includeScore: true
    },
    {
      id: "same_tool_sparse_schema",
      family: "same_tool_sparse_schema",
      description: "Same search_skills tool adds response_mode while preserving the exact rich output schema with sparse compact values.",
      scoreVariant: "not_applicable",
      publicContractWeakening: false,
      publicContractNote: "Adds a response_mode input but keeps the exact rich public output schema.",
      projection: "sparse",
      searchLimit: "trace",
      toolMode: "same_tool_response_mode",
      includeScore: true
    },
    ...(["without_score", "with_score"] as const).map((scoreVariant) => ({
      id: `same_tool_exact_union_${scoreVariant}`,
      family: "same_tool_exact_union",
      description:
        "Same search_skills tool adds response_mode and publishes an exact rich-or-compact output union.",
      scoreVariant,
      publicContractWeakening: false,
      publicContractNote: "Adds a response_mode input and an exact rich-or-compact output union; this expands but does not loosen result objects.",
      projection: "compact" as const,
      searchLimit: "trace" as const,
      toolMode: "same_tool_response_mode" as const,
      includeScore: scoreVariant === "with_score"
    })),
    ...(["without_score", "with_score"] as const).map((scoreVariant) => ({
      id: `same_tool_loose_schema_${scoreVariant}`,
      family: "same_tool_loose_schema",
      description:
        "Same search_skills tool adds response_mode while weakening result items to common fields plus open object passthrough.",
      scoreVariant,
      publicContractWeakening: true,
      publicContractNote:
        "Public-contract weakening candidate: result items become common fields plus open object passthrough, so clients lose the exact rich result guarantee.",
      projection: "compact" as const,
      searchLimit: "trace" as const,
      toolMode: "same_tool_response_mode" as const,
      includeScore: scoreVariant === "with_score"
    })),
    ...(["without_score", "with_score"] as const).map((scoreVariant) => ({
      id: `additive_lightweight_tool_${scoreVariant}`,
      family: "additive_lightweight_tool",
      description:
        "Keep rich search_skills unchanged and add discover_skills_compact for low-cost routing shortlists.",
      scoreVariant,
      publicContractWeakening: false,
      publicContractNote: "Preserves existing rich search_skills and adds a separate compact discovery tool.",
      projection: "compact" as const,
      searchLimit: "trace" as const,
      toolMode: "additive_lightweight_tool" as const,
      includeScore: scoreVariant === "with_score"
    }))
  ];
}

async function executeCandidateTrace(
  trace: EvalTrace,
  definition: CandidateDefinition,
  search: SearchService,
  nativePreloadCost: TextCounts,
  staticSessionCost: TextCounts,
  routerFullBody: SurfaceReport
): Promise<CandidateTraceReport> {
  const searchCallResults = new Map<number, readonly string[]>();
  const argumentCounts: TextCounts[] = [];
  const resultTextCounts: TextCounts[] = [];
  let validatedProjectedResponseCount = 0;
  for (const [index, call] of trace.mcp_calls.entries()) {
    if (call.tool !== "search_skills") {
      continue;
    }
    const originalArgs = call.arguments as { query: string; limit: number; include_incomplete_metadata: boolean };
    const limit = definition.searchLimit === "trace" ? originalArgs.limit : definition.searchLimit;
    const result = await Effect.runPromise(
      search.search({
        query: originalArgs.query,
        limit,
        includeIncompleteMetadata: originalArgs.include_incomplete_metadata
      })
    );
    const projected = projectSearchResult(result, definition);
    validateProjectedCandidateResponse(definition, trace.id, index, projected);
    validatedProjectedResponseCount += 1;
    const candidateArguments = candidateCallArguments(originalArgs, definition, limit);
    argumentCounts.push(countText(stableCompactStringify(candidateArguments)));
    resultTextCounts.push(countText(toPromptVisibleResultText(projected)));
    searchCallResults.set(index, result.results.map((item) => item.name));
  }
  const routerCost = trace.no_skill_task ? zeroCounts() : routerFullBody.counts;
  const discoveryArguments = sumCounts(argumentCounts);
  const discoveryResultText = sumCounts(resultTextCounts);
  const totalDiscoveryCost = sumCounts([staticSessionCost, routerCost, discoveryArguments, discoveryResultText]);
  const expectedSkillRankChecks = trace.expected_result_skill_names.map((expected) => {
    const call = trace.mcp_calls[expected.call_index];
    const resultSkillNames =
      call?.tool === "search_skills"
        ? searchCallResults.get(expected.call_index) ?? []
        : call?.tool === "read_skill" || call?.tool === "read_skill_reference"
          ? [String(call.arguments.name_or_id)]
          : [];
    const actualRank = resultSkillNames.indexOf(expected.name) + 1;
    const maxRank = definition.projection === "rich_limit_5" && call?.tool === "search_skills"
      ? Math.min(expected.max_rank, 5)
      : expected.max_rank;
    return {
      trace_id: trace.id,
      call_index: expected.call_index,
      name: expected.name,
      min_rank: expected.min_rank,
      max_rank: maxRank,
      actual_rank: actualRank > 0 ? actualRank : null,
      ok: actualRank >= expected.min_rank && actualRank <= maxRank
    };
  });
  return {
    trace_id: trace.id,
    discovery_call_argument_characters: discoveryArguments,
    prompt_visible_result_text_characters: discoveryResultText,
    total_discovery_cost: totalDiscoveryCost,
    delta_vs_native_preload: diffCounts(totalDiscoveryCost, nativePreloadCost),
    validated_projected_response_count: validatedProjectedResponseCount,
    expected_skill_rank_checks: expectedSkillRankChecks
  };
}

function validateProjectedCandidateResponse(
  definition: CandidateDefinition,
  traceId: string,
  callIndex: number,
  projected: unknown
): void {
  const schema = candidateSearchOutputSchema(definition);
  const parsed = schema.safeParse(projected);
  if (!parsed.success) {
    throw new Error(
      `Candidate ${definition.id} projected response failed ${candidateSearchOutputSchemaName(
        definition
      )} validation for trace ${traceId} call ${callIndex}: ${z.prettifyError(parsed.error)}`
    );
  }
}

export function validateProjectedCandidateResponseForTest(
  candidateId: string,
  projected: unknown,
  traceId: string,
  callIndex: number
): void {
  validateProjectedCandidateResponse(findCandidateDefinition(candidateId), traceId, callIndex, projected);
}

export function renderCandidateMcpToolManifestForTest(candidateId: string): {
  readonly text: string;
  readonly toolNames: readonly string[];
} {
  return renderCandidateMcpToolManifest(findCandidateDefinition(candidateId));
}

function findCandidateDefinition(candidateId: string): CandidateDefinition {
  const definition = buildCandidateDefinitions().find((candidate) => candidate.id === candidateId);
  if (!definition) {
    throw new Error(`Unknown candidate contract: ${candidateId}`);
  }
  return definition;
}

function candidateCallArguments(
  originalArgs: { readonly query: string; readonly limit: number; readonly include_incomplete_metadata: boolean },
  definition: CandidateDefinition,
  limit: number
): Record<string, unknown> {
  if (definition.toolMode === "additive_lightweight_tool") {
    return {
      query: originalArgs.query,
      limit
    };
  }
  if (definition.toolMode === "same_tool_response_mode") {
    return {
      query: originalArgs.query,
      limit,
      include_incomplete_metadata: originalArgs.include_incomplete_metadata,
      response_mode: "compact"
    };
  }
  return {
    query: originalArgs.query,
    limit,
    include_incomplete_metadata: originalArgs.include_incomplete_metadata
  };
}

function projectSearchResult(result: SearchResponse, definition: CandidateDefinition): SearchResponse | Record<string, unknown> {
  if (definition.projection === "rich" || definition.projection === "rich_limit_5") {
    return result;
  }
  if (definition.projection === "sparse") {
    return {
      query: result.query,
      results: result.results.map((item) => ({
        ...item,
        source: null,
        triggers: [],
        when_to_use: [],
        when_not_to_use: [],
        warnings: item.warnings.map((warning) => ({ code: warning.code, message: "" })),
        why_match: item.matched_fields.length > 0 ? `Matched ${item.matched_fields.join(", ")}.` : ""
      }))
    };
  }
  return {
    query: result.query,
    results: result.results.map((item) => compactSearchResultItem(item, definition.includeScore))
  };
}

function compactSearchResultItem(item: SearchResultItem, includeScore: boolean): Record<string, unknown> {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    category: item.category,
    trust_status: item.trust_status,
    matched_backends: item.matched_backends,
    matched_fields: item.matched_fields,
    warning_codes: item.warnings.map((warning) => warning.code),
    ...(includeScore ? { score: item.score } : {})
  };
}

async function executeTrace(
  trace: EvalTrace,
  search: SearchService,
  references: ReferenceService,
  nativePreloadCost: TextCounts,
  staticSessionCost: TextCounts,
  routerFullBody: SurfaceReport
): Promise<TraceReport> {
  const calls: ExecutedTraceCall[] = [];
  for (const [index, call] of trace.mcp_calls.entries()) {
    calls.push(await executeCall(index, call, search, references));
  }
  const expectations = trace.expected_result_skill_names.map((expected) => {
    const call = calls[expected.call_index];
    const actualRank = call ? call.result_skill_names.indexOf(expected.name) + 1 : 0;
    return {
      call_index: expected.call_index,
      name: expected.name,
      min_rank: expected.min_rank,
      max_rank: expected.max_rank,
      actual_rank: actualRank > 0 ? actualRank : null,
      ok: actualRank >= expected.min_rank && actualRank <= expected.max_rank
    };
  });
  const failed = expectations.filter((expectation) => !expectation.ok);
  if (failed.length > 0) {
    throw new Error(
      `Trace ${trace.id} failed expectations: ${failed
        .map((failure) => `${failure.name} at call ${failure.call_index} rank ${failure.actual_rank ?? "missing"}`)
        .join("; ")}`
    );
  }

  const discoveryCallCosts = calls
    .filter((call) => call.result_kind === "search")
    .map((call) => call.prompt_cost_counts);
  const selectedReadCallCosts = calls
    .filter((call) => call.result_kind === "skill" || call.result_kind === "reference")
    .map((call) => call.prompt_cost_counts);
  const selectedBodyCosts = calls.flatMap((call) => (call.selected_body_cost ? [call.selected_body_cost.counts] : []));
  const routerCost = trace.no_skill_task ? zeroCounts() : routerFullBody.counts;
  const discoveryVariableCost = sumCounts([routerCost, ...discoveryCallCosts]);
  const discoveryCostIncludingStatic = sumCounts([staticSessionCost, discoveryVariableCost]);
  const selectedSkillReadPromptCost = sumCounts(selectedReadCallCosts);
  const selectedSkillBodyCost = sumCounts(selectedBodyCosts);
  const fullCostIncludingSelectedReads = sumCounts([discoveryCostIncludingStatic, selectedSkillReadPromptCost]);

  return {
    id: trace.id,
    prompt: trace.prompt,
    mode: trace.mode,
    no_skill_task: trace.no_skill_task,
    calls,
    expectations,
    discovery_variable_cost: discoveryVariableCost,
    discovery_cost_including_static: discoveryCostIncludingStatic,
    selected_skill_read_prompt_cost: selectedSkillReadPromptCost,
    selected_skill_body_cost: selectedSkillBodyCost,
    full_cost_including_selected_reads: fullCostIncludingSelectedReads,
    discovery_delta_vs_native_preload: diffCounts(discoveryCostIncludingStatic, nativePreloadCost),
    full_delta_vs_native_preload: diffCounts(fullCostIncludingSelectedReads, nativePreloadCost)
  };
}

async function executeCall(
  index: number,
  call: EvalTraceCall,
  search: SearchService,
  references: ReferenceService
): Promise<ExecutedTraceCall> {
  const argumentJson = stableCompactStringify(call.arguments);
  const argumentSurface = surface(`trace_call_${index}_mcp_tool_call_args`, "Canonical MCP tool-call argument JSON.", argumentJson);

  if (call.tool === "search_skills") {
    const args = call.arguments as { query: string; limit: number; include_incomplete_metadata: boolean };
    const result = await Effect.runPromise(
      search.search({
        query: args.query,
        limit: args.limit,
        includeIncompleteMetadata: args.include_incomplete_metadata
      })
    );
    return callReport(index, call, result, "search", argumentSurface, result.results.map((item) => item.name));
  }

  if (call.tool === "read_skill") {
    const args = call.arguments as { name_or_id: string };
    const result = await Effect.runPromise(references.readSkill(args.name_or_id));
    const report = callReport(index, call, result, "skill", argumentSurface, [result.name]);
    return {
      ...report,
      selected_body_cost: surface(
        `trace_call_${index}_selected_skill_body`,
        `Raw selected SKILL.md body for ${result.name}; shared by native and MCP strategies after selection.`,
        result.content
      )
    };
  }

  const args = call.arguments as { name_or_id: string; relative_path: string };
  const result = await Effect.runPromise(references.readReference(args.name_or_id, args.relative_path));
  const report = callReport(index, call, result, "reference", argumentSurface, [result.name]);
  return {
    ...report,
    selected_body_cost: surface(
      `trace_call_${index}_selected_reference_body`,
      `Raw selected reference content for ${result.name}/${result.relative_path}; shared after explicit reference selection.`,
      result.content ?? ""
    )
  };
}

function callReport(
  index: number,
  call: EvalTraceCall,
  result: SearchResponse | ReadSkillResponse | ReadReferenceResponse,
  resultKind: "search" | "skill" | "reference",
  argumentSurface: SurfaceReport,
  resultSkillNames: readonly string[]
): ExecutedTraceCall {
  const promptText = toPromptVisibleResultText(result);
  const compactJson = JSON.stringify(result);
  const resultTextSurface = surface(
    `trace_call_${index}_mcp_tool_result_text`,
    "Prompt-visible MCP result text matching structuredResult() content[0].text = JSON.stringify(result, null, 2).",
    promptText
  );
  const compactSurface = surface(
    `trace_call_${index}_mcp_structured_content_compact`,
    "Secondary diagnostic compact JSON for structuredContent; not counted as primary prompt-visible result text.",
    compactJson
  );
  return {
    index,
    tool: call.tool,
    arguments: call.arguments,
    canonical_argument_json: argumentSurface,
    prompt_visible_result_text: resultTextSurface,
    structured_content_compact_json: compactSurface,
    result_skill_names: resultSkillNames,
    top_payload_fields: resultKind === "search" ? topSearchPayloadFields(result as SearchResponse, resultTextSurface.counts) : [],
    prompt_cost_counts: sumCounts([argumentSurface.counts, resultTextSurface.counts]),
    result_kind: resultKind
  };
}

function topSearchPayloadFields(result: SearchResponse, resultTextCost: TextCounts): readonly PayloadFieldReport[] {
  const byField = new Map<string, TextCounts[]>();
  addPayloadField(byField, "query", result.query);
  for (const item of result.results) {
    for (const [field, value] of Object.entries(item)) {
      addPayloadField(byField, field, value);
    }
  }
  return [...byField.entries()]
    .map(([field, counts]) => {
      const total = sumCounts(counts);
      return {
        field,
        counts: total,
        share_of_result_text_characters:
          resultTextCost.characters === 0 ? 0 : Number(((total.characters / resultTextCost.characters) * 100).toFixed(1))
      };
    })
    .sort((a, b) => b.counts.characters - a.counts.characters || a.field.localeCompare(b.field))
    .slice(0, 8);
}

function addPayloadField(byField: Map<string, TextCounts[]>, field: string, value: unknown): void {
  const current = byField.get(field) ?? [];
  current.push(countText(stableCompactStringify({ [field]: value })));
  byField.set(field, current);
}

function buildBreakEven(
  nativePreloadCost: TextCounts,
  staticSessionCost: TextCounts,
  traces: readonly TraceReport[]
): BreakEvenReport {
  const triggered = traces.filter((trace) => !trace.no_skill_task);
  const searchCalls = traces.flatMap((trace) => trace.calls.filter((call) => call.result_kind === "search"));
  const readCalls = traces.flatMap((trace) =>
    trace.calls.filter((call) => call.result_kind === "skill" || call.result_kind === "reference")
  );
  const averageTriggeredDiscovery = averageCounts(triggered.map((trace) => trace.discovery_variable_cost));
  const averageSearchCall = averageCounts(searchCalls.map((call) => call.prompt_cost_counts));
  const averageReadCall = averageCounts(readCalls.map((call) => call.prompt_cost_counts));
  return {
    basis:
      "Counts use characters as the primary break-even dimension. Static MCP cost is paid once per independent session; variable costs are averaged over benchmark traces.",
    static_mcp_cost: staticSessionCost,
    native_preload_cost: nativePreloadCost,
    static_delta_vs_native_preload: diffCounts(staticSessionCost, nativePreloadCost),
    average_triggered_discovery_variable_cost: averageTriggeredDiscovery,
    average_search_call_prompt_cost: averageSearchCall,
    average_read_call_prompt_cost: averageReadCall,
    triggered_discoveries_before_exceeding_native_after_static: breakEvenCount(
      nativePreloadCost,
      staticSessionCost,
      averageTriggeredDiscovery
    ),
    search_calls_before_exceeding_native_after_static: breakEvenCount(nativePreloadCost, staticSessionCost, averageSearchCall),
    read_calls_before_exceeding_native_after_static: breakEvenCount(nativePreloadCost, staticSessionCost, averageReadCall)
  };
}

function buildConclusion(
  nativePreloadCost: TextCounts,
  staticSessionCost: TextCounts,
  traces: readonly TraceReport[]
): string {
  const triggered = traces.filter((trace) => !trace.no_skill_task);
  const cheaperDiscovery = triggered.filter(
    (trace) => trace.discovery_cost_including_static.characters < nativePreloadCost.characters
  ).length;
  const staticDelta = staticSessionCost.characters - nativePreloadCost.characters;
  if (staticDelta >= 0) {
    return `For the current ${nativePreloadCost.characters}-character native preload baseline, static MCP routing exposure alone is ${staticDelta} characters more expensive before any router body or MCP calls. The current MCP payload shape is therefore not cheaper for this catalog under the deterministic benchmark.`;
  }
  if (cheaperDiscovery === triggered.length) {
    return `Static MCP routing exposure is ${Math.abs(staticDelta)} characters cheaper than native preload, and every triggered benchmark trace remains below native preload on discovery cost. Full selected skill reads are reported separately because both strategies need those bodies after selection.`;
  }
  return `Static MCP routing exposure is ${Math.abs(staticDelta)} characters cheaper than native preload, but only ${cheaperDiscovery} of ${triggered.length} triggered benchmark traces remain cheaper once router body and prompt-visible MCP search results are counted. Current rich search payloads dominate the routing cost.`;
}

function renderMcpToolManifest(): string {
  return stableStringify(currentMcpTools());
}

function renderCandidateMcpToolManifest(definition: CandidateDefinition): {
  readonly text: string;
  readonly toolNames: readonly string[];
} {
  const tools =
    definition.toolMode === "additive_lightweight_tool"
      ? [...currentMcpTools(), discoverSkillsCompactTool(definition.includeScore)]
      : [
          searchSkillsTool({
            inputSchema: definition.toolMode === "same_tool_response_mode" ? responseModeSearchInputSchema() : z.object(SearchInputSchema),
            outputSchemaName: candidateSearchOutputSchemaName(definition),
            outputSchema: candidateSearchOutputSchema(definition)
          }),
          ...nonSearchMcpTools()
        ];
  return {
    text: stableStringify(tools),
    toolNames: tools.map((tool) => tool.name)
  };
}

function currentMcpTools(): readonly ToolManifestEntry[] {
  return [
    searchSkillsTool({
      inputSchema: z.object(SearchInputSchema),
      outputSchemaName: "SearchOutputSchema",
      outputSchema: SearchOutputSchema
    }),
    ...nonSearchMcpTools()
  ];
}

function nonSearchMcpTools(): readonly ToolManifestEntry[] {
  return [
    {
      name: "read_skill",
      title: "Read Skill",
      description: "Read one selected skill's SKILL.md file.",
      input_schema: z.toJSONSchema(z.object(ReadSkillInputSchema)),
      output_schema_name: "ReadSkillOutputSchema",
      output_schema: z.toJSONSchema(ReadSkillOutputSchema),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    {
      name: "read_skill_reference",
      title: "Read Skill Reference",
      description: "Read one explicit reference file under a selected skill directory.",
      input_schema: z.toJSONSchema(z.object(ReadReferenceInputSchema)),
      output_schema_name: "ReadReferenceOutputSchema",
      output_schema: z.toJSONSchema(ReadReferenceOutputSchema),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    {
      name: "skill_catalog_status",
      title: "Skill Catalog Status",
      description: "Report skill catalog root, sync, metadata, and search backend status.",
      input_schema: null,
      output_schema_name: "StatusOutputSchema",
      output_schema: z.toJSONSchema(StatusOutputSchema),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    }
  ];
}

interface ToolManifestEntry {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly input_schema: unknown;
  readonly output_schema_name: string;
  readonly output_schema: unknown;
  readonly annotations: {
    readonly readOnlyHint: true;
    readonly openWorldHint: false;
  };
}

function searchSkillsTool(options: {
  readonly inputSchema: z.ZodType;
  readonly outputSchemaName: string;
  readonly outputSchema: z.ZodType;
}): ToolManifestEntry {
  return {
    name: "search_skills",
    title: "Search Skills",
    description: "Search the read-only skill catalog and return selection metadata.",
    input_schema: z.toJSONSchema(options.inputSchema),
    output_schema_name: options.outputSchemaName,
    output_schema: z.toJSONSchema(options.outputSchema),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    }
  };
}

function discoverSkillsCompactTool(includeScore: boolean): ToolManifestEntry {
  return {
    name: "discover_skills_compact",
    title: "Discover Skills Compact",
    description: "Return a compact shortlist of catalog skills for low-cost routing.",
    input_schema: z.toJSONSchema(
      z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).optional()
      })
    ),
    output_schema_name: includeScore ? "CompactSearchOutputWithScoreSchema" : "CompactSearchOutputWithoutScoreSchema",
    output_schema: z.toJSONSchema(compactSearchOutputSchema(includeScore)),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    }
  };
}

function responseModeSearchInputSchema(): z.ZodType {
  return z.object({
    ...SearchInputSchema,
    response_mode: z.enum(["rich", "compact"]).default("rich").optional()
  });
}

function candidateSearchOutputSchemaName(definition: CandidateDefinition): string {
  if (definition.toolMode === "additive_lightweight_tool") {
    return definition.includeScore ? "CompactSearchOutputWithScoreSchema" : "CompactSearchOutputWithoutScoreSchema";
  }
  if (definition.family === "same_tool_exact_union") {
    return definition.includeScore ? "RichOrCompactSearchOutputWithScoreSchema" : "RichOrCompactSearchOutputWithoutScoreSchema";
  }
  if (definition.family === "same_tool_loose_schema") {
    return definition.includeScore ? "LooseSearchOutputWithScoreSchema" : "LooseSearchOutputWithoutScoreSchema";
  }
  return "SearchOutputSchema";
}

// MEASUREMENT ONLY - NOT PRODUCT CODE.
// This schema builder mirrors simulated candidate payloads for eval accounting;
// runtime MCP schemas live in src/mcp/schemas.ts.
function candidateSearchOutputSchema(definition: CandidateDefinition): z.ZodType {
  if (definition.toolMode === "additive_lightweight_tool") {
    return compactSearchOutputSchema(definition.includeScore);
  }
  if (definition.family === "same_tool_exact_union") {
    return z.union([SearchOutputSchema, compactSearchOutputSchema(definition.includeScore)]);
  }
  if (definition.family === "same_tool_loose_schema") {
    return looseSearchOutputSchema(definition.includeScore);
  }
  return SearchOutputSchema;
}

function compactSearchOutputSchema(includeScore: boolean): z.ZodType {
  const compactItem = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    category: z.string().nullable(),
    trust_status: z.enum(["trusted", "review_required", "blocked"]),
    matched_backends: z.array(z.string()),
    matched_fields: z.array(z.string()),
    warning_codes: z.array(z.string()),
    ...(includeScore ? { score: z.number() } : {})
  });
  return z.object({
    query: z.string(),
    results: z.array(compactItem)
  });
}

function looseSearchOutputSchema(includeScore: boolean): z.ZodType {
  const commonItem = z
    .object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      category: z.string().nullable(),
      trust_status: z.enum(["trusted", "review_required", "blocked"]),
      matched_backends: z.array(z.string()),
      matched_fields: z.array(z.string()),
      warning_codes: z.array(z.string()).optional(),
      ...(includeScore ? { score: z.number().optional() } : {})
    })
    .catchall(z.unknown());
  return z.object({
    query: z.string(),
    results: z.array(commonItem)
  });
}

function renderMarkdownReport(report: SkillRoutingCostEvalReport): string {
  const lines: string[] = [];
  lines.push("# Skill Routing Token Cost Eval");
  lines.push("");
  lines.push(report.summary.conclusion);
  lines.push("");
  lines.push("## Token Policy");
  lines.push("");
  lines.push("- Primary metrics: UTF-8 bytes, Unicode characters, and `approx_tokens_4char`.");
  lines.push("- `approx_tokens_4char = ceil(characters / 4)`; this is a deterministic proxy, not provider billing.");
  lines.push("- Exact provider billing tokens are not reported.");
  lines.push("");
  lines.push("## Corpus");
  lines.push("");
  lines.push(`- Root: \`${report.root}\``);
  lines.push(`- Indexed skills: ${report.corpus.skill_count}`);
  lines.push(`- Sync errors: ${report.corpus.sync_error_count}`);
  lines.push(`- Duplicate names: ${report.corpus.duplicate_names.length}`);
  lines.push("");
  lines.push("## Summary Counts");
  lines.push("");
  lines.push(`- Triggered traces: ${report.summary.triggered_trace_count}`);
  lines.push(`- No-skill traces: ${report.summary.no_skill_trace_count}`);
  lines.push(
    `- Triggered discovery cheaper than native preload: ${report.summary.discovery_cheaper_than_native_triggered_trace_count}/${report.summary.triggered_trace_count}`
  );
  lines.push(
    `- Triggered full-read cheaper than native preload: ${report.summary.full_read_cheaper_than_native_triggered_trace_count}/${report.summary.triggered_trace_count}`
  );
  lines.push(
    `- All-trace discovery cheaper than native preload, including no-skill traces: ${report.summary.discovery_cheaper_than_native_all_trace_count}/${report.summary.trace_count}`
  );
  lines.push(
    `- All-trace full-read cheaper than native preload, including no-skill traces: ${report.summary.full_read_cheaper_than_native_all_trace_count}/${report.summary.trace_count}`
  );
  lines.push("");
  lines.push("## Static Surfaces");
  lines.push("");
  lines.push("| Surface | Bytes | Characters | Approx Tokens |");
  lines.push("|---|---:|---:|---:|");
  for (const surfaceReport of [
    report.surfaces.native_preload_baseline,
    report.surfaces.mcp_tool_manifest_static_cost,
    report.surfaces.skill_router_preload_name_description,
    report.surfaces.skill_router_full_body_when_triggered,
    report.surfaces.mcp_static_session_cost
  ]) {
    lines.push(formatSurfaceRow(surfaceReport.id, surfaceReport.counts));
  }
  lines.push("");
  lines.push(
    `MCP manifest note: ${report.surfaces.mcp_tool_manifest_static_cost.approximation_note}`
  );
  lines.push("");
  lines.push("## Compact Discovery Candidate Contracts");
  lines.push("");
  lines.push(
    "These are measurement-only candidate contracts. They do not select or implement a final MCP API contract."
  );
  lines.push("");
  lines.push(
    "| Candidate | Public Contract | Schema Validation | Tools | Static Chars | Static Delta | Preserves Static Advantage | Avg Args Chars | Avg Result Chars | Total Triggered Chars | Delta vs Native | Delta vs Rich | Rank Checks |"
  );
  lines.push("|---|---|---|---|---:|---:|---|---:|---:|---:|---:|---:|---|");
  for (const candidate of report.candidate_contracts) {
    const okChecks = candidate.expected_skill_rank_checks.filter((check) => check.ok).length;
    lines.push(
      `| ${candidate.id} | ${
        candidate.public_contract_weakening ? `WEAKENING: ${candidate.public_contract_note}` : candidate.public_contract_note
      } | ${candidate.schema_validation.ok ? "ok" : "failed"} (${candidate.schema_validation.output_schema_name}, ${
        candidate.schema_validation.validated_projected_response_count
      } responses) | ${candidate.manifest_tool_names.join(", ")} | ${
        candidate.mcp_static_session_cost.counts.characters
      } | ${formatSigned(
        candidate.static_delta_vs_native_preload.characters
      )} | ${candidate.preserves_static_mcp_advantage ? "yes" : "no"} | ${
        candidate.discovery_call_argument_characters.characters
      } | ${candidate.prompt_visible_result_text_characters.characters} | ${
        candidate.total_discovery_cost.characters
      } | ${formatSigned(candidate.delta_vs_native_preload.characters)} | ${formatSigned(
        candidate.delta_vs_current_rich_baseline.characters
      )} | ${okChecks}/${candidate.expected_skill_rank_checks.length} |`
    );
  }
  lines.push("");
  lines.push(
    "Total triggered chars = static session exposure + router body + average triggered discovery call args + average triggered prompt-visible discovery result text."
  );
  lines.push("");
  lines.push("### Candidate Rank Checks");
  lines.push("");
  lines.push("| Candidate | Trace | Skill | Rank | Expected | OK |");
  lines.push("|---|---|---|---:|---|---|");
  for (const candidate of report.candidate_contracts) {
    for (const check of candidate.expected_skill_rank_checks) {
      lines.push(
        `| ${candidate.id} | ${check.trace_id} | ${check.name} | ${check.actual_rank ?? "missing"} | ${check.min_rank}-${check.max_rank} | ${
          check.ok ? "yes" : "no"
        } |`
      );
    }
  }
  lines.push("");
  lines.push("## Trace Costs");
  lines.push("");
  lines.push(
    "| Trace | Mode | Discovery Chars | Discovery Delta | Selected Read Chars | Full Chars | Full Delta |"
  );
  lines.push("|---|---|---:|---:|---:|---:|---:|");
  for (const trace of report.traces) {
    lines.push(
      `| ${trace.id} | ${trace.mode} | ${trace.discovery_cost_including_static.characters} | ${formatSigned(
        trace.discovery_delta_vs_native_preload.characters
      )} | ${trace.selected_skill_read_prompt_cost.characters} | ${
        trace.full_cost_including_selected_reads.characters
      } | ${formatSigned(trace.full_delta_vs_native_preload.characters)} |`
    );
  }
  lines.push("");
  lines.push("## Per-Trace MCP Calls");
  for (const trace of report.traces) {
    lines.push("");
    lines.push(`### ${trace.id}`);
    if (trace.calls.length === 0) {
      lines.push("");
      lines.push("No MCP calls; router full body is not triggered.");
      continue;
    }
    lines.push("");
    lines.push("| Call | Args Chars | Result Text Chars | Compact JSON Chars | Result Skills |");
    lines.push("|---|---:|---:|---:|---|");
    for (const call of trace.calls) {
      lines.push(
        `| ${call.index}: ${call.tool} | ${call.canonical_argument_json.counts.characters} | ${call.prompt_visible_result_text.counts.characters} | ${call.structured_content_compact_json.counts.characters} | ${call.result_skill_names.join(", ")} |`
      );
      if (call.top_payload_fields.length > 0) {
        lines.push("");
        lines.push("Top search payload fields:");
        lines.push("");
        lines.push("| Field | Characters | Share |");
        lines.push("|---|---:|---:|");
        for (const field of call.top_payload_fields.slice(0, 5)) {
          lines.push(
            `| ${field.field} | ${field.counts.characters} | ${field.share_of_result_text_characters.toFixed(1)}% |`
          );
        }
        lines.push("");
      }
    }
  }
  lines.push("");
  lines.push("## Break-Even");
  lines.push("");
  lines.push(`- ${report.summary.break_even.basis}`);
  lines.push(
    `- Triggered discoveries before exceeding native after static cost: ${formatBreakEven(
      report.summary.break_even.triggered_discoveries_before_exceeding_native_after_static
    )}`
  );
  lines.push(
    `- Search calls before exceeding native after static cost: ${formatBreakEven(
      report.summary.break_even.search_calls_before_exceeding_native_after_static
    )}`
  );
  lines.push(
    `- Read calls before exceeding native after static cost: ${formatBreakEven(
      report.summary.break_even.read_calls_before_exceeding_native_after_static
    )}`
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function evalConfig(root: string): AppConfig {
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
    roots: [{ name: "canonical-skills", path: root, defaultTrustStatus: "trusted" }],
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

function normalizeSyncResult(sync: SyncResult): SyncResult {
  return {
    skills: [...sync.skills].sort(compareSkillsByName),
    errors: [...sync.errors].sort(
      (a, b) => a.sourceRoot.localeCompare(b.sourceRoot) || a.path.localeCompare(b.path) || a.code.localeCompare(b.code)
    ),
    duplicateNames: [...sync.duplicateNames].sort()
  };
}

function compareSkillsByName(a: SkillRecord, b: SkillRecord): number {
  return a.name.localeCompare(b.name) || a.sourceRoot.localeCompare(b.sourceRoot) || a.relativePath.localeCompare(b.relativePath);
}

function surface(id: string, description: string, text: string): SurfaceReport {
  return {
    id,
    description,
    counts: countText(text),
    sha256: sha256(text)
  };
}

function syntheticSurface(id: string, description: string, counts: TextCounts, hashInput: string): SurfaceReport {
  return {
    id,
    description,
    counts,
    sha256: sha256(hashInput)
  };
}

function sumCounts(counts: readonly TextCounts[]): TextCounts {
  const bytes = counts.reduce((sum, count) => sum + count.bytes, 0);
  const characters = counts.reduce((sum, count) => sum + count.characters, 0);
  return {
    bytes,
    characters,
    approx_tokens_4char: Math.ceil(characters / 4)
  };
}

function averageCounts(counts: readonly TextCounts[]): TextCounts {
  if (counts.length === 0) {
    return zeroCounts();
  }
  const total = sumCounts(counts);
  const bytes = Math.round(total.bytes / counts.length);
  const characters = Math.round(total.characters / counts.length);
  return {
    bytes,
    characters,
    approx_tokens_4char: Math.ceil(characters / 4)
  };
}

function diffCounts(left: TextCounts, right: TextCounts): TextCounts {
  const characters = left.characters - right.characters;
  return {
    bytes: left.bytes - right.bytes,
    characters,
    approx_tokens_4char: Math.ceil(characters / 4)
  };
}

function zeroCounts(): TextCounts {
  return {
    bytes: 0,
    characters: 0,
    approx_tokens_4char: 0
  };
}

function breakEvenCount(nativeCost: TextCounts, staticCost: TextCounts, variableCost: TextCounts): number | null {
  const headroom = nativeCost.characters - staticCost.characters;
  if (headroom < 0) {
    return 0;
  }
  if (variableCost.characters === 0) {
    return null;
  }
  return Math.floor(headroom / variableCost.characters);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function toStableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(toStableJsonValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, toStableJsonValue(child)])
  );
}

function parseTrace(value: unknown, index: number): EvalTrace {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Trace at index ${index} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const trace: EvalTrace = {
    id: requiredString(record.id, `trace[${index}].id`),
    prompt: requiredString(record.prompt, `trace[${index}].prompt`),
    mode: parseMode(record.mode, `trace[${index}].mode`),
    no_skill_task: requiredBoolean(record.no_skill_task, `trace[${index}].no_skill_task`),
    mcp_calls: requiredArray(record.mcp_calls, `trace[${index}].mcp_calls`).map(parseCall),
    expected_result_skill_names: requiredArray(
      record.expected_result_skill_names,
      `trace[${index}].expected_result_skill_names`
    ).map(parseExpectedResult),
    selected_read_skill_names: requiredArray(
      record.selected_read_skill_names,
      `trace[${index}].selected_read_skill_names`
    ).map((entry, entryIndex) => requiredString(entry, `trace[${index}].selected_read_skill_names[${entryIndex}]`)),
    read_skill_reference_paths: requiredArray(
      record.read_skill_reference_paths,
      `trace[${index}].read_skill_reference_paths`
    ).map(parseReferencePath)
  };
  return trace;
}

function parseCall(value: unknown, index: number): EvalTraceCall {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`mcp_calls[${index}] must be an object`);
  }
  const record = value as Record<string, unknown>;
  const tool = requiredString(record.tool, `mcp_calls[${index}].tool`);
  if (tool !== "search_skills" && tool !== "read_skill" && tool !== "read_skill_reference") {
    throw new Error(`Unsupported tool in trace fixture: ${tool}`);
  }
  if (!record.arguments || typeof record.arguments !== "object" || Array.isArray(record.arguments)) {
    throw new Error(`mcp_calls[${index}].arguments must be an object`);
  }
  return {
    tool,
    arguments: record.arguments as Record<string, unknown>
  };
}

function parseExpectedResult(value: unknown, index: number): ExpectedResultSkillName {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected_result_skill_names[${index}] must be an object`);
  }
  const record = value as Record<string, unknown>;
  return {
    call_index: requiredInteger(record.call_index, `expected_result_skill_names[${index}].call_index`),
    name: requiredString(record.name, `expected_result_skill_names[${index}].name`),
    min_rank: requiredInteger(record.min_rank, `expected_result_skill_names[${index}].min_rank`),
    max_rank: requiredInteger(record.max_rank, `expected_result_skill_names[${index}].max_rank`)
  };
}

function parseReferencePath(value: unknown, index: number): ReadSkillReferencePath {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`read_skill_reference_paths[${index}] must be an object`);
  }
  const record = value as Record<string, unknown>;
  return {
    name_or_id: requiredString(record.name_or_id, `read_skill_reference_paths[${index}].name_or_id`),
    relative_path: requiredString(record.relative_path, `read_skill_reference_paths[${index}].relative_path`)
  };
}

function validateTrace(trace: EvalTrace): void {
  if (trace.no_skill_task) {
    if (trace.mcp_calls.length > 0 || trace.expected_result_skill_names.length > 0 || trace.selected_read_skill_names.length > 0) {
      throw new Error(`No-skill trace ${trace.id} must not define MCP calls, expectations, or selected reads`);
    }
    return;
  }
  if (trace.expected_result_skill_names.length === 0) {
    throw new Error(`Trace ${trace.id} must define expected_result_skill_names`);
  }
  for (const [index, call] of trace.mcp_calls.entries()) {
    validateCallArguments(trace.id, index, call);
  }
  for (const expected of trace.expected_result_skill_names) {
    if (expected.call_index < 0 || expected.call_index >= trace.mcp_calls.length) {
      throw new Error(`Trace ${trace.id} expectation references missing call index ${expected.call_index}`);
    }
    if (expected.min_rank < 1 || expected.max_rank < expected.min_rank) {
      throw new Error(`Trace ${trace.id} expectation for ${expected.name} has invalid rank window`);
    }
  }
  const readSkillNames = trace.mcp_calls
    .filter((call) => call.tool === "read_skill")
    .map((call) => requiredString(call.arguments.name_or_id, `${trace.id}.read_skill.name_or_id`));
  if (stableCompactStringify(readSkillNames) !== stableCompactStringify(trace.selected_read_skill_names)) {
    throw new Error(`Trace ${trace.id} selected_read_skill_names must match read_skill calls exactly`);
  }
  const referencePaths = trace.mcp_calls
    .filter((call) => call.tool === "read_skill_reference")
    .map((call) => ({
      name_or_id: requiredString(call.arguments.name_or_id, `${trace.id}.read_skill_reference.name_or_id`),
      relative_path: requiredString(call.arguments.relative_path, `${trace.id}.read_skill_reference.relative_path`)
    }));
  if (stableCompactStringify(referencePaths) !== stableCompactStringify(trace.read_skill_reference_paths)) {
    throw new Error(`Trace ${trace.id} read_skill_reference_paths must match read_skill_reference calls exactly`);
  }
}

function validateCallArguments(traceId: string, index: number, call: EvalTraceCall): void {
  if (call.tool === "search_skills") {
    requiredString(call.arguments.query, `${traceId}.mcp_calls[${index}].arguments.query`);
    requiredInteger(call.arguments.limit, `${traceId}.mcp_calls[${index}].arguments.limit`);
    requiredBoolean(
      call.arguments.include_incomplete_metadata,
      `${traceId}.mcp_calls[${index}].arguments.include_incomplete_metadata`
    );
  } else if (call.tool === "read_skill") {
    requiredString(call.arguments.name_or_id, `${traceId}.mcp_calls[${index}].arguments.name_or_id`);
  } else {
    requiredString(call.arguments.name_or_id, `${traceId}.mcp_calls[${index}].arguments.name_or_id`);
    requiredString(call.arguments.relative_path, `${traceId}.mcp_calls[${index}].arguments.relative_path`);
  }
}

function parseMode(value: unknown, label: string): TraceMode {
  const mode = requiredString(value, label);
  if (mode !== "discovery_only" && mode !== "full_read") {
    throw new Error(`${label} must be discovery_only or full_read`);
  }
  return mode;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

function requiredInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  return value as number;
}

function requiredArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function readFileSyncUtf8(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

function formatSurfaceRow(name: string, counts: TextCounts): string {
  return `| ${name} | ${counts.bytes} | ${counts.characters} | ${counts.approx_tokens_4char} |`;
}

function formatSigned(value: number): string {
  return value >= 0 ? `+${value}` : String(value);
}

function formatBreakEven(value: number | null): string {
  return value === null ? "unbounded for zero variable cost" : String(value);
}

function parseCliArgs(argv: readonly string[]): { readonly root: string; readonly out?: string; readonly traceFixturePath?: string } {
  let root: string | undefined;
  let out: string | undefined;
  let traceFixturePath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") {
      root = argv[++index];
    } else if (arg === "--out") {
      out = argv[++index];
    } else if (arg === "--trace-fixture") {
      traceFixturePath = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      printUsageAndExit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!root) {
    throw new Error("Missing required --root argument");
  }
  return { root, out, traceFixturePath };
}

function printUsageAndExit(code: number): never {
  console.log(
    [
      "Usage: pnpm exec tsx scripts/eval-skill-routing-cost.ts --root <skill-root> [--out <dir>]",
      "",
      `Default canonical root: ${DEFAULT_CANONICAL_SKILL_ROOT}`,
      `Default trace fixture: ${defaultTraceFixturePath}`
    ].join("\n")
  );
  process.exit(code);
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const report = await buildSkillRoutingCostEval(options);
  if (options.out) {
    const written = await writeEvalReports(report, options.out);
    console.log(`Wrote ${written.jsonPath}`);
    console.log(`Wrote ${written.markdownPath}`);
    return;
  }
  process.stdout.write(stableStringify(report));
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
