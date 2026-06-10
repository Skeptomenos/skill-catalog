import { z } from "zod/v4";

const TrustStatusSchema = z.enum(["trusted", "review_required", "blocked"]);
const SkillAuthorSchema = z
  .object({
    name: z.string(),
    url: z.string().optional()
  })
  .nullable();
const SkillSourceSchema = z
  .object({
    type: z.enum(["self", "local_catalog", "remote_catalog", "git", "website", "npm"]),
    name: z.string().optional(),
    url: z.string().optional(),
    path: z.string().optional(),
    ref: z.string().optional(),
    commit: z.string().optional(),
    package: z.string().optional(),
    version: z.string().optional(),
    command: z.string().optional(),
    catalog: z.string().optional()
  })
  .nullable();
const SkillWarningSchema = z.object({
  code: z.string(),
  message: z.string()
});

export const SearchInputSchema = {
  query: z.string().min(1),
  limit: z.number().int().min(1).optional(),
  include_incomplete_metadata: z.boolean().default(true).optional()
};

export const SearchOutputSchema = z.object({
  query: z.string(),
  results: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      category: z.string().nullable(),
      author: SkillAuthorSchema,
      version: z.string().nullable(),
      source: SkillSourceSchema,
      triggers: z.array(z.string()),
      when_to_use: z.array(z.string()),
      when_not_to_use: z.array(z.string()),
      source_root: z.string(),
      trust_status: TrustStatusSchema,
      warnings: z.array(SkillWarningSchema),
      score: z.number(),
      matched_backends: z.array(z.string()),
      matched_fields: z.array(z.string()),
      why_match: z.string()
    })
  )
});

export const ReadSkillInputSchema = {
  name_or_id: z.string().min(1)
};

export const ReadSkillOutputSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  content: z.string()
});

export const ReadReferenceInputSchema = {
  name_or_id: z.string().min(1),
  relative_path: z.string().min(1)
};

export const ReadReferenceOutputSchema = z.object({
  id: z.string(),
  name: z.string(),
  relative_path: z.string(),
  size_bytes: z.number(),
  mime: z.string(),
  sha256: z.string().nullable(),
  content: z.string().nullable(),
  inline_blocked_reason: z.enum(["binary_file", "size_limit"]).optional()
});

export const StatusOutputSchema = z.object({
  roots: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      default_trust_status: TrustStatusSchema,
      skills_indexed: z.number(),
      errors: z.array(
        z.object({
          source_root: z.string(),
          path: z.string(),
          code: z.string(),
          message: z.string()
        })
      )
    })
  ),
  duplicate_names: z.array(z.string()),
  metadata_warnings: z.array(
    z.object({
      skill: z.string(),
      source_root: z.string(),
      trust_status: TrustStatusSchema,
      missing_fields: z.array(z.string()),
      warnings: z.array(SkillWarningSchema)
    })
  ),
  search_backends: z.object({
    fts: z.enum(["ready", "empty"]),
    qmd: z.enum(["disabled", "ready", "unavailable"])
  }),
  search_backend_warnings: z.array(
    z.object({
      backend: z.literal("qmd"),
      code: z.string(),
      message: z.string(),
      observed_at: z.string()
    })
  )
});
