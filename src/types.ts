export type SessionMode = "stateful" | "stateless";
export type TrustStatus = "trusted" | "review_required" | "blocked";
export type SkillSourceType = "self" | "local_catalog" | "remote_catalog" | "git" | "website" | "npm";

export interface ServerConfig {
  readonly transport: "streamable-http";
  readonly host: string;
  readonly port: number;
  readonly allowedHosts: readonly string[];
  readonly maxSessions: number;
  readonly sessionIdleTtlMs: number;
  readonly bearerTokenEnv?: string;
  readonly sessionMode: SessionMode;
}

export interface RootConfig {
  readonly name: string;
  readonly path: string;
  readonly defaultTrustStatus: TrustStatus;
}

export interface QmdConfig {
  readonly enabled: boolean;
  readonly collection: string;
  readonly command: string;
}

export interface SearchConfig {
  readonly defaultLimit: number;
  readonly maxLimit: number;
  readonly qmd: QmdConfig;
}

export interface LimitConfig {
  readonly maxSkillBytes: number;
  readonly maxInlineReferenceBytes: number;
  readonly maxHttpBodyBytes: number;
  readonly followSymlinks: boolean;
  readonly rateLimit: RateLimitConfig;
}

export interface RateLimitConfig {
  readonly enabled: boolean;
  readonly windowMs: number;
  readonly maxRequests: number;
  readonly maxEntries: number;
}

export interface StorageConfig {
  readonly sqlitePath: string;
}

export interface AppConfig {
  readonly server: ServerConfig;
  readonly roots: readonly RootConfig[];
  readonly storage: StorageConfig;
  readonly search: SearchConfig;
  readonly limits: LimitConfig;
}

export interface SkillAuthor {
  readonly name: string;
  readonly url?: string;
}

export interface SkillSource {
  readonly type: SkillSourceType;
  readonly name?: string;
  readonly url?: string;
  readonly path?: string;
  readonly ref?: string;
  readonly commit?: string;
  readonly package?: string;
  readonly version?: string;
  readonly command?: string;
  readonly catalog?: string;
}

export interface SkillWarning {
  readonly code: string;
  readonly message: string;
}

export interface SkillRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: string | null;
  readonly author: SkillAuthor | null;
  readonly version: string | null;
  readonly source: SkillSource | null;
  readonly sourceRoot: string;
  readonly rootPath: string;
  readonly relativePath: string;
  readonly skillDir: string;
  readonly skillFile: string;
  readonly trustStatus: TrustStatus;
  readonly warnings: readonly SkillWarning[];
  readonly triggers: readonly string[];
  readonly whenToUse: readonly string[];
  readonly whenNotToUse: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly contentHash: string;
  readonly updatedAt: string;
  readonly bodyText: string;
}

export interface SyncError {
  readonly sourceRoot: string;
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface SyncStatusError {
  readonly source_root: string;
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface SyncResult {
  readonly skills: readonly SkillRecord[];
  readonly errors: readonly SyncError[];
  readonly duplicateNames: readonly string[];
}

export interface SearchInput {
  readonly query: string;
  readonly limit?: number;
  readonly includeIncompleteMetadata?: boolean;
}

export interface SearchResultItem {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: string | null;
  readonly author: SkillAuthor | null;
  readonly version: string | null;
  readonly source: SkillSource | null;
  readonly triggers: readonly string[];
  readonly when_to_use: readonly string[];
  readonly when_not_to_use: readonly string[];
  readonly source_root: string;
  readonly trust_status: TrustStatus;
  readonly warnings: readonly SkillWarning[];
  readonly score: number;
  readonly matched_backends: readonly string[];
  readonly matched_fields: readonly string[];
  readonly why_match: string;
}

export interface SearchResponse {
  readonly query: string;
  readonly results: readonly SearchResultItem[];
}

export interface ReadSkillResponse {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly content: string;
}

export interface ReadReferenceResponse {
  readonly id: string;
  readonly name: string;
  readonly relative_path: string;
  readonly size_bytes: number;
  readonly mime: string;
  readonly sha256: string | null;
  readonly content: string | null;
  readonly inline_blocked_reason?: "binary_file" | "size_limit";
}

export interface RootStatus {
  readonly name: string;
  readonly path: string;
  readonly default_trust_status: TrustStatus;
  readonly skills_indexed: number;
  readonly errors: readonly SyncStatusError[];
}

export interface MetadataWarning {
  readonly skill: string;
  readonly source_root: string;
  readonly trust_status: TrustStatus;
  readonly missing_fields: readonly string[];
  readonly warnings: readonly SkillWarning[];
}

export interface SearchBackendWarning {
  readonly backend: "qmd";
  readonly code: string;
  readonly message: string;
  readonly observed_at: string;
}

export interface CatalogStatus {
  readonly roots: readonly RootStatus[];
  readonly duplicate_names: readonly string[];
  readonly metadata_warnings: readonly MetadataWarning[];
  readonly search_backends: {
    readonly fts: "ready" | "empty";
    readonly qmd: "disabled" | "ready" | "unavailable";
  };
  readonly search_backend_warnings: readonly SearchBackendWarning[];
}
