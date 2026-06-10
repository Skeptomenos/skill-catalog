import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { hostHeaderValidation, localhostHostValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { Effect } from "effect";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { AppConfig } from "../types.js";
import { resolveBearerToken } from "../config/config.js";
import { CatalogStore } from "../storage/catalog-store.js";
import { ReferenceService } from "../reference/reference-service.js";
import { SearchService } from "../search/search-service.js";
import { isAuthorizedBearerRequest } from "../security/auth.js";
import { createInMemoryRateLimiter } from "../security/rate-limit.js";
import { registerManagementUi } from "../ui/management-ui.js";
import {
  ReadReferenceInputSchema,
  ReadReferenceOutputSchema,
  ReadSkillInputSchema,
  ReadSkillOutputSchema,
  SearchInputSchema,
  SearchOutputSchema,
  StatusOutputSchema
} from "./schemas.js";

export interface SkillCatalogRuntime {
  readonly config: AppConfig;
  readonly store: CatalogStore;
  readonly search: SearchService;
  readonly references: ReferenceService;
}

interface StatefulSessionEntry {
  readonly transport: StreamableHTTPServerTransport;
  readonly server: McpServer;
  lastSeenAt: number;
}

interface StatefulSessionState {
  readonly sessions: Map<string, StatefulSessionEntry>;
  initializeQueue: Promise<void>;
}

export function createSkillCatalogMcpServer(runtime: SkillCatalogRuntime): McpServer {
  const server = new McpServer({
    name: "skill-catalog",
    version: "0.1.0"
  });

  server.registerTool(
    "search_skills",
    {
      title: "Search Skills",
      description: "Search the read-only skill catalog and return selection metadata.",
      inputSchema: SearchInputSchema,
      outputSchema: SearchOutputSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (input) => {
      const result = await Effect.runPromise(
        runtime.search.search({
          query: input.query,
          limit: input.limit,
          includeIncompleteMetadata: input.include_incomplete_metadata
        })
      );
      return structuredResult(result);
    }
  );

  server.registerTool(
    "read_skill",
    {
      title: "Read Skill",
      description: "Read one selected skill's SKILL.md file.",
      inputSchema: ReadSkillInputSchema,
      outputSchema: ReadSkillOutputSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (input) => structuredResult(await Effect.runPromise(runtime.references.readSkill(input.name_or_id)))
  );

  server.registerTool(
    "read_skill_reference",
    {
      title: "Read Skill Reference",
      description: "Read one explicit reference file under a selected skill directory.",
      inputSchema: ReadReferenceInputSchema,
      outputSchema: ReadReferenceOutputSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async (input) =>
      structuredResult(
        await Effect.runPromise(runtime.references.readReference(input.name_or_id, input.relative_path))
      )
  );

  server.registerTool(
    "skill_catalog_status",
    {
      title: "Skill Catalog Status",
      description: "Report skill catalog root, sync, metadata, and search backend status.",
      outputSchema: StatusOutputSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async () => structuredResult(await Effect.runPromise(runtime.store.status()))
  );

  return server;
}

export function createHttpApp(runtime: SkillCatalogRuntime): Express {
  const app = createLimitedExpressApp(runtime.config);
  const bearerToken = resolveBearerToken(runtime.config);
  const rateLimiter = createInMemoryRateLimiter(runtime.config.limits.rateLimit, respondMcpRateLimit);
  const statefulSessions: StatefulSessionState = {
    sessions: new Map(),
    initializeQueue: Promise.resolve()
  };

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  });

  app.get("/favicon.ico", (_req: Request, res: Response) => {
    res.status(204).end();
  });

  registerManagementUi(app, runtime, bearerToken);

  app.all("/mcp", async (req: Request, res: Response) => {
    if (!rateLimiter(req, res)) {
      return;
    }

    if (!isAuthorizedBearerRequest(req, bearerToken)) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: "Unauthorized"
        },
        id: null
      });
      return;
    }

    if (runtime.config.server.sessionMode === "stateless") {
      await handleStatelessRequest(runtime, req, res);
      return;
    }

    await handleStatefulRequest(runtime, statefulSessions, req, res);
  });

  return app;
}

function createLimitedExpressApp(config: AppConfig): Express {
  const app = express();
  applyHostValidation(app, config.server);
  app.use(express.json({ limit: config.limits.maxHttpBodyBytes }));
  app.use(jsonBodyErrorHandler);
  return app;
}

function applyHostValidation(app: Express, server: AppConfig["server"]): void {
  const { host } = server;
  const localhostHosts = ["127.0.0.1", "localhost", "::1"];
  if (localhostHosts.includes(host)) {
    app.use(localhostHostValidation());
  } else if (host === "0.0.0.0" || host === "::") {
    if (server.allowedHosts.length > 0) {
      app.use(hostHeaderValidation([...server.allowedHosts]));
      return;
    }
    console.warn(
      `Warning: Server is binding to ${host} without DNS rebinding protection. ` +
        "Use bearer token authentication or place the service behind a trusted private-network boundary."
    );
  } else {
    app.use(hostHeaderValidation([host, ...server.allowedHosts]));
  }
}

function jsonBodyErrorHandler(error: unknown, req: Request, res: Response, next: NextFunction): void {
  if (isBodyTooLargeError(error)) {
    if (req.path === "/mcp") {
      res.status(413).json({
        jsonrpc: "2.0",
        error: {
          code: -32013,
          message: "Request body too large"
        },
        id: null
      });
      return;
    }
    res.status(413).json({ error: "Request body too large" });
    return;
  }
  next(error);
}

function isBodyTooLargeError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { status?: unknown; type?: unknown };
  return candidate.status === 413 || candidate.type === "entity.too.large";
}

async function handleStatelessRequest(runtime: SkillCatalogRuntime, req: Request, res: Response): Promise<void> {
  const server = createSkillCatalogMcpServer(runtime);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });
  await server.connect(transport);
  await transport.handleRequest(req as IncomingMessage, res as ServerResponse, req.body);
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
}

async function handleStatefulRequest(
  runtime: SkillCatalogRuntime,
  state: StatefulSessionState,
  req: Request,
  res: Response
): Promise<void> {
  pruneExpiredStatefulSessions(state, runtime.config);
  const sessionId = req.headers["mcp-session-id"];
  let entry: StatefulSessionEntry | undefined =
    typeof sessionId === "string" ? state.sessions.get(sessionId) : undefined;
  if (entry) {
    entry.lastSeenAt = Date.now();
  }

  if (!entry && req.method === "POST" && isInitializeRequest(req.body)) {
    const createdEntry = await enqueueStatefulInitialization(state, async () => {
      pruneExpiredStatefulSessions(state, runtime.config);
      if (state.sessions.size >= runtime.config.server.maxSessions) {
        return null;
      }
      return await createStatefulSession(runtime, state);
    });
    if (!createdEntry) {
      res.status(429).json({
        jsonrpc: "2.0",
        error: {
          code: -32029,
          message: "Too Many Stateful Sessions"
        },
        id: null
      });
      return;
    }
    entry = createdEntry;
  }

  if (!entry) {
    res.status(400).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Bad Request: No valid session ID provided"
      },
      id: null
    });
    return;
  }

  await entry.transport.handleRequest(req as IncomingMessage, res as ServerResponse, req.body);
}

async function enqueueStatefulInitialization<T>(
  state: StatefulSessionState,
  createSession: () => Promise<T>
): Promise<T> {
  const next = state.initializeQueue.catch(() => undefined).then(createSession);
  state.initializeQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

function pruneExpiredStatefulSessions(state: StatefulSessionState, config: AppConfig): void {
  const now = Date.now();
  for (const [sessionId, entry] of state.sessions) {
    if (now - entry.lastSeenAt <= config.server.sessionIdleTtlMs) {
      continue;
    }
    state.sessions.delete(sessionId);
    void entry.transport.close();
  }
}

async function createStatefulSession(
  runtime: SkillCatalogRuntime,
  state: StatefulSessionState
): Promise<StatefulSessionEntry> {
  let entry: StatefulSessionEntry | undefined;
  let assignedSessionId: string | undefined;
  let closed = false;

  const server = createSkillCatalogMcpServer(runtime);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (newSessionId) => {
      assignedSessionId = newSessionId;
      if (entry) {
        state.sessions.set(newSessionId, entry);
      }
    }
  });

  entry = { transport, server, lastSeenAt: Date.now() };
  if (assignedSessionId) {
    state.sessions.set(assignedSessionId, entry);
  }

  transport.onclose = () => {
    if (closed) {
      return;
    }
    closed = true;
    const closedSessionId = transport.sessionId ?? assignedSessionId;
    if (closedSessionId) {
      state.sessions.delete(closedSessionId);
    }
    void server.close();
  };

  try {
    await server.connect(transport);
  } catch (error) {
    void transport.close();
    void server.close();
    throw error;
  }

  return entry;
}

function structuredResult<T>(result: T): {
  structuredContent: Record<string, unknown>;
  content: { type: "text"; text: string }[];
} {
  return {
    structuredContent: result as Record<string, unknown>,
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
  };
}

function respondMcpRateLimit(res: Response): void {
  res.status(429).json({
    jsonrpc: "2.0",
    error: {
      code: -32029,
      message: "Too Many Requests"
    },
    id: null
  });
}
