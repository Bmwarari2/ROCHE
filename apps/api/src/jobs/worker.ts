import { createDatabase, createPool } from "@harbour/db";
import { PgBoss } from "pg-boss";
import { loadConfig } from "../config";
import { createAdapterResolver } from "../integrations/registry";
import { createLogger, idleErrorLogger } from "../logger";
import {
  endExpiredAssignments,
  escalateTasks,
  materialiseTaskSeries,
  type OutboxHandler,
  processDeliveries,
  relayOutbox,
  runEscalations,
} from "./tasks";

/**
 * Worker process: pg-boss queues and schedules (at-least-once delivery, idempotent handlers).
 * Runs as a separate ECS service from the API (infra/envs/*: `worker`).
 */
const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const workerPool = createPool(
  config.DATABASE_WORKER_URL,
  { max: 4 },
  idleErrorLogger(logger, "worker"),
);
const appPool = createPool(config.DATABASE_APP_URL, { max: 4 }, idleErrorLogger(logger, "app"));
const deps = { workerPool, appDb: createDatabase(appPool), logger };

/** Module handlers subscribe to outbox events here as modules land (Phase 1 onwards). */
const handlers = new Map<string, OutboxHandler>();

const boss = new PgBoss({ connectionString: config.DATABASE_WORKER_URL, schema: "pgboss" });
boss.on("error", (error) => logger.error({ err: { name: error.name } }, "pg-boss error"));
await boss.start();

const QUEUES = {
  outbox: "outbox-relay",
  escalations: "notification-escalations",
  assignments: "end-expired-assignments",
  deliveries: "notification-deliveries",
  taskSeries: "task-series-materialise",
  taskEscalations: "task-escalations",
} as const;

for (const name of Object.values(QUEUES)) await boss.createQueue(name);

await boss.work(QUEUES.outbox, async () => {
  while ((await relayOutbox(deps, handlers)) > 0) {
    // Drain in batches until the outbox is empty.
  }
});
await boss.work(QUEUES.escalations, async () => {
  await runEscalations(deps);
});
await boss.work(QUEUES.assignments, async () => {
  await endExpiredAssignments(deps);
});
const adapterFor = createAdapterResolver({ production: config.NODE_ENV === "production" });
await boss.work(QUEUES.deliveries, async () => {
  await processDeliveries({ ...deps, adapterFor });
});

await boss.work(QUEUES.taskSeries, async () => {
  await materialiseTaskSeries(deps);
});
await boss.work(QUEUES.taskEscalations, async () => {
  await escalateTasks(deps);
});

// Every minute: escalations are measured in minutes (section 9.1, e.g. on-call after 10 minutes).
await boss.schedule(QUEUES.outbox, "* * * * *");
await boss.schedule(QUEUES.escalations, "* * * * *");
await boss.schedule(QUEUES.assignments, "*/5 * * * *");
await boss.schedule(QUEUES.deliveries, "* * * * *");
await boss.schedule(QUEUES.taskSeries, "*/15 * * * *");
await boss.schedule(QUEUES.taskEscalations, "* * * * *");

logger.info("Harbour worker started");

const shutdown = async () => {
  await boss.stop({ graceful: true });
  await Promise.all([workerPool.end(), appPool.end()]);
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
