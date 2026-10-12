import {
  auditEvent,
  type Database,
  escalationChain,
  notification,
  notificationDelivery,
  type Transaction,
  taskSeries,
  tenantUser,
  withRequestContext,
} from "@harbour/db";
import {
  deliveryOutcome,
  dueEscalationSteps,
  type EscalationStep,
  nextEscalationAt,
} from "@harbour/domain";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type pg from "pg";
import type { Logger } from "../logger";
import { generateBreakGlassReports } from "../services/break-glass-report";
import { raiseOverdueCareReviews } from "../services/care-planning";
import {
  draftDeathNotifications,
  withdrawDeathNotifications,
} from "../services/death-notifications";
import { sweepHandovers } from "../services/handover";
import { raiseDolsReminders } from "../services/mca";
import { raisePeopleReviews } from "../services/people";
import { generatePlanTasks } from "../services/plan-tasks";
import { roleHolders } from "../services/role-holders";
import { detectLocationOutbreaks, escalateOverdueNotifications } from "../services/safety";
import { escalateOverdueTasks, materialiseSeries } from "../services/tasks";

/**
 * Background tasks run by pg-boss (section 6). Cross-tenant scanning uses the harbour_worker role,
 * which can see only the outbox and notifications; any work on a tenant's data runs as the
 * application role inside that tenant's row-level security context.
 */

export interface TaskDeps {
  readonly workerPool: pg.Pool;
  readonly appDb: Database;
  readonly logger: Logger;
}

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

/**
 * Fires due escalation steps: an unacknowledged notification is re-sent to the next people in its
 * chain (for example on-call after 10 minutes), until someone acknowledges it.
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
          const recipients = new Set<string>();
          if (step.targetTenantUserId) recipients.add(step.targetTenantUserId);
          if (step.targetRoleKey) {
            // Holders in force and on the staff whose role reaches the notification's location
            // (anywhere for one with none; ADR-0071 review round 2).
            const holders = await roleHolders(
              tx,
              [step.targetRoleKey],
              n.locationId ? [n.locationId] : null,
              now,
            );
            for (const h of holders) recipients.add(h);
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
    "SELECT id FROM tenant WHERE status IN ('onboarding', 'active')",
  );
  return rows.map((r) => r.id);
}

/** Creates the next 48 hours of every active recurring task (idempotent; see services/tasks.ts). */
export async function materialiseTaskSeries(deps: TaskDeps, now = new Date()): Promise<number> {
  let created = 0;
  for (const tenantId of await activeTenants(deps)) {
    created += await withRequestContext(
      deps.appDb,
      { tenantId, userId: null, scope: "tenant", locationIds: [] },
      async (tx) => {
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
      },
    );
  }
  if (created > 0) deps.logger.info({ created }, "recurring tasks materialised");
  return created;
}

/** Escalates overdue tasks once each to the people on shift (hazard HZ-008). */
export async function escalateTasks(deps: TaskDeps, now = new Date()): Promise<number> {
  let escalated = 0;
  for (const tenantId of await activeTenants(deps)) {
    escalated += await withRequestContext(
      deps.appDb,
      { tenantId, userId: null, scope: "tenant", locationIds: [] },
      (tx) => escalateOverdueTasks(tx, tenantId, now),
    );
  }
  if (escalated > 0) deps.logger.info({ escalated }, "overdue tasks escalated");
  return escalated;
}

/**
 * Raises one task for the nurse in charge for each overdue first care plan, care plan review, risk
 * assessment review and advance care record review (care.md rule 1, HZ-015), and none twice.
 */
export async function raiseCareReviews(deps: TaskDeps, now = new Date()): Promise<number> {
  let raised = 0;
  for (const tenantId of await activeTenants(deps)) {
    raised += await withRequestContext(
      deps.appDb,
      { tenantId, userId: null, scope: "tenant", locationIds: [] },
      (tx) => raiseOverdueCareReviews(tx, tenantId, now),
    );
  }
  if (raised > 0) deps.logger.info({ raised }, "care review tasks raised");
  return raised;
}

/** The audit action recorded when one organisation's part of a sweep fails. */
export const TENANT_SWEEP_FAILED_ACTION = "platform.job.tenant_failed";

/**
 * Runs a per-tenant sweep as the application role in each active tenant's context. One
 * organisation's failure never stops the others' (a handover or an alert missed everywhere because
 * of one tenant's data; HZ-018): its transaction rolls back, the failure is logged by opaque ids
 * and error code only, and audited as the system in a transaction of its own, so it is seen.
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
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code: unknown }).code)
          : error instanceof Error
            ? error.name
            : "unknown";
      deps.logger.error({ tenantId, job, code }, "tenant sweep failed");
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
 * Module handlers for outbox events (idempotent: at-least-once delivery). The safety module drafts
 * the death notifications from `people.person.died` and flags them when the death is corrected.
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
  return new Map<string, OutboxHandler>([
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
