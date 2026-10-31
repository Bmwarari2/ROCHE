import {
  auditEvent,
  type Database,
  document,
  escalationChain,
  notification,
  notificationDelivery,
  pulseSurvey,
  type Transaction,
  taskSeries,
  tenantUser,
  withRequestContext,
} from "@harbour/db";
import {
  type DocumentStoragePort,
  deliveryOutcome,
  documentStorageKey,
  dueEscalationSteps,
  type EscalationStep,
  EXPORT_ARCHIVE_FILE,
  exportStoragePrefix,
  nextEscalationAt,
  ukIsoDate,
} from "@harbour/domain";
import { and, eq, gt, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type pg from "pg";
import type { Logger } from "../logger";
import { tellAboutBreachNotice } from "../services/breach-notices";
import {
  BREAK_GLASS_ALERT_UNROUTED_ACTION,
  generateBreakGlassReports,
} from "../services/break-glass-report";
import {
  CANDOUR_BLOCKED_UNROUTED_ACTION,
  raiseCandourBlockedTasks,
} from "../services/candour-blocked";
import { CARE_ALERT_UNROUTED_ACTION } from "../services/care";
import { raiseOverdueCareReviews } from "../services/care-planning";
import {
  draftDeathNotifications,
  withdrawDeathNotifications,
} from "../services/death-notifications";
import { buildNightlyPacks, rebuildAfterMove, rebuildLocation } from "../services/downtime-pack";
import { sweepEvidenceBundles } from "../services/evidence-pack";
import { sweepHandovers } from "../services/handover";
import { raiseDolsReminders } from "../services/mca";
import { raisePeopleReviews } from "../services/people";
import { generatePlanTasks } from "../services/plan-tasks";
import { expireImportBatches } from "../services/platform-imports";
import { raisePolicyReminders } from "../services/policies";
import { REFUSED_REVIEW_UNROUTED_ACTION } from "../services/refused-entries";
import { roleHolders, toldOf } from "../services/role-holders";
import {
  escalateOverdueSafeguardingReferrals,
  SAFEGUARDING_UNROUTED_ACTION,
} from "../services/safeguarding";
import {
  detectLocationOutbreaks,
  escalateOverdueNotifications,
  NOTIFICATION_UNROUTED_ACTION,
} from "../services/safety";
import { raiseStaffFileReminders } from "../services/staff-files";
import { escalateOverdueStatements } from "../services/statement-of-purpose";
import { tellAboutNotice } from "../services/sub-processors";
import {
  ESCALATION_UNROUTED_ACTION,
  type EscalationRun,
  escalateOverdueTasks,
  materialiseSeries,
  TASK_ESCALATION_UNROUTED_ACTION,
} from "../services/tasks";
import { errorCode, WORKER_JOB_FAILED_EVENT } from "./run-job";

/**
 * Background tasks run by pg-boss (section 6). Cross-tenant scanning uses the harbour_worker role,
 * which can see only the outbox and notifications; any work on a tenant's data runs as the
 * application role inside that tenant's row-level security context.
 */

export interface TaskDeps {
  readonly workerPool: pg.Pool;
  readonly appDb: Database;
  readonly logger: Logger;
  /** The full export's archives (the exports bucket); absent in jobs that never touch them. */
  readonly exportStorage?: DocumentStoragePort;
  /** The documents bucket, for the bytes of documents destroyed past retention. */
  readonly storage?: DocumentStoragePort;
}

/** The queue named in `worker.job.failed` when a destroyed document's bytes could not be deleted. */
export const DOCUMENT_DESTRUCTION_QUEUE = "document-destruction";

/** An outbox handler receives a published event; handlers must be idempotent (at-least-once). */
export type OutboxHandler = (event: {
  id: string;
  tenantId: string;
  eventType: string;
  aggregateId: string;
  payload: unknown;
}) => Promise<void>;

export async function relayOutbox(
  deps: TaskDeps,
  handlers: ReadonlyMap<string, OutboxHandler>,
  batchSize = 100,
): Promise<number> {
  const client = await deps.workerPool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{
      id: string;
      tenant_id: string;
      event_type: string;
      aggregate_id: string;
      payload: unknown;
    }>(
      `SELECT id, tenant_id, event_type, aggregate_id, payload FROM outbox_event
       WHERE published_at IS NULL AND available_at <= now()
       ORDER BY occurred_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [batchSize],
    );
    for (const row of rows) {
      const handler = handlers.get(row.event_type);
      try {
        await handler?.({
          id: row.id,
          tenantId: row.tenant_id,
          eventType: row.event_type,
          aggregateId: row.aggregate_id,
          payload: row.payload,
        });
        await client.query(
          "UPDATE outbox_event SET published_at = now(), attempts = attempts + 1 WHERE id = $1",
          [row.id],
        );
      } catch (error) {
        // Back off and retry later; record only the error class, never data.
        await client.query(
          `UPDATE outbox_event SET attempts = attempts + 1, last_error = $2,
             available_at = now() + make_interval(secs => least(3600, 30 * power(2, attempts)))
           WHERE id = $1`,
          [row.id, error instanceof Error ? error.name : "Error"],
        );
      }
    }
    await client.query("COMMIT");
    return rows.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** An escalation step that could be sent to no one (ADR-0071 review round 3, C3-M4). */
export const ESCALATION_STEP_UNROUTED_ACTION = "platform.escalation.unrouted";

/**
 * Who a chain step is sent to (ADR-0071 review rounds 2 and 3, C3-M4): its named member while
 * active, and the holders of its role, in force and active, whose role reaches the notification's
 * location (anywhere for one with none). With none of them, a Registered Manager whose role
 * reaches the location (there, or across the organisation), else the owner. Empty when there is
 * no one at all.
 */
export async function chainStepRecipients(
  tx: Transaction,
  step: EscalationStep,
  locationId: string | null,
  now: Date,
): Promise<string[]> {
  const recipients = new Set<string>();
  if (step.targetTenantUserId) {
    for (const id of await toldOf(tx, [step.targetTenantUserId])) recipients.add(id);
  }
  const places = locationId ? [locationId] : null;
  if (step.targetRoleKey) {
    for (const h of await roleHolders(tx, [step.targetRoleKey], places, now)) recipients.add(h);
  }
  if (recipients.size > 0) return [...recipients];
  const managers = await roleHolders(tx, ["registered_manager"], places, now);
  if (managers.length > 0) return managers;
  return roleHolders(tx, ["owner"], places, now);
}

/**
 * Fires due escalation steps: an unacknowledged notification is re-sent to the next people in its
 * chain (for example on-call after 10 minutes), until someone acknowledges it. A step that can be
 * sent to no one, even through its fallback (`chainStepRecipients`), is audited as unrouted with
 * a coded reason (`no_recipient`), never passed over silently; the later steps still fire.
 */
export async function runEscalations(deps: TaskDeps, now = new Date()): Promise<number> {
  const due = await deps.workerPool.query<{ id: string; tenant_id: string }>(
    `SELECT id, tenant_id FROM notification
     WHERE escalate_at <= $1 AND acknowledged_at IS NULL AND escalation_chain_id IS NOT NULL
     ORDER BY escalate_at LIMIT 200`,
    [now],
  );
  let fired = 0;
  for (const row of due.rows) {
    fired += await withRequestContext(
      deps.appDb,
      { tenantId: row.tenant_id, userId: null, scope: "tenant", locationIds: [] },
      async (tx) => {
        const [n] = await tx.select().from(notification).where(eq(notification.id, row.id));
        if (!n?.escalationChainId) return 0;
        const [chain] = await tx
          .select()
          .from(escalationChain)
          .where(eq(escalationChain.id, n.escalationChainId));
        if (!chain) return 0;
        const steps = chain.steps as EscalationStep[];
        const state = {
          createdAt: n.createdAt,
          stepsFired: n.escalationStep,
          acknowledgedAt: n.acknowledgedAt,
        };
        const toFire = dueEscalationSteps(steps, state, now);
        for (const { index, step } of toFire) {
          const recipients = await chainStepRecipients(tx, step, n.locationId, now);
          if (recipients.length === 0) {
            await tx.insert(auditEvent).values({
              tenantId: row.tenant_id,
              action: ESCALATION_STEP_UNROUTED_ACTION,
              outcome: "error",
              resourceType: "notification",
              resourceId: n.id,
              reason: "no_recipient",
              scope: {
                reasonCode: "no_recipient",
                chainId: chain.id,
                step: index,
                ...(step.targetRoleKey ? { roleKey: step.targetRoleKey } : {}),
                locationId: n.locationId,
              },
            });
            continue;
          }
          for (const recipient of recipients) {
            await tx
              .insert(notification)
              .values({
                recipientTenantUserId: recipient,
                kind: n.kind,
                severity: n.severity === "info" ? "warning" : n.severity,
                title: `Escalated: ${n.title}`,
                body: n.body,
                link: n.link,
                channels: [...step.channels],
                sourceType: "notification",
                sourceId: n.id,
                personId: n.personId,
                locationId: n.locationId,
                dedupeKey: `escalation:${n.id}:${index}`,
              })
              .onConflictDoNothing();
          }
        }
        const stepsFired = n.escalationStep + toFire.length;
        await tx
          .update(notification)
          .set({
            escalationStep: stepsFired,
            escalateAt: nextEscalationAt(steps, { ...state, stepsFired }),
          })
          .where(eq(notification.id, n.id));
        return toFire.length;
      },
    );
  }
  if (fired > 0) deps.logger.info({ fired }, "escalation steps fired");
  return fired;
}

/** Expired assignments end by soft delete so sync streams (which cannot read the clock) drop them. */
export async function endExpiredAssignments(deps: TaskDeps): Promise<number> {
  const tenants = await deps.workerPool.query<{ id: string }>(
    "SELECT id FROM tenant WHERE status IN ('onboarding', 'active')",
  );
  let ended = 0;
  for (const { id: tenantId } of tenants.rows) {
    ended += await withRequestContext(
      deps.appDb,
      { tenantId, userId: null, scope: "tenant", locationIds: [] },
      async (tx) => {
        const result = await tx.execute(
          sql`UPDATE person_assignment SET deleted_at = now()
              WHERE deleted_at IS NULL AND valid_to IS NOT NULL AND valid_to <= now()`,
        );
        return result.rowCount ?? 0;
      },
    );
  }
  return ended;
}

async function activeTenants(deps: TaskDeps): Promise<string[]> {
  const { rows } = await deps.workerPool.query<{ id: string }>(
    "SELECT id FROM tenant WHERE status IN ('onboarding', 'active') ORDER BY id",
  );
  return rows.map((r) => r.id);
}

/** Creates the next 48 hours of every active recurring task (idempotent; see services/tasks.ts). */
export async function materialiseTaskSeries(deps: TaskDeps, now = new Date()): Promise<number> {
  // One organisation's failure never stops the others' rounds being created (`eachTenant`).
  const created = await eachTenant(deps, "task-series-materialise", async (tx) => {
    const horizon = new Date(now.getTime() + 36 * 3_600_000);
    const due = await tx
      .select()
      .from(taskSeries)
      .where(
        and(
          eq(taskSeries.active, true),
          isNull(taskSeries.deletedAt),
          or(isNull(taskSeries.materialisedUntil), lt(taskSeries.materialisedUntil, horizon)),
        ),
      );
    let n = 0;
    for (const series of due) n += await materialiseSeries(tx, series, now);
    return n;
  });
  if (created > 0) deps.logger.info({ created }, "recurring tasks materialised");
  return created;
}

/**
 * Escalates overdue tasks once each to the people on shift (hazard HZ-008). The `due` run (every
 * minute) takes tasks not found unrouted in the last day; the `retry` run (hourly) tries again
 * those that were, so the audit is written at most once a day while routing is retried every hour
 * (ADR-0071 review round 4, C4-M1).
 */
export async function escalateTasks(
  deps: TaskDeps,
  now = new Date(),
  run: EscalationRun = "due",
): Promise<number> {
  // One organisation's failure never stops the others' (`eachTenant`; review round 5, C5-M2).
  const escalated = await eachTenant(
    deps,
    run === "due" ? "task-escalations" : "task-escalation-retries",
    (tx, tenantId) => escalateOverdueTasks(tx, tenantId, now, run),
  );
  if (escalated > 0) deps.logger.info({ escalated, run }, "overdue tasks escalated");
  return escalated;
}

/** The hourly retry of overdue tasks no one other than their assignee could be told about. */
export function retryUnroutedTasks(deps: TaskDeps, now = new Date()): Promise<number> {
  return escalateTasks(deps, now, "retry");
}

/**
 * The audit actions that mean no one could be told about safety work (ADR-0071 review rounds 2 to
 * 4): an overdue task, a sync task, an escalation chain step, an urgent refused-entry review, an
 * urgent result alert, a break-glass alert, an overdue statutory notification, an overdue
 * safeguarding referral and an incident the duty of candour holds open.
 */
export const UNROUTED_ACTIONS = [
  TASK_ESCALATION_UNROUTED_ACTION,
  ESCALATION_UNROUTED_ACTION,
  ESCALATION_STEP_UNROUTED_ACTION,
  REFUSED_REVIEW_UNROUTED_ACTION,
  CARE_ALERT_UNROUTED_ACTION,
  BREAK_GLASS_ALERT_UNROUTED_ACTION,
  NOTIFICATION_UNROUTED_ACTION,
  SAFEGUARDING_UNROUTED_ACTION,
  // An incident the duty of candour holds open, with no one who manages incidents there to tell
  // (#120 review round 4, M2).
  CANDOUR_BLOCKED_UNROUTED_ACTION,
] as const;

/** The structured log line the operator alarms on (docs/runbooks/on-call.md). */
export const UNROUTED_DAILY_EVENT = "escalation.unrouted.daily";

/** How far back the daily signal counts: a day and an hour, so nothing falls between two runs. */
export const UNROUTED_REPORT_WINDOW_MS = 25 * 3_600_000;

/**
 * The operator's daily signal (ADR-0071 review round 4, C4-M1): for each organisation with any
 * unrouted audit event in the last day, one structured log line, `escalation.unrouted.daily`, with
 * the opaque tenant id and the count per action (`UNROUTED_ACTIONS`). No personal data and no free
 * text. Returns the counts it logged, by tenant. The window is 25 hours, so an event at the edge
 * of a day is never missed between two runs (review round 5); one organisation's failure never
 * stops the others' (`eachTenant`, C5-M2).
 */
export async function reportUnroutedDaily(
  deps: TaskDeps,
  now = new Date(),
): Promise<Map<string, Record<string, number>>> {
  const since = new Date(now.getTime() - UNROUTED_REPORT_WINDOW_MS);
  const reported = new Map<string, Record<string, number>>();
  await eachTenant(deps, "unrouted-daily-report", async (tx, tenantId) => {
    const rows = await tx
      .select({ action: auditEvent.action, count: sql<number>`count(*)::int` })
      .from(auditEvent)
      .where(
        and(
          inArray(auditEvent.action, [...UNROUTED_ACTIONS]),
          gt(auditEvent.occurredAt, since),
          lte(auditEvent.occurredAt, now),
        ),
      )
      .groupBy(auditEvent.action);
    if (rows.length === 0) return 0;
    const counts = Object.fromEntries(
      UNROUTED_ACTIONS.map((action) => [action, rows.find((r) => r.action === action)?.count ?? 0]),
    );
    reported.set(tenantId, counts);
    deps.logger.warn({ event: UNROUTED_DAILY_EVENT, tenantId, counts }, UNROUTED_DAILY_EVENT);
    return 1;
  });
  return reported;
}

/**
 * Raises one task for the nurse in charge for each overdue first care plan, care plan review, risk
 * assessment review and advance care record review (care.md rule 1, HZ-015), and none twice.
 */
export async function raiseCareReviews(deps: TaskDeps, now = new Date()): Promise<number> {
  // One organisation's failure never stops the others' reviews being raised (`eachTenant`).
  const raised = await eachTenant(deps, "care-reviews", (tx, tenantId) =>
    raiseOverdueCareReviews(tx, tenantId, now),
  );
  if (raised > 0) deps.logger.info({ raised }, "care review tasks raised");
  return raised;
}

/** The audit action recorded when one organisation's part of a sweep fails. */
export const TENANT_SWEEP_FAILED_ACTION = "platform.job.tenant_failed";

/**
 * Runs a per-tenant sweep as the application role in each active tenant's context. One
 * organisation's failure never stops the others' (a handover or an alert missed everywhere because
 * of one tenant's data; HZ-018): its transaction rolls back, the failure is logged by opaque ids
 * and error code only (`worker.job.failed`, which the operator's alarm counts), and audited as the
 * system in a transaction of its own, so it is seen.
 */
export async function eachTenant(
  deps: TaskDeps,
  job: string,
  fn: (tx: Transaction, tenantId: string) => Promise<number>,
): Promise<number> {
  let total = 0;
  for (const tenantId of await activeTenants(deps)) {
    const context = { tenantId, userId: null, scope: "tenant" as const, locationIds: [] };
    try {
      total += await withRequestContext(deps.appDb, context, (tx) => fn(tx, tenantId));
    } catch (error) {
      // The database code, also when the query builder wraps the driver's error (review round 5).
      const code = errorCode(error) ?? (error instanceof Error ? error.name : "unknown");
      // The operator's failed-job alarm counts it (`worker.job.failed`; review round 5, C5-M1).
      deps.logger.error(
        { event: WORKER_JOB_FAILED_EVENT, queue: job, tenantId, code },
        WORKER_JOB_FAILED_EVENT,
      );
      try {
        await withRequestContext(deps.appDb, context, (tx) =>
          tx.insert(auditEvent).values({
            tenantId,
            action: TENANT_SWEEP_FAILED_ACTION,
            resourceType: "job",
            scope: { job, code },
          }),
        );
      } catch {
        deps.logger.error({ tenantId, job }, "tenant sweep failure could not be audited");
      }
    }
  }
  return total;
}

/**
 * DoLS expiry reminders at the rate table's days before each authorisation ends (care.md rule 11,
 * HZ-020): one task, one alert and one `care.dols.expiring` event per reminder, never twice.
 */
export async function remindDolsExpiry(deps: TaskDeps, now = new Date()): Promise<number> {
  const raised = await eachTenant(deps, "dols-reminders", (tx, tenantId) =>
    raiseDolsReminders(tx, tenantId, now),
  );
  if (raised > 0) deps.logger.info({ raised }, "DoLS expiry reminders raised");
  return raised;
}

/**
 * Staff check expiry reminders (workforce.md rule 1 and section 5): one task per reminder day
 * before each expiry or DBS re-check, never twice.
 */
export async function remindStaffFileExpiry(deps: TaskDeps, now = new Date()): Promise<number> {
  const raised = await eachTenant(deps, "staff-file-reminders", (tx, tenantId) =>
    raiseStaffFileReminders(tx, tenantId, now),
  );
  if (raised > 0) deps.logger.info({ raised }, "staff file expiry reminders raised");
  return raised;
}

/**
 * Policy read-and-sign reminders and review tasks (quality.md section 18.3; HZ-128).
 */
export async function remindPolicies(deps: TaskDeps, now = new Date()): Promise<number> {
  const raised = await eachTenant(deps, "policy-reminders", (tx, tenantId) =>
    raisePolicyReminders(tx, tenantId, now),
  );
  if (raised > 0) deps.logger.info({ raised }, "policy reminders raised");
  return raised;
}

/**
 * Overdue statutory notifications (safety.md rule 10, HZ-013): one alert to the holders of
 * `safety.notification.submit`, escalated through the tenant's chain until the notification is
 * submitted or marked not required, and `safety.notification.overdue`.
 */
export async function escalateStatutoryNotifications(
  deps: TaskDeps,
  now = new Date(),
): Promise<number> {
  const escalated = await eachTenant(deps, "statutory-notification-escalation", (tx, tenantId) =>
    escalateOverdueNotifications(tx, tenantId, now),
  );
  if (escalated > 0) deps.logger.info({ escalated }, "overdue statutory notifications escalated");
  return escalated;
}

/**
 * Safeguarding concerns past their referral target (safety.md "Safeguarding log", HZ-126): one
 * alert to the holders of `safety.safeguarding.manage`, escalated through the tenant's chain until
 * the concern is referred or a reason not to refer is recorded.
 */
export async function escalateSafeguardingReferrals(
  deps: TaskDeps,
  now = new Date(),
): Promise<number> {
  const escalated = await eachTenant(deps, "safeguarding-referral-escalation", (tx, tenantId) =>
    escalateOverdueSafeguardingReferrals(tx, tenantId, now),
  );
  if (escalated > 0) deps.logger.info({ escalated }, "overdue safeguarding referrals escalated");
  return escalated;
}

/**
 * Incidents the duty of candour has held open for longer than the organisation's period
 * (`candour.close_blocked_days`): one urgent task each for the Registered Manager, on its own
 * escalation ladder, every day until nothing holds it (#120 review rounds 2 and 3; HZ-013).
 */
export async function raiseCandourBlocked(deps: TaskDeps, now = new Date()): Promise<number> {
  const raised = await eachTenant(deps, "candour-blocked", (tx, tenantId) =>
    raiseCandourBlockedTasks(tx, tenantId, now, () =>
      // Opaque ids only: which tenant has no figure for the period.
      deps.logger.warn({ tenantId }, "candour blocked tasks not raised: no rate-table figure"),
    ),
  );
  if (raised > 0) deps.logger.info({ raised }, "incidents held open by the duty of candour");
  return raised;
}

/** Outbreak detection across each location's infection cases (safety.md rule 7). */
export async function detectOutbreaks(deps: TaskDeps, now = new Date()): Promise<number> {
  const drafted = await eachTenant(deps, "outbreak-detection", (tx, tenantId) =>
    detectLocationOutbreaks(tx, tenantId, now),
  );
  if (drafted > 0) deps.logger.info({ drafted }, "outbreak reports drafted");
  return drafted;
}

/**
 * The people review scheduler (people.md rule 8): local authority reviews, family involvement and
 * trial reviews raise one task and one alert each when due; changes in need are referred to the
 * care plan (HZ-008).
 */
export async function raiseReviews(deps: TaskDeps, now = new Date()): Promise<number> {
  const raised = await eachTenant(deps, "people-reviews", (tx, tenantId) =>
    raisePeopleReviews(tx, tenantId, now, (locationIds) =>
      // Opaque ids only: which tenant and locations have no review figures for their nation.
      deps.logger.warn(
        { tenantId, locationIds },
        "people reviews not scheduled: no rate-table review figures for the nation",
      ),
    ),
  );
  if (raised > 0) deps.logger.info({ raised }, "people reviews raised");
  return raised;
}

/**
 * Care plan rounds (care.md rule 14): every active plan's task-generating actions drive one task
 * series each; catches plans published before slice 5 and anything a failed publication left.
 */
export async function generatePlanTaskSeries(deps: TaskDeps, now = new Date()): Promise<number> {
  const changed = await eachTenant(deps, "care-plan-rounds", (tx, tenantId) =>
    generatePlanTasks(tx, tenantId, now),
  );
  if (changed > 0) deps.logger.info({ changed }, "care plan rounds generated");
  return changed;
}

/**
 * Shift handovers (care.md rule 8, HZ-018): each location's last shift compiled and locked,
 * open handovers refreshed, and late additions from the offline window appended and announced.
 */
export async function compileHandovers(deps: TaskDeps, now = new Date()): Promise<number> {
  const changed = await eachTenant(deps, "shift-handovers", (tx, tenantId) =>
    sweepHandovers(tx, tenantId, now),
  );
  if (changed > 0) deps.logger.info({ changed }, "handovers compiled or refreshed");
  return changed;
}

/**
 * The weekly break-glass report (people.md rule 14, PLAT-006): last week's report for each
 * location, stored once, and the alert to the Registered Manager and the data protection lead.
 */
export async function reportBreakGlass(deps: TaskDeps, now = new Date()): Promise<number> {
  const stored = await eachTenant(deps, "break-glass-reports", (tx, tenantId) =>
    generateBreakGlassReports(tx, tenantId, now),
  );
  if (stored > 0) deps.logger.info({ stored }, "weekly break-glass reports stored");
  return stored;
}

/**
 * The nightly downtime pack for every location (operations.md rule 8; HZ-021), once per location
 * and UK night; a location's failure is logged and the others go on.
 */
export async function buildDowntimePacks(deps: TaskDeps, now = new Date()): Promise<number> {
  const built = await eachTenant(deps, "downtime-packs", (tx, tenantId) =>
    buildNightlyPacks(tx, tenantId, now, (locationId, error) =>
      deps.logger.error(
        {
          event: WORKER_JOB_FAILED_EVENT,
          queue: "downtime-packs",
          tenantId,
          locationId,
          code: errorCode(error) ?? (error instanceof Error ? error.name : "unknown"),
        },
        WORKER_JOB_FAILED_EVENT,
      ),
    ),
  );
  if (built > 0) deps.logger.info({ built }, "downtime packs built");
  return built;
}

/**
 * Evidence pack bundles (quality.md rule 10; HZ-050): deleted once the pack is revoked or
 * discarded or its link has ended (revoked or expired); the manifest stays.
 */
export async function sweepEvidenceBundlesJob(deps: TaskDeps, now = new Date()): Promise<number> {
  const deleted = await eachTenant(deps, "evidence-bundle-sweep", (tx, tenantId) =>
    sweepEvidenceBundles(tx, tenantId, now),
  );
  if (deleted > 0) deps.logger.info({ deleted }, "evidence pack bundles deleted");
  return deleted;
}

/**
 * Staged imports past `expires_at` (platform.md rule 25): each is expired as the system, which
 * deletes its staged rows in the same transaction; audited with the row count.
 */
/**
 * Staff pulse surveys past their last day (scheduling.md section 16 rule 4; security review round 2
 * of slice 44): each open survey whose closing date has passed is closed as the system, which
 * releases its waiting responses in the same transaction; audited with no member and no count.
 */
export async function closeEndedSurveysJob(deps: TaskDeps, now = new Date()): Promise<number> {
  const today = ukIsoDate(now);
  const closed = await eachTenant(deps, "pulse-survey-close", async (tx, tenantId) => {
    const rows = await tx
      .update(pulseSurvey)
      .set({ state: "closed" })
      .where(
        and(
          eq(pulseSurvey.state, "open"),
          isNull(pulseSurvey.deletedAt),
          lt(pulseSurvey.closesOn, today),
        ),
      )
      .returning({ id: pulseSurvey.id });
    for (const r of rows) {
      await tx.insert(auditEvent).values({
        tenantId,
        action: "scheduling.pulse_survey.closed",
        resourceType: "pulse_survey",
        resourceId: r.id,
        scope: { by: "system", reason: "closing_date_passed" },
      });
    }
    return rows.length;
  });
  if (closed > 0) deps.logger.info({ closed }, "pulse surveys closed");
  return closed;
}

export async function expireImportsJob(deps: TaskDeps): Promise<number> {
  const expired = await eachTenant(deps, "import-expiry", (tx, tenantId) =>
    expireImportBatches(tx, tenantId),
  );
  if (expired > 0) deps.logger.info({ expired }, "staged imports expired");
  return expired;
}

/**
 * Revised statements of purpose past their regulation 12(3) date (quality.md rule 15): the
 * holders of safety.notification.submit are told once, through the overdue chain.
 */
export async function escalateStatementsOfPurpose(
  deps: TaskDeps,
  now = new Date(),
): Promise<number> {
  const alerted = await eachTenant(deps, "statement-of-purpose-overdue", (tx, tenantId) =>
    escalateOverdueStatements(tx, tenantId, now),
  );
  if (alerted > 0) deps.logger.info({ alerted }, "overdue statement of purpose revisions alerted");
  return alerted;
}

/**
 * The people lifecycle events after which a location's downtime pack is built again when it no
 * longer serves the people receiving care there (operations.md section 12; HZ-021).
 */
export const PACK_REBUILD_EVENTS = [
  "people.person.admitted",
  "people.person.moved",
  "people.person.went_on_leave",
  "people.person.went_to_hospital",
  "people.person.returned",
  "people.person.discharged",
  "people.person.died",
  "people.person.status_corrected",
] as const;

/**
 * Module handlers for outbox events (idempotent: at-least-once delivery). The safety module drafts
 * the death notifications from `people.person.died` and flags them when the death is corrected;
 * operations builds the downtime pack again after any lifecycle event that changes who is
 * receiving care at a location, their status or their room, and after the places change. Each
 * handler of an event runs on its own (#47 review round 1, clinical M5): a failed rebuild never
 * holds back the death notification, nor the reverse. A rebuild that fails is logged for the
 * operator by opaque ids and left to the next read or the nightly job; any other failure is
 * raised again after the rebuild has run, so the event is delivered again (both are idempotent).
 */
export function outboxHandlers(deps: TaskDeps): Map<string, OutboxHandler> {
  const inTenant = <T>(tenantId: string, fn: (tx: Transaction) => Promise<T>) =>
    withRequestContext(
      deps.appDb,
      { tenantId, userId: null, scope: "tenant", locationIds: [] },
      fn,
    );
  const exitIdOf = (payload: unknown) => {
    const value = (payload as { exitRecordId?: unknown } | null)?.exitRecordId;
    return typeof value === "string" ? value : null;
  };
  const logRebuildFailure = (event: Parameters<OutboxHandler>[0], error: unknown) =>
    deps.logger.error(
      {
        event: WORKER_JOB_FAILED_EVENT,
        queue: "downtime-pack-rebuild",
        tenantId: event.tenantId,
        outboxEventId: event.id,
        code: errorCode(error) ?? (error instanceof Error ? error.name : "unknown"),
      },
      WORKER_JOB_FAILED_EVENT,
    );
  const rebuild: OutboxHandler = async (event) => {
    const payload = event.payload as { personId?: unknown; locationId?: unknown } | null;
    const personId = payload?.personId;
    if (typeof personId !== "string") return;
    const from = typeof payload?.locationId === "string" ? payload.locationId : null;
    try {
      await inTenant(event.tenantId, (tx) =>
        rebuildAfterMove(tx, event.tenantId, personId, from, new Date()),
      );
    } catch (error) {
      logRebuildFailure(event, error);
    }
  };
  // A downloaded or cancelled export's archive goes (PLAT-015, HZ-070): a failure throws, so the
  // relay backs off and retries until the archive is gone. Its key is built from the ids.
  const deleteArchive: OutboxHandler = async (event) => {
    const exportId = (event.payload as { exportId?: unknown } | null)?.exportId;
    if (typeof exportId !== "string" || !deps.exportStorage) return;
    await deps.exportStorage.destroy(
      `${exportStoragePrefix(event.tenantId, exportId)}${EXPORT_ARCHIVE_FILE}`,
    );
  };
  // A document destroyed past retention (PLAT-012): its tombstone and certificate are committed
  // first, and the API tries the bytes at once; this deletes them again (idempotent, every
  // version) until the storage accepts it, only for a document recorded as destroyed. A failure
  // writes `worker.job.failed` (queue `document-destruction`, opaque ids), which the operator's
  // alarm watches, and throws, so the relay backs off and tries again (security review, 31
  // October 2026).
  const deleteDestroyedDocument: OutboxHandler = async (event) => {
    try {
      if (!deps.storage) throw new Error("The worker has no document storage.");
      const [row] = await inTenant(event.tenantId, (tx) =>
        tx
          .select({ status: document.status })
          .from(document)
          .where(eq(document.id, event.aggregateId)),
      );
      if (row?.status !== "destroyed") return;
      // The key is made from the event's ids as uploads make it, never read from the row, so a
      // changed storage_key cannot point the deletion at another object (review of #134, L6).
      await deps.storage.destroy(documentStorageKey(event.tenantId, event.aggregateId));
    } catch (error) {
      deps.logger.error(
        {
          event: WORKER_JOB_FAILED_EVENT,
          queue: DOCUMENT_DESTRUCTION_QUEUE,
          tenantId: event.tenantId,
          outboxEventId: event.id,
          code: errorCode(error) ?? (error instanceof Error ? error.name : "unknown"),
        },
        WORKER_JOB_FAILED_EVENT,
      );
      throw error;
    }
  };
  const handlers = new Map<string, OutboxHandler>([
    ["platform.export.downloaded", deleteArchive],
    ["platform.export.revoked", deleteArchive],
    ["platform.document.destroyed", deleteDestroyedDocument],
    [
      "people.person.died",
      async (event) => {
        const exitRecordId = exitIdOf(event.payload);
        if (!exitRecordId) return;
        await inTenant(event.tenantId, (tx) =>
          draftDeathNotifications(tx, event.tenantId, exitRecordId, new Date()),
        );
      },
    ],
    [
      "people.person.status_corrected",
      async (event) => {
        const exitRecordId = exitIdOf(event.payload);
        if (!exitRecordId || (event.payload as { from?: unknown }).from !== "deceased") return;
        await inTenant(event.tenantId, (tx) =>
          withdrawDeathNotifications(tx, exitRecordId, new Date()),
        );
      },
    ],
  ]);
  for (const type of PACK_REBUILD_EVENTS) {
    const first = handlers.get(type);
    handlers.set(type, async (event) => {
      let failure: unknown = null;
      try {
        await first?.(event);
      } catch (error) {
        failure = error;
      }
      await rebuild(event);
      if (failure) throw failure;
    });
  }
  // Sub-processor notices and resolutions (rules 24 and 25): the lead is told; a failure throws,
  // so the relay retries, and the dedupe key tells no one twice.
  for (const type of [
    "platform.sub_processor.notice_announced",
    "platform.sub_processor.objection_resolved",
  ]) {
    handlers.set(type, async (event) => {
      const payload = event.payload as { noticeId?: unknown; responseId?: unknown } | null;
      const noticeId = payload?.noticeId;
      if (typeof noticeId !== "string") return;
      const responseId = typeof payload?.responseId === "string" ? payload.responseId : null;
      await inTenant(event.tenantId, (tx) =>
        tellAboutNotice(tx, event.tenantId, event.eventType, noticeId, new Date(), responseId),
      );
    });
  }
  // Thapsus's breach notices (platform.md rule 24): the lead and owners are told; a failure throws,
  // so the relay retries, and the dedupe key tells no one twice.
  handlers.set("platform.breach.processor_notice_sent", async (event) => {
    const noticeId = (event.payload as { noticeId?: unknown } | null)?.noticeId;
    if (typeof noticeId !== "string") return;
    await inTenant(event.tenantId, (tx) =>
      tellAboutBreachNotice(tx, event.tenantId, noticeId, new Date()),
    );
  });
  handlers.set("operations.downtime_places.changed", async (event) => {
    const locationId = (event.payload as { locationId?: unknown } | null)?.locationId;
    if (typeof locationId !== "string") return;
    try {
      await inTenant(event.tenantId, (tx) =>
        rebuildLocation(tx, event.tenantId, locationId, "places_changed", new Date()),
      );
    } catch (error) {
      logRebuildFailure(event, error);
    }
  });
  return handlers;
}

export interface DeliveryDeps extends TaskDeps {
  /** Resolves the adapter for a tenant and channel (see integrations/registry.ts). */
  readonly adapterFor: (
    tenantId: string,
    channel: "email" | "sms" | "push",
    tx: import("@harbour/db").Transaction,
  ) => Promise<import("../integrations/registry").ChannelAdapter>;
}

/**
 * Sends pending email, SMS and push deliveries. Bodies carry a generic title and a link only. A
 * delivery with no destination (no email, phone or registered device) is marked skipped so the
 * in-app notification stays the record; failures retry with backoff and then surface as failed.
 */
export async function processDeliveries(deps: DeliveryDeps, now = new Date()): Promise<number> {
  const pending = await deps.workerPool.query<{ id: string; tenant_id: string }>(
    `SELECT id, tenant_id FROM notification_delivery
     WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
     ORDER BY created_at LIMIT 100`,
    [now],
  );
  let handled = 0;
  for (const row of pending.rows) {
    await withRequestContext(
      deps.appDb,
      { tenantId: row.tenant_id, userId: null, scope: "tenant", locationIds: [] },
      async (tx) => {
        const [delivery] = await tx
          .select()
          .from(notificationDelivery)
          .where(
            and(eq(notificationDelivery.id, row.id), eq(notificationDelivery.status, "pending")),
          )
          .for("update", { skipLocked: true });
        if (!delivery) return;
        const [n] = await tx
          .select()
          .from(notification)
          .where(eq(notification.id, delivery.notificationId));
        if (!n) return;
        const [recipient] = await tx
          .select({ email: tenantUser.email })
          .from(tenantUser)
          .where(eq(tenantUser.id, n.recipientTenantUserId));
        const channel = delivery.channel as "email" | "sms" | "push";
        const adapter = await deps.adapterFor(row.tenant_id, channel, tx);
        // Phone numbers and device push tokens arrive with staff profiles and device registration
        // (Phase 1-2); until then those channels have no destination.
        const destination = channel === "email" ? (recipient?.email ?? null) : null;
        const attempts = delivery.attempts + 1;
        if (destination === null) {
          await tx
            .update(notificationDelivery)
            .set({
              status: "skipped",
              attempts,
              provider: adapter.provider,
              lastError: "No destination",
            })
            .where(eq(notificationDelivery.id, delivery.id));
          return;
        }
        const result = await adapter.send({
          idempotencyKey: delivery.id,
          title: n.title,
          link: n.link,
          to: destination,
        });
        const outcome = deliveryOutcome(result, attempts);
        await tx
          .update(notificationDelivery)
          .set({
            status: outcome.status,
            attempts,
            provider: adapter.provider,
            providerMessageId: outcome.status === "sent" ? outcome.providerMessageId : null,
            lastError: outcome.status === "sent" ? null : outcome.error,
            sentAt: outcome.status === "sent" ? now : null,
            nextAttemptAt:
              outcome.status === "pending"
                ? new Date(now.getTime() + outcome.retryInSeconds * 1000)
                : null,
          })
          .where(eq(notificationDelivery.id, delivery.id));
        handled += 1;
      },
    );
  }
  return handled;
}
