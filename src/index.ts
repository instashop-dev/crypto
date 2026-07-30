/**
 * Worker entry point.
 *
 * Assembly only: the routes live in `src/routes.ts` and the scan orchestration
 * in `src/scan.ts`, so the cron handler added in Phase 5 can call `runScan`
 * directly instead of going through HTTP.
 */
import { createApp } from "./routes";

const app = createApp();

export default {
  fetch: app.fetch,
};

export { app };
export { createApp } from "./routes";
export { probeBinanceWs, probeMexcRest, type HealthSource } from "./routes";
