import { createDatabase, createPool } from "@harbour/db";
import { loadConfig } from "../src/config";
import { createDocumentServices, createExportStorage } from "../src/integrations/documents";
import { runQueuedExports } from "../src/jobs/exports";
import { createLogger } from "../src/logger";
import { testOnlySwitchRefusal } from "./demo-seed-guard";

/**
 * Runs the export worker's job once (PLAT-015), for local end-to-end tests that do not start the
 * worker: the web journey asks for an export, runs this, and downloads it. Only against a
 * throwaway local or CI database, as the demo seed's test-only switches (demo-seed-guard.ts): on a
 * shared one it would build an organisation's export outside the worker (review round 1 of
 * feat/web-break-glass-report).
 */
const config = loadConfig();
const refusal = testOnlySwitchRefusal({
  env: process.env,
  nodeEnv: config.NODE_ENV,
  databaseUrls: [config.DATABASE_WORKER_URL, config.DATABASE_APP_URL],
});
if (refusal) throw new Error(`run-exports refused: ${refusal}`);
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
