import { Effect } from "effect";
import type { Express, NextFunction, Request, Response } from "express";
import { isAuthorizedBearerRequest } from "../security/auth.js";
import { createInMemoryRateLimiter } from "../security/rate-limit.js";
import { scanSkillRoots } from "../skills/scanner.js";
import type { AppConfig } from "../types.js";
import type { SkillCatalogRuntime } from "../mcp/mcp-server.js";

export function registerManagementUi(app: Express, runtime: SkillCatalogRuntime, bearerToken: string | undefined): void {
  app.get("/", (_req: Request, res: Response) => {
    res.redirect("/admin");
  });

  app.get("/admin", (_req: Request, res: Response) => {
    res.type("html").send(managementHtml());
  });

  const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
    if (!isAuthorizedBearerRequest(req, bearerToken)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  };
  const guardAdminPost = (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "POST") {
      next();
      return;
    }
    if (!hasAdminPostHeader(req) || !hasAllowedOrigin(req)) {
      res.status(403).json({ error: "Forbidden", code: "admin_post_guard_failed" });
      return;
    }
    next();
  };
  const adminRateLimiter = createInMemoryRateLimiter(runtime.config.limits.rateLimit, (res) => {
    res.status(429).json({ error: "Too Many Requests", code: "rate_limited" });
  });
  const rateLimitAdmin = (req: Request, res: Response, next: NextFunction) => {
    if (!adminRateLimiter(req, res)) {
      return;
    }
    next();
  };

  app.use("/admin/api", requireAdmin, guardAdminPost, rateLimitAdmin);

  app.get("/admin/api/status", async (_req: Request, res: Response) => {
    res.json(await Effect.runPromise(runtime.store.status()));
  });

  app.get("/admin/api/config", (_req: Request, res: Response) => {
    res.json(effectiveConfig(runtime.config, bearerToken));
  });

  app.get("/admin/api/audit-log", async (req: Request, res: Response) => {
    const limit = numericQuery(req.query.limit, 100);
    res.json({ entries: await Effect.runPromise(runtime.store.auditLog(limit)) });
  });

  app.post("/admin/api/rebuild", async (_req: Request, res: Response) => {
    const sync = await Effect.runPromise(scanSkillRoots(runtime.config));
    await Effect.runPromise(runtime.store.rebuild(sync));
    res.json({
      sync,
      status: await Effect.runPromise(runtime.store.status())
    });
  });

  app.post("/admin/api/smoke/search", async (req: Request, res: Response) => {
    const body = objectBody(req.body);
    const query = stringField(body.query);
    if (!query) {
      res.status(400).json({ error: "query is required" });
      return;
    }
    const limit = numberField(body.limit);
    res.json(await Effect.runPromise(runtime.search.search({ query, limit })));
  });

  app.post("/admin/api/smoke/read-skill", async (req: Request, res: Response) => {
    const body = objectBody(req.body);
    const nameOrId = stringField(body.name_or_id);
    if (!nameOrId) {
      res.status(400).json({ error: "name_or_id is required" });
      return;
    }
    res.json(await Effect.runPromise(runtime.references.readSkill(nameOrId)));
  });

  app.post("/admin/api/smoke/read-reference", async (req: Request, res: Response) => {
    const body = objectBody(req.body);
    const nameOrId = stringField(body.name_or_id);
    const relativePath = stringField(body.relative_path);
    if (!nameOrId || !relativePath) {
      res.status(400).json({ error: "name_or_id and relative_path are required" });
      return;
    }
    res.json(await Effect.runPromise(runtime.references.readReference(nameOrId, relativePath)));
  });

  app.use("/admin/api", (error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    console.error(`Admin API error on ${req.method} ${req.path}`, error);
    res.status(500).json({ error: "Internal server error", code: "admin_api_error" });
  });
}

function hasAdminPostHeader(req: Request): boolean {
  return req.header("x-skill-catalog-admin")?.trim().toLowerCase() === "true";
}

function hasAllowedOrigin(req: Request): boolean {
  const origin = req.header("origin");
  if (!origin) {
    return true;
  }
  const host = req.header("host");
  if (!host) {
    return false;
  }
  try {
    return new URL(origin).origin === `${req.protocol}://${host}`;
  } catch {
    return false;
  }
}

function effectiveConfig(config: AppConfig, bearerToken: string | undefined) {
  return {
    server: {
      transport: config.server.transport,
      host: config.server.host,
      port: config.server.port,
      allowed_hosts: config.server.allowedHosts,
      max_sessions: config.server.maxSessions,
      session_idle_ttl_ms: config.server.sessionIdleTtlMs,
      session_mode: config.server.sessionMode,
      bearer_token_env: config.server.bearerTokenEnv ?? null,
      bearer_token_configured: Boolean(bearerToken)
    },
    roots: config.roots.map((root) => ({
      name: root.name,
      path: root.path,
      default_trust_status: root.defaultTrustStatus
    })),
    storage: {
      sqlite_path: config.storage.sqlitePath
    },
    search: {
      default_limit: config.search.defaultLimit,
      max_limit: config.search.maxLimit,
      qmd: config.search.qmd
    },
    limits: {
      max_skill_bytes: config.limits.maxSkillBytes,
      max_inline_reference_bytes: config.limits.maxInlineReferenceBytes,
      max_http_body_bytes: config.limits.maxHttpBodyBytes,
      follow_symlinks: config.limits.followSymlinks,
      rate_limit: config.limits.rateLimit
    }
  };
}

function numericQuery(value: unknown, fallback: number): number {
  if (typeof value !== "string") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function objectBody(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function managementHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Skill Catalog Admin</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fa;
      --panel: #ffffff;
      --text: #17202a;
      --muted: #667085;
      --line: #d9dee7;
      --blue: #2457d6;
      --green: #16794c;
      --amber: #9a5b00;
      --red: #b42318;
      --ink: #101828;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 18px 24px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
      position: sticky;
      top: 0;
      z-index: 10;
    }
    h1 {
      margin: 0;
      font-size: 20px;
      font-weight: 650;
      letter-spacing: 0;
    }
    h2 {
      margin: 0 0 12px;
      font-size: 15px;
      font-weight: 650;
      letter-spacing: 0;
    }
    main {
      padding: 20px 24px 36px;
      display: grid;
      grid-template-columns: minmax(0, 1.2fr) minmax(320px, 0.8fr);
      gap: 18px;
      align-items: start;
    }
    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
      min-width: 0;
    }
    .stack { display: grid; gap: 18px; align-content: start; }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(4, minmax(120px, 1fr));
      gap: 10px;
    }
    .metric {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      background: #fbfcfe;
      min-height: 74px;
    }
    .metric-button {
      display: block;
      width: 100%;
      text-align: left;
      color: inherit;
      cursor: pointer;
    }
    .metric-button:hover {
      border-color: var(--blue);
      background: #f4f7ff;
    }
    .view-hidden { display: none; }
    .warning-page {
      grid-template-columns: 1fr;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(160px, 1fr));
      gap: 10px;
    }
    .summary-card {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      background: #fbfcfe;
      min-height: 74px;
    }
    .summary-card span { color: var(--muted); }
    .summary-card strong {
      display: block;
      margin-top: 4px;
      font-size: 22px;
      color: var(--ink);
    }
    .metric span, label, .muted { color: var(--muted); }
    .metric strong {
      display: block;
      margin-top: 4px;
      font-size: 24px;
      color: var(--ink);
    }
    button, input {
      font: inherit;
      border-radius: 6px;
      border: 1px solid var(--line);
      min-height: 34px;
    }
    button {
      background: var(--ink);
      color: white;
      padding: 0 12px;
      cursor: pointer;
    }
    button.secondary {
      background: #ffffff;
      color: var(--ink);
    }
    button:disabled { opacity: .55; cursor: default; }
    input {
      padding: 0 10px;
      min-width: 160px;
      background: #ffffff;
      color: var(--ink);
    }
    .field {
      display: grid;
      gap: 4px;
      min-width: 180px;
    }
    .field.small { min-width: 84px; }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    .table-scroll {
      max-height: 380px;
      overflow: auto;
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
    }
    .table-scroll table th {
      position: sticky;
      top: 0;
      z-index: 1;
      background: var(--panel);
    }
    th, td {
      padding: 9px 8px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
      word-break: break-word;
    }
    th {
      color: var(--muted);
      font-size: 12px;
      font-weight: 600;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      padding: 2px 7px;
      border-radius: 999px;
      background: #eef2ff;
      color: var(--blue);
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
    }
    .pill.green { background: #e9f7ef; color: var(--green); }
    .pill.amber { background: #fff4db; color: var(--amber); }
    .pill.red { background: #ffebe9; color: var(--red); }
    pre {
      margin: 0;
      padding: 12px;
      max-height: 340px;
      overflow: auto;
      border-radius: 8px;
      background: #101828;
      color: #f9fafb;
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .status-line {
      min-height: 22px;
      color: var(--muted);
    }
    .split {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    @media (max-width: 980px) {
      header { align-items: flex-start; flex-direction: column; }
      main { grid-template-columns: 1fr; padding: 16px; }
      .metrics, .split { grid-template-columns: 1fr; }
      .toolbar { align-items: stretch; }
      .field, input, button { width: 100%; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Skill Catalog Admin</h1>
    <div class="toolbar">
      <label class="field">
        <span>Bearer token</span>
        <input id="token" type="password" autocomplete="off">
      </label>
      <button class="secondary" id="saveToken">Save</button>
      <button id="refresh">Refresh</button>
    </div>
  </header>
  <main id="dashboardView">
    <div class="stack">
      <section>
        <h2>Status</h2>
        <div class="metrics">
          <div class="metric"><span>Skills</span><strong id="metricSkills">0</strong></div>
          <div class="metric"><span>Roots</span><strong id="metricRoots">0</strong></div>
          <button class="metric metric-button" id="showWarnings" type="button"><span>Warnings</span><strong id="metricWarnings">0</strong></button>
          <div class="metric"><span>QMD</span><strong id="metricQmd">-</strong></div>
        </div>
      </section>
      <section>
        <div class="toolbar" style="justify-content: space-between;">
          <h2>Roots And Sync</h2>
          <button class="secondary" id="rebuild">Rebuild Index</button>
        </div>
        <table>
          <thead><tr><th>Name</th><th>Trust</th><th>Indexed</th><th>Errors</th><th>Path</th></tr></thead>
          <tbody id="roots"></tbody>
        </table>
      </section>
      <section>
        <h2>Metadata And Trust Warnings</h2>
        <div class="table-scroll">
          <table>
            <thead><tr><th>Skill</th><th>Trust</th><th>Missing</th><th>Warnings</th></tr></thead>
            <tbody id="warnings"></tbody>
          </table>
        </div>
      </section>
      <section>
        <h2>Smoke Checks</h2>
        <div class="toolbar">
          <label class="field"><span>Query</span><input id="searchQuery" value="prd"></label>
          <label class="field small"><span>Limit</span><input id="searchLimit" type="number" min="1" max="20" value="5"></label>
          <button id="runSearch">Search</button>
        </div>
        <div class="toolbar" style="margin-top: 10px;">
          <label class="field"><span>Skill</span><input id="skillName" value="cal-grid"></label>
          <button id="readSkill">Read Skill</button>
          <label class="field"><span>Reference</span><input id="referencePath" value="cal-grid-template.md"></label>
          <button id="readReference">Read Reference</button>
        </div>
        <div style="margin-top: 12px;"><pre id="smokeOutput">{}</pre></div>
      </section>
    </div>
    <div class="stack">
      <section>
        <h2>Search Backends</h2>
        <div class="split">
          <div><span class="muted">FTS</span><div id="ftsState" class="pill">-</div></div>
          <div><span class="muted">QMD</span><div id="qmdState" class="pill">-</div></div>
        </div>
        <table style="margin-top: 12px;">
          <thead><tr><th>Observed</th><th>Code</th><th>Message</th></tr></thead>
          <tbody id="backendWarnings"></tbody>
        </table>
      </section>
      <section>
        <h2>Effective Config</h2>
        <pre id="config">{}</pre>
      </section>
      <section>
        <h2>Audit Log</h2>
        <div class="table-scroll">
          <table>
            <thead><tr><th>Time</th><th>Tool</th><th>Skill</th><th>Duration</th></tr></thead>
            <tbody id="audit"></tbody>
          </table>
        </div>
      </section>
      <div id="statusLine" class="status-line"></div>
    </div>
  </main>
  <main id="warningView" class="warning-page view-hidden">
    <section>
      <div class="toolbar" style="justify-content: space-between;">
        <h2>Warning Details</h2>
        <button class="secondary" id="showDashboard" type="button">Back</button>
      </div>
      <div class="summary-grid">
        <div class="summary-card"><span>Skills With Warnings</span><strong id="warningSkillCount">0</strong></div>
        <div class="summary-card"><span>Indexed Skills</span><strong id="warningTotalSkills">0</strong></div>
        <div class="summary-card"><span>Skills Without Warnings</span><strong id="warningCleanSkills">0</strong></div>
      </div>
    </section>
    <section>
      <h2>Warning Code Counts</h2>
      <table>
        <thead><tr><th>Code</th><th>Affected Skills</th></tr></thead>
        <tbody id="warningCodeSummary"></tbody>
      </table>
    </section>
    <section>
      <h2>Missing Field Counts</h2>
      <table>
        <thead><tr><th>Field</th><th>Affected Skills</th></tr></thead>
        <tbody id="warningFieldSummary"></tbody>
      </table>
    </section>
    <section>
      <h2>Affected Skills</h2>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Skill</th><th>Source Root</th><th>Trust</th><th>Missing Fields</th><th>Warning Codes</th><th>Messages</th></tr></thead>
          <tbody id="warningDetails"></tbody>
        </table>
      </div>
    </section>
  </main>
  <script>
    const tokenInput = document.getElementById("token");
    const tokenStore = sessionStorage;
    const savedToken = tokenStore.getItem("skillCatalogAdminToken") || "";
    tokenInput.value = savedToken;
    let currentStatus = null;

    document.getElementById("saveToken").addEventListener("click", () => {
      tokenStore.setItem("skillCatalogAdminToken", tokenInput.value.trim());
      refreshAll();
    });
    document.getElementById("refresh").addEventListener("click", refreshAll);
    document.getElementById("showWarnings").addEventListener("click", () => {
      window.location.hash = "warnings";
      applyRoute();
    });
    document.getElementById("showDashboard").addEventListener("click", () => {
      history.replaceState(null, "", window.location.pathname);
      applyRoute();
    });
    document.getElementById("rebuild").addEventListener("click", rebuild);
    document.getElementById("runSearch").addEventListener("click", runSearch);
    document.getElementById("readSkill").addEventListener("click", readSkill);
    document.getElementById("readReference").addEventListener("click", readReference);
    window.addEventListener("hashchange", applyRoute);

    function headers(method = "GET") {
      const token = tokenStore.getItem("skillCatalogAdminToken") || "";
      const values = method === "POST" ? { "X-Skill-Catalog-Admin": "true" } : {};
      return token ? { ...values, Authorization: "Bearer " + token } : values;
    }

    async function api(path, options = {}) {
      const method = (options.method || "GET").toUpperCase();
      const response = await fetch(path, {
        ...options,
        headers: {
          ...headers(method),
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...(options.headers || {})
        }
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || response.statusText);
      return data;
    }

    async function refreshAll() {
      setStatus("Refreshing");
      try {
        const [status, config, audit] = await Promise.all([
          api("/admin/api/status"),
          api("/admin/api/config"),
          api("/admin/api/audit-log")
        ]);
        renderStatus(status);
        document.getElementById("config").textContent = JSON.stringify(config, null, 2);
        renderAudit(audit.entries || []);
        setStatus("Ready");
      } catch (error) {
        setStatus(error.message);
      }
    }

    async function rebuild() {
      setStatus("Rebuilding");
      try {
        const result = await api("/admin/api/rebuild", { method: "POST", body: "{}" });
        renderStatus(result.status);
        setStatus("Index rebuilt");
      } catch (error) {
        setStatus(error.message);
      }
    }

    async function runSearch() {
      const body = {
        query: document.getElementById("searchQuery").value,
        limit: Number(document.getElementById("searchLimit").value)
      };
      await smoke("/admin/api/smoke/search", body);
    }

    async function readSkill() {
      await smoke("/admin/api/smoke/read-skill", {
        name_or_id: document.getElementById("skillName").value
      });
    }

    async function readReference() {
      await smoke("/admin/api/smoke/read-reference", {
        name_or_id: document.getElementById("skillName").value,
        relative_path: document.getElementById("referencePath").value
      });
    }

    async function smoke(path, body) {
      setStatus("Running check");
      try {
        const result = await api(path, { method: "POST", body: JSON.stringify(body) });
        document.getElementById("smokeOutput").textContent = JSON.stringify(result, null, 2);
        setStatus("Check complete");
        refreshAll();
      } catch (error) {
        document.getElementById("smokeOutput").textContent = JSON.stringify({ error: error.message }, null, 2);
        setStatus(error.message);
      }
    }

    function renderStatus(status) {
      currentStatus = status;
      const skills = (status.roots || []).reduce((sum, root) => sum + root.skills_indexed, 0);
      document.getElementById("metricSkills").textContent = String(skills);
      document.getElementById("metricRoots").textContent = String((status.roots || []).length);
      document.getElementById("metricWarnings").textContent = String((status.metadata_warnings || []).length);
      document.getElementById("metricQmd").textContent = status.search_backends.qmd;
      document.getElementById("ftsState").textContent = status.search_backends.fts;
      document.getElementById("qmdState").textContent = status.search_backends.qmd;
      colorPill(document.getElementById("ftsState"), status.search_backends.fts);
      colorPill(document.getElementById("qmdState"), status.search_backends.qmd);
      renderRows("roots", status.roots || [], root => [
        root.name,
        pill(root.default_trust_status),
        root.skills_indexed,
        (root.errors || []).map(error => error.code).join(", ") || "-",
        root.path
      ]);
      renderRows("warnings", status.metadata_warnings || [], warning => [
        warning.skill,
        pill(warning.trust_status),
        (warning.missing_fields || []).join(", ") || "-",
        (warning.warnings || []).map(item => item.code).join(", ") || "-"
      ]);
      renderRows("backendWarnings", status.search_backend_warnings || [], warning => [
        warning.observed_at,
        warning.code,
        warning.message
      ]);
      renderWarningDetails(status);
    }

    function renderAudit(entries) {
      renderRows("audit", entries, entry => [
        entry.created_at,
        entry.tool,
        entry.skill_name || "-",
        String(entry.duration_ms) + " ms"
      ]);
    }

    function renderWarningDetails(status) {
      const warnings = status.metadata_warnings || [];
      const indexedSkills = (status.roots || []).reduce((sum, root) => sum + root.skills_indexed, 0);
      document.getElementById("warningSkillCount").textContent = String(warnings.length);
      document.getElementById("warningTotalSkills").textContent = String(indexedSkills);
      document.getElementById("warningCleanSkills").textContent = String(Math.max(indexedSkills - warnings.length, 0));
      renderRows("warningCodeSummary", countWarningCodes(warnings), item => [item.name, item.count]);
      renderRows("warningFieldSummary", countMissingFields(warnings), item => [item.name, item.count]);
      renderRows("warningDetails", warnings, warning => [
        warning.skill,
        warning.source_root,
        pill(warning.trust_status),
        (warning.missing_fields || []).join(", ") || "-",
        (warning.warnings || []).map(item => item.code).join(", ") || "-",
        (warning.warnings || []).map(item => item.message).join(" | ") || "-"
      ]);
    }

    function countWarningCodes(warnings) {
      const counts = new Map();
      for (const warning of warnings) {
        for (const item of warning.warnings || []) {
          counts.set(item.code, (counts.get(item.code) || 0) + 1);
        }
      }
      return sortedCounts(counts);
    }

    function countMissingFields(warnings) {
      const counts = new Map();
      for (const warning of warnings) {
        for (const field of warning.missing_fields || []) {
          counts.set(field, (counts.get(field) || 0) + 1);
        }
      }
      return sortedCounts(counts);
    }

    function sortedCounts(counts) {
      return [...counts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
    }

    function applyRoute() {
      const showWarnings = window.location.hash === "#warnings";
      document.getElementById("dashboardView").classList.toggle("view-hidden", showWarnings);
      document.getElementById("warningView").classList.toggle("view-hidden", !showWarnings);
      if (showWarnings && currentStatus) {
        renderWarningDetails(currentStatus);
      }
    }

    function renderRows(id, rows, toCells) {
      const body = document.getElementById(id);
      body.innerHTML = "";
      if (!rows.length) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = body.closest("table")?.querySelectorAll("thead th").length || 5;
        td.className = "muted";
        td.textContent = "No rows";
        tr.appendChild(td);
        body.appendChild(tr);
        return;
      }
      for (const row of rows) {
        const tr = document.createElement("tr");
        for (const cell of toCells(row)) {
          const td = document.createElement("td");
          if (cell && cell.__html) {
            td.innerHTML = cell.__html;
          } else {
            td.textContent = String(cell);
          }
          tr.appendChild(td);
        }
        body.appendChild(tr);
      }
    }

    function pill(value) {
      const cls = value === "trusted" || value === "ready" ? "green" : value === "blocked" || value === "unavailable" ? "red" : "amber";
      return { __html: '<span class="pill ' + cls + '">' + escapeHtml(value) + '</span>' };
    }

    function colorPill(node, value) {
      node.className = "pill " + (value === "ready" ? "green" : value === "unavailable" ? "red" : "amber");
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    }

    function setStatus(value) {
      document.getElementById("statusLine").textContent = value;
    }

    refreshAll();
    applyRoute();
  </script>
</body>
</html>`;
}
