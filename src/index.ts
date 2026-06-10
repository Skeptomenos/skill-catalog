import { Effect } from "effect";
import { assertResolvedBearerToken, loadConfig } from "./config/config.js";
import { buildRuntime } from "./app.js";
import { createHttpApp } from "./mcp/mcp-server.js";

async function main(): Promise<void> {
  const configPath = parseConfigPath(process.argv.slice(2));
  const config = await Effect.runPromise(loadConfig(configPath));
  assertResolvedBearerToken(config);
  const runtime = await Effect.runPromise(buildRuntime(config));
  const app = createHttpApp(runtime);

  const server = app.listen(config.server.port, config.server.host, () => {
    console.log(`Skill Catalog MCP server listening on http://${config.server.host}:${config.server.port}/mcp`);
  });

  const shutdown = () => {
    server.close(() => {
      runtime.store.close();
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function parseConfigPath(args: readonly string[]): string | undefined {
  const configIndex = args.findIndex((arg) => arg === "--config" || arg === "-c");
  return configIndex >= 0 ? args[configIndex + 1] : undefined;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
