import { createPool } from "@harbour/db";
import { loadConfig } from "../config";
import { createDmdReleaseSource, trudSettings } from "../integrations/dmd";
import { createLogger } from "../logger";
import { dmdLoadLimits, runDmdReleaseJob } from "./dmd";

/**
 * The dm+d release job (integrations.md section 11, "Release download" rule 6; slice 75): one run,
 * in a process of its own (a Cloud Run job started monthly by Cloud Scheduler, H-1241), never in
 * the shared worker. Downloads the latest release from TRUD where real people work (the mock on a
 * developer's machine), loads it as the worker role, and exits non-zero when it is refused, fails
 * or cannot be downloaded. `pnpm --filter @harbour/api dmd:run` runs it once.
 */
const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const workerPool = createPool(config.DATABASE_WORKER_URL, { max: 2 });
const limits = dmdLoadLimits(config);
const source = createDmdReleaseSource({
  production: config.NODE_ENV === "production",
  environment: process.env.HARBOUR_ENV,
  limits,
  trud: trudSettings(config),
});
let exitCode = 1;
try {
  ({ exitCode } = await runDmdReleaseJob({ workerPool, logger, source, limits }));
} finally {
  await workerPool.end();
}
process.exit(exitCode);
