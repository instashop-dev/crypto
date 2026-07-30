/**
 * Worker entry point.
 *
 * Assembly only: the routes live in `src/routes.ts` and the scan orchestration
 * in `src/scan.ts`, so the cron handler calls `runScan` directly instead of
 * going through HTTP.
 */
import { createApp } from "./routes";
import { runScan } from "./scan";
import type { Env } from "./types";

const app = createApp();

export default {
  fetch: app.fetch,

  /**
   * Cron tick (every minute, see `triggers.crons` in wrangler.jsonc).
   *
   * The scan is handed to `waitUntil` rather than awaited: the handler returns
   * immediately and the runtime keeps the Worker alive until the scan settles.
   * Nothing is caught here on purpose — `runScan` never throws, and it already
   * owns the overlap lock, the error capture and the `scans` row, so a cron
   * tick and a manual `POST /api/scan` cannot drift apart.
   */
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(runScan(env, "cron"));
  },
} satisfies ExportedHandler<Env>;

export { app };
export { createApp } from "./routes";
export { probeBinanceWs, probeMexcRest, type HealthSource } from "./routes";
