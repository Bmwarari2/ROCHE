import { createDatabase, createPool } from "@harbour/db";
import { loadConfig } from "../src/config";
import { outboxHandlers, relayOutbox } from "../src/jobs/tasks";
import { createLogger } from "../src/logger";

/**
 * Relays the outbox once, as the worker does every few seconds, for local end-to-end tests that do
 * not start the worker: the exit journey records a death, runs this, and the safety module has
 * drafted the death notifications (HZ-013). Development only.
 */
const config = loadConfig();
if (config.NODE_ENV === "production") throw new Error("run-outbox is for development only");
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
