import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Effect } from "effect";
import { buildRuntime } from "../../src/app.js";
import { createHttpApp, type SkillCatalogRuntime } from "../../src/mcp/mcp-server.js";
import type { AppConfig } from "../../src/types.js";
import { createFixtureRoots, fixtureConfig, type FixtureConfigOverrides } from "./skill-fixtures.js";

export interface McpTestHarness {
  readonly url: string;
  readonly mcpUrl: string;
  readonly runtime: SkillCatalogRuntime;
  readonly config: AppConfig;
  readonly connectClient: (options?: { readonly token?: string }) => Promise<Client>;
  readonly close: () => Promise<void>;
}

export interface HarnessOptions extends FixtureConfigOverrides {
  readonly bearerToken?: string;
}

const HARNESS_TOKEN_ENV = "SKILL_CATALOG_HARNESS_TOKEN";

export async function startMcpTestHarness(options: HarnessOptions = {}): Promise<McpTestHarness> {
  const roots = await createFixtureRoots();
  const tokenEnvSet = options.bearerToken !== undefined;
  if (tokenEnvSet) {
    process.env[HARNESS_TOKEN_ENV] = options.bearerToken;
  }
  const config = fixtureConfig(roots, {
    ...options,
    bearerTokenEnv: tokenEnvSet ? HARNESS_TOKEN_ENV : options.bearerTokenEnv
  });
  const runtime = await Effect.runPromise(buildRuntime(config));
  const app = createHttpApp(runtime);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  const clients: Client[] = [];

  return {
    url,
    mcpUrl: `${url}/mcp`,
    runtime,
    config,
    connectClient: async (clientOptions = {}) => {
      const headers: Record<string, string> = {};
      if (clientOptions.token !== undefined) {
        headers.authorization = `Bearer ${clientOptions.token}`;
      }
      const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
        requestInit: { headers }
      });
      const client = new Client({ name: "skill-catalog-harness", version: "0.0.0" });
      await client.connect(transport);
      clients.push(client);
      return client;
    },
    close: async () => {
      for (const client of clients.splice(0)) {
        await client.close().catch(() => {});
      }
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      runtime.store.close();
      if (tokenEnvSet) {
        delete process.env[HARNESS_TOKEN_ENV];
      }
      await roots.cleanup();
    }
  };
}
