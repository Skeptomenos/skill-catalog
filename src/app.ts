import { Effect } from "effect";
import type { AppConfig } from "./types.js";
import { scanSkillRoots } from "./skills/scanner.js";
import { CatalogStore } from "./storage/catalog-store.js";
import { ReferenceService } from "./reference/reference-service.js";
import { SearchService } from "./search/search-service.js";
import type { SkillCatalogRuntime } from "./mcp/mcp-server.js";

export function buildRuntime(config: AppConfig): Effect.Effect<SkillCatalogRuntime, never> {
  return Effect.gen(function* () {
    const store = new CatalogStore(config);
    const sync = yield* scanSkillRoots(config);
    yield* store.rebuild(sync).pipe(
      Effect.catchAll((error) => Effect.die(error))
    );
    const runtime = {
      config,
      store,
      search: new SearchService(config, store),
      references: new ReferenceService(config, store)
    };
    return runtime;
  });
}
