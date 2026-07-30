import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  defineWorkersConfig,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers/config";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineWorkersConfig(async () => {
  // Read the migrations in Node (the pool config runs outside workerd) and hand
  // them to the test worker as a binding; `test/apply-migrations.ts` replays
  // them against the in-memory D1 before each test file runs. This keeps the
  // test schema and the deployed schema literally the same SQL.
  const migrations = await readD1Migrations(path.join(here, "migrations"));

  return {
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            // Local, in-memory D1 — never touches the remote crypto-arb DB.
            d1Databases: ["DB"],
            bindings: { TEST_MIGRATIONS: migrations },
          },
        },
      },
    },
  };
});
