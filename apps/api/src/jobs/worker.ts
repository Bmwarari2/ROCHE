import { createDatabase, createPool } from "@harbour/db";
import { PgBoss } from "pg-boss";
import { loadConfig } from "../config";
import { createAdapterResolver } from "../integrations/registry";
import { createLogger, idleErrorLogger } from "../logger";
import {
  compileHandovers,
  detectOutbreaks,
  endExpiredAssignments,
  escalateStatutoryNotifications,
  escalateTasks,
  generatePlanTaskSeries,
  materialiseTaskSeries,
  outboxHandlers,
  processDeliveries,
  raiseCareReviews,
  raiseReviews,
  relayOutbox,
  remindDolsExpiry,
  reportBreakGlass,
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
const handlers = outboxHandlers(deps);

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
  careReviews: "care-reviews",
  dolsExpiry: "dols-expiry-reminders",
  statutoryNotifications: "statutory-notification-escalations",
  outbreaks: "outbreak-detection",
  peopleReviews: "people-reviews",
  breakGlassReport: "break-glass-weekly-report",
  planTasks: "care-plan-rounds",
  handovers: "shift-handovers",
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
await boss.work(QUEUES.careReviews, async () => {
  await raiseCareReviews(deps);
});
await boss.work(QUEUES.dolsExpiry, async () => {
  await remindDolsExpiry(deps);
});
await boss.work(QUEUES.statutoryNotifications, async () => {
  await escalateStatutoryNotifications(deps);
});
await boss.work(QUEUES.outbreaks, async () => {
  await detectOutbreaks(deps);
});
await boss.work(QUEUES.peopleReviews, async () => {
  await raiseReviews(deps);
});
await boss.work(QUEUES.breakGlassReport, async () => {
  await reportBreakGlass(deps);
});
await boss.work(QUEUES.planTasks, async () => {
  await generatePlanTaskSeries(deps);
});
await boss.work(QUEUES.handovers, async () => {
  await compileHandovers(deps);
});

// Every minute: escalations are measured in minutes (section 9.1, e.g. on-call after 10 minutes).
await boss.schedule(QUEUES.outbox, "* * * * *");
await boss.schedule(QUEUES.escalations, "* * * * *");
await boss.schedule(QUEUES.assignments, "*/5 * * * *");
await boss.schedule(QUEUES.deliveries, "* * * * *");
await boss.schedule(QUEUES.taskSeries, "*/15 * * * *");
await boss.schedule(QUEUES.taskEscalations, "* * * * *");
// Hourly: reviews fall due by the day; each overdue review raises one task, once.
await boss.schedule(QUEUES.careReviews, "7 * * * *");
// Every minute: a without-delay notification is overdue at once, so its alert must not wait.
await boss.schedule(QUEUES.statutoryNotifications, "* * * * *");
// Hourly: DoLS reminders fall due by the day; outbreak detection is a safety net behind the
// classification that runs whenever an infection incident is recorded.
await boss.schedule(QUEUES.dolsExpiry, "13 * * * *");
await boss.schedule(QUEUES.outbreaks, "19 * * * *");
// Hourly: people reviews fall due by the day; each raises one task, once.
await boss.schedule(QUEUES.peopleReviews, "29 * * * *");
// Daily in the small hours: the week before is reported once it has ended (Monday), and a missed
// Monday is caught up the next day.
await boss.schedule(QUEUES.breakGlassReport, "37 2 * * *");
// Hourly: care plan rounds follow each published plan at once; the sweep catches the rest.
await boss.schedule(QUEUES.planTasks, "43 * * * *");
// Every 5 minutes (HANDOVER_SWEEP_MINUTES): a shift's handover is locked soon after it ends and a
// late addition reaches the incoming staff within minutes (HZ-018).
await boss.schedule(QUEUES.handovers, "*/5 * * * *");

logger.info("Harbour worker started");

const shutdown = async () => {
  await boss.stop({ graceful: true });
  await Promise.all([workerPool.end(), appPool.end()]);
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
