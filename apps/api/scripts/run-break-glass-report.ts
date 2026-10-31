import { createDatabase, createPool } from "@harbour/db";
import { loadConfig } from "../src/config";
import { reportBreakGlass } from "../src/jobs/tasks";
import { createLogger } from "../src/logger";

/**
 * Runs the weekly break-glass report job once (PLAT-006), for local end-to-end tests that do not
 * start the worker. The job reports the UK week before the time it runs; `--this-week` runs it as
 * if a week had passed, so the week in progress is reported (the journey opens a record by
 * break-glass and then reads the report; the report then says it was built a week from now). A
 * week is reported once per location, so a later run for the same week stores nothing, and the
 * worker leaves a week reported this way as it is. Development only.
 */
const config = loadConfig();
if (config.NODE_ENV === "production")
  throw new Error("run-break-glass-report is for development only");
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const now = process.argv.includes("--this-week") ? new Date(Date.now() + WEEK_MS) : new Date();
const logger = createLogger("warn");
const workerPool = createPool(config.DATABASE_WORKER_URL, { max: 1 });
const appPool = createPool(config.DATABASE_APP_URL, { max: 2 });
try {
  const stored = await reportBreakGlass(
    { workerPool, appDb: createDatabase(appPool), logger },
    now,
  );
  console.log(`Weekly break-glass reports stored: ${stored}`);
} finally {
  await workerPool.end();
  await appPool.end();
}
