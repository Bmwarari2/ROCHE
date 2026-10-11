import {
  type Database,
  escalationChain,
  notification,
  role,
  roleAssignment,
  withRequestContext,
} from "@harbour/db";
import { dueEscalationSteps, type EscalationStep, nextEscalationAt } from "@harbour/domain";
import { and, eq, isNull, sql } from "drizzle-orm";
import type pg from "pg";
import type { Logger } from "../logger";

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
            const holders = await tx
              .selectDistinct({ id: roleAssignment.tenantUserId })
              .from(roleAssignment)
              .innerJoin(role, eq(role.id, roleAssignment.roleId))
              .where(and(eq(role.key, step.targetRoleKey), isNull(roleAssignment.deletedAt)));
            for (const h of holders) recipients.add(h.id);
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
