import { createPool } from "@harbour/db";
import { loadConfig } from "../config";
import { createDmdReleaseSource, realPeopleEnvironment, trudSettings } from "../integrations/dmd";
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
const expected = realPeopleEnvironment({
  production: config.NODE_ENV === "production",
  environment: process.env.HARBOUR_ENV,
});
// The job's own role, never the worker's (migration 0131): where real people work it must be set.
if (expected && config.DATABASE_DMD_URL.includes("harbour_dmd_job_local")) {
  logger.error(
    { event: "dmd.download.failed", code: "database_unconfigured" },
    "DATABASE_DMD_URL must be set where real people work",
  );
  process.exit(1);
}
const pool = createPool(config.DATABASE_DMD_URL, { max: 2 });
const limits = dmdLoadLimits(config);
const source = createDmdReleaseSource({
  production: config.NODE_ENV === "production",
  environment: process.env.HARBOUR_ENV,
  limits,
  trud: trudSettings(config),
});
// Cloud Run stops a job's task with SIGTERM: what was downloaded is deleted first (review M3).
process.once("SIGTERM", () => {
  void (source.close?.() ?? Promise.resolve()).finally(() => process.exit(1));
});
let exitCode = 1;
try {
  ({ exitCode } = await runDmdReleaseJob({ pool, logger, source, limits, expected }));
} finally {
  await pool.end();
}
process.exit(exitCode);
