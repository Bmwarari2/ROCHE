import { createDatabase, createPool } from "@harbour/db";
import { PgBoss } from "pg-boss";
import { loadConfig } from "../config";
import { createDocumentServices, createExportStorage } from "../integrations/documents";
import { createAdapterResolver } from "../integrations/registry";
import { createLogger, idleErrorLogger } from "../logger";
import { sweepInvitations } from "../services/invitations";
import { runQueuedExports, sweepExports } from "./exports";
import { runJob } from "./run-job";
import {
  buildDowntimePacks,
  compileHandovers,
  detectOutbreaks,
  endExpiredAssignments,
  escalateStatementsOfPurpose,
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
  reportUnroutedDaily,
  retryUnroutedTasks,
  runEscalations,
  sweepEvidenceBundlesJob,
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
// The auth role, only to delete sign-ins an invitation's acceptance left unlinked (#48 review H1).
const authPool = createPool(config.DATABASE_AUTH_URL, { max: 1 }, idleErrorLogger(logger, "auth"));
const deps = {
  workerPool,
  appDb: createDatabase(appPool),
  logger,
  exportStorage: createExportStorage(config),
  // The documents bucket: the export reads it, and destroyed documents' bytes are deleted from it.
  storage: createDocumentServices(config).storage,
};

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
  taskEscalationRetries: "task-escalation-retries",
  unroutedReport: "unrouted-daily-report",
  downtimePacks: "downtime-packs",
  invitations: "invitation-sweep",
  speakUpIntake: "speak-up-intake-sweep",
  evidenceBundles: "evidence-bundle-sweep",
  fullExports: "full-exports",
  exportExpiry: "export-expiry",
  statementOverdue: "statement-of-purpose-overdue",
} as const;

for (const name of Object.values(QUEUES)) await boss.createQueue(name);

/** Every job logs one structured line when it fails (`worker.job.failed`), then pg-boss retries it. */
const work = (queue: string, job: () => Promise<unknown>) =>
  boss.work(queue, () => runJob(logger, queue, job));

await work(QUEUES.outbox, async () => {
  while ((await relayOutbox(deps, handlers)) > 0) {
    // Drain in batches until the outbox is empty.
  }
});
await work(QUEUES.escalations, async () => {
  await runEscalations(deps);
});
await work(QUEUES.assignments, async () => {
  await endExpiredAssignments(deps);
});
const adapterFor = createAdapterResolver({ production: config.NODE_ENV === "production" });
await work(QUEUES.deliveries, async () => {
  await processDeliveries({ ...deps, adapterFor });
});

await work(QUEUES.taskSeries, async () => {
  await materialiseTaskSeries(deps);
});
await work(QUEUES.taskEscalations, async () => {
  await escalateTasks(deps);
});
await work(QUEUES.careReviews, async () => {
  await raiseCareReviews(deps);
});
await work(QUEUES.dolsExpiry, async () => {
  await remindDolsExpiry(deps);
});
await work(QUEUES.statutoryNotifications, async () => {
  await escalateStatutoryNotifications(deps);
});
await work(QUEUES.outbreaks, async () => {
  await detectOutbreaks(deps);
});
await work(QUEUES.peopleReviews, async () => {
  await raiseReviews(deps);
});
await work(QUEUES.breakGlassReport, async () => {
  await reportBreakGlass(deps);
});
await work(QUEUES.planTasks, async () => {
  await generatePlanTaskSeries(deps);
});
await work(QUEUES.handovers, async () => {
  await compileHandovers(deps);
});
await work(QUEUES.taskEscalationRetries, async () => {
  await retryUnroutedTasks(deps);
});
await work(QUEUES.unroutedReport, async () => {
  await reportUnroutedDaily(deps);
});
await work(QUEUES.downtimePacks, async () => {
  await buildDowntimePacks(deps);
});
await work(QUEUES.invitations, async () => {
  await sweepInvitations({ workerPool, appPool, authPool, logger });
});

// Public speak-up intake windows that have passed (ADR-0089): counts only, no personal data.
await work(QUEUES.speakUpIntake, async () => {
  await workerPool.query("DELETE FROM speak_up_intake WHERE window_end < now()");
});
await work(QUEUES.evidenceBundles, async () => {
  await sweepEvidenceBundlesJob(deps);
});
// The full export (PLAT-015): reads the documents bucket, writes the exports bucket.
const exportDeps = {
  ...deps,
  appPool,
  storage: deps.storage,
  exportStorage: deps.exportStorage,
};
await work(QUEUES.fullExports, async () => {
  await runQueuedExports(exportDeps);
});
await work(QUEUES.exportExpiry, async () => {
  await sweepExports(exportDeps);
});
await work(QUEUES.statementOverdue, async () => {
  await escalateStatementsOfPurpose(deps);
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
// Hourly: an overdue task no one other than its assignee could be told about is tried again, so
// someone who has just started is told within the hour (ADR-0071 review round 4, C4-M1).
await boss.schedule(QUEUES.taskEscalationRetries, "53 * * * *");
// Daily: one operator signal per organisation with unrouted safety work (on-call.md).
await boss.schedule(QUEUES.unroutedReport, "47 6 * * *");
// Nightly, and again every hour as a catch-up: each location gets one nightly downtime pack per UK
// night, so a failed run is retried and a run that already built it does nothing (rule 8, HZ-021).
await boss.schedule(QUEUES.downtimePacks, "23 * * * *");
// Nightly: lapsed invitations are revoked (clearing the address) and unlinked sign-ins deleted.
await boss.schedule(QUEUES.invitations, "17 3 * * *");
await boss.schedule(QUEUES.speakUpIntake, "23 * * * *");

// Every 5 minutes: an expired link's bundle goes soon after the link ends (quality.md rule 10).
await boss.schedule(QUEUES.evidenceBundles, "*/5 * * * *");
// Hourly: a revision is due at CQC by the day (regulation 12(3)); each is alerted once.
await boss.schedule(QUEUES.statementOverdue, "11 * * * *");
// Every minute: an export asked for starts at once; every 15 minutes, archives past expiry go.
await boss.schedule(QUEUES.fullExports, "* * * * *");
await boss.schedule(QUEUES.exportExpiry, "*/15 * * * *");

logger.info("Harbour worker started");

const shutdown = async () => {
  await boss.stop({ graceful: true });
  await Promise.all([workerPool.end(), appPool.end(), authPool.end()]);
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
