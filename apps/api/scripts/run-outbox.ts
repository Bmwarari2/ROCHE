import { createDatabase, createPool } from "@harbour/db";
import { loadConfig } from "../src/config";
import { outboxHandlers, relayOutbox } from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { testOnlySwitchRefusal } from "./demo-seed-guard";

/**
 * Relays the outbox once, as the worker does every few seconds, for local end-to-end tests that do
 * not start the worker: the exit journey records a death, runs this, and the safety module has
 * drafted the death notifications (HZ-013). Only against a throwaway local or CI database, as the
 * demo seed's test-only switches (demo-seed-guard.ts): on a shared one it would relay an
 * organisation's events outside the worker.
 */
const config = loadConfig();
const refusal = testOnlySwitchRefusal({
  env: process.env,
  nodeEnv: config.NODE_ENV,
  databaseUrls: [config.DATABASE_WORKER_URL, config.DATABASE_APP_URL],
});
if (refusal) throw new Error(`run-outbox refused: ${refusal}`);
const logger = createLogger("warn");
const workerPool = createPool(config.DATABASE_WORKER_URL, { max: 1 });
const appPool = createPool(config.DATABASE_APP_URL, { max: 2 });
try {
  const deps = { workerPool, appDb: createDatabase(appPool), logger };
  const handlers = outboxHandlers(deps);
  let relayed = 0;
  for (
    let batch = await relayOutbox(deps, handlers);
    batch > 0;
    batch = await relayOutbox(deps, handlers)
  ) {
    relayed += batch;
  }
  console.log(`Outbox events relayed: ${relayed}`);
} finally {
  await workerPool.end();
  await appPool.end();
}
