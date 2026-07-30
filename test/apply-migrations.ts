/**
 * Vitest setup file: bring the in-memory D1 up to the current schema.
 *
 * Runs once per test file, before its tests. Because the pool isolates storage
 * per test, every test starts from "schema applied, tables empty" — no
 * cross-test bleed and no per-test migration cost.
 */
import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import type { Env } from "../src/types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    /** Injected by vitest.config.ts via `readD1Migrations()`. */
    TEST_MIGRATIONS: D1Migration[];
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
