import { createDatabase, createPool } from "@harbour/db";
import { loadConfig } from "../src/config";
import { eachTenant } from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { backfillWorkflowDeadlines } from "../src/services/safety";

/**
 * Once after the release that keeps statutory notification and candour deadlines on their workflow
 * (#130 review round 2, L5; HZ-013): fills the deadline on open instances started before then,
 * from each record's own clock, in every active organisation. Idempotent, so it is safe to run
 * again on any environment; until it has run, those instances show "Deadline kept on the record"
 * on the approvals page, never "No deadline". Logs counts only.
 */
const config = loadConfig();
const logger = createLogger("info");
const workerPool = createPool(config.DATABASE_WORKER_URL, { max: 1 });
const appPool = createPool(config.DATABASE_APP_URL, { max: 2 });
try {
  const filled = await eachTenant(
    { workerPool, appDb: createDatabase(appPool), logger },
    "workflow-deadlines-backfill",
    backfillWorkflowDeadlines,
  );
  logger.info({ filled }, "workflow deadlines backfilled");
} finally {
  await workerPool.end();
  await appPool.end();
}
