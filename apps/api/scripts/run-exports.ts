import { createDatabase, createPool } from "@harbour/db";
import { loadConfig } from "../src/config";
import { createDocumentServices, createExportStorage } from "../src/integrations/documents";
import { runQueuedExports } from "../src/jobs/exports";
import { createLogger } from "../src/logger";

/**
 * Runs the export worker's job once (PLAT-015), for local end-to-end tests that do not start the
 * worker: the web journey asks for an export, runs this, and downloads it. Development only.
 */
const config = loadConfig();
if (config.NODE_ENV === "production") throw new Error("run-exports is for development only");
const logger = createLogger("warn");
const workerPool = createPool(config.DATABASE_WORKER_URL, { max: 1 });
const appPool = createPool(config.DATABASE_APP_URL, { max: 2 });
try {
  const ready = await runQueuedExports({
    workerPool,
    appPool,
    appDb: createDatabase(appPool),
    logger,
    storage: createDocumentServices(config).storage,
    exportStorage: createExportStorage(config),
  });
  console.log(`Exports ready: ${ready}`);
} finally {
  await workerPool.end();
  await appPool.end();
}
