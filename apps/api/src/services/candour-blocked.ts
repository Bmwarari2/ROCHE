import { auditEvent, incident, notification, type Transaction, task } from "@harbour/db";
import { addUkDays, candourCloseBlock } from "@harbour/domain";
import { and, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { permissionHolders } from "./device-holds";
import { rateNumber } from "./rates";
import { roleHolders } from "./role-holders";
import { incidentCloseViews, withTenantWideScope } from "./safety";

/**
 * Incidents the duty of candour holds open (#120 review rounds 2 and 3; HZ-013): no record where
 * Harbour found the duty may apply, the record open, or someone affected not told, for longer than
 * the organisation's period (`candour.close_blocked_days`, rate table). Each gets one urgent task
 * for its Registered Manager and its own escalation ladder, never the task engine's (which tells
 * clinical leads and team leaders first, once): on the day it is raised, the Registered Managers
 * who manage incidents at the location (with none, the owners); from the next day, every day until
 * nothing holds the incident, the Registered Managers and the owners (founder, director or
 * Nominated Individual) who manage incidents there. Only holders of `safety.incident.manage` are
 * told. Raising, finishing and each day's escalation are audited with opaque ids.
 */

/** The task that says an incident is held open by the duty of candour. */
export const CANDOUR_BLOCKED_TASK_KIND = "safety.candour_close_blocked";
/** How long an incident may wait on the duty of candour before the task is raised (rates.md). */
export const CANDOUR_BLOCKED_RATE_KEY = "candour.close_blocked_days";
const CANDOUR_BLOCKED_SOURCE = "incident_candour";
/** Who may act on it, and the only people told about it. */
const MANAGE = "safety.incident.manage";
const DAY_MS = 86_400_000;

type TaskRow = typeof task.$inferSelect;

/**
 * Marks the stuck-candour task of an incident done, and audits it: the incident closed (`actor`
 * is who closed it) or nothing holds it any more (the job, no actor).
 */
export async function finishCandourBlockedTasks(
  tx: Transaction,
  incidentId: string,
  now: Date,
  why: "closed" | "unblocked",
  actor: string | null = null,
): Promise<void> {
  const finished = await tx
    .update(task)
    .set({
      status: "done",
      completedAt: now,
      statusReason:
        why === "closed" ? "The incident was closed" : "The duty of candour no longer holds it",
    })
    .where(
      and(
        eq(task.kind, CANDOUR_BLOCKED_TASK_KIND),
        eq(task.sourceType, CANDOUR_BLOCKED_SOURCE),
        eq(task.sourceId, incidentId),
        inArray(task.status, ["open", "in_progress"]),
      ),
    )
    .returning({ id: task.id, tenantId: task.tenantId });
  for (const t of finished) {
    await tx.insert(auditEvent).values({
      tenantId: t.tenantId,
      ...(actor ? { actorTenantUserId: actor } : {}),
      action: "safety.candour.close_blocked_finished",
      resourceType: "task",
      resourceId: t.id,
      scope: { incidentId, why },
    });
  }
}

/** The members told on a given day: manage holders at the location with one of the roles. */
async function told(
  tx: Transaction,
  locationId: string,
  roleKeys: readonly string[],
  now: Date,
): Promise<string[]> {
  const managers = new Set(await permissionHolders(tx, MANAGE, locationId, now));
  return (await roleHolders(tx, roleKeys, [locationId], now)).filter((id) => managers.has(id));
}

/**
 * Today's step of the ladder for one open task (day 0 is the day it was raised): tells each
 * member once that day, and audits who was told (a count and the tier), or that no one could be.
 */
async function escalate(tx: Transaction, t: TaskRow, incidentId: string, now: Date) {
  if (!t.locationId) return;
  const day = Math.max(0, Math.floor((now.getTime() - t.createdAt.getTime()) / DAY_MS));
  const managers = await told(tx, t.locationId, ["registered_manager"], now);
  const owners = await told(tx, t.locationId, ["owner"], now);
  const tier =
    day === 0
      ? managers.length > 0
        ? "registered_manager"
        : "owner"
      : "registered_manager_and_owner";
  const recipients = new Set(
    tier === "registered_manager" ? managers : tier === "owner" ? owners : [...managers, ...owners],
  );
  let notified = 0;
  for (const recipient of recipients) {
    const inserted = await tx
      .insert(notification)
      .values({
        recipientTenantUserId: recipient,
        kind: "safety.candour.close_blocked",
        severity: "urgent",
        title: "An incident is waiting for the duty of candour",
        body: "It cannot close until everyone affected has been told. Open the incident to finish the duty of candour.",
        link: `/incidents/${incidentId}`,
        channels: ["in_app", "push"],
        sourceType: "task",
        sourceId: t.id,
        locationId: t.locationId,
        dedupeKey: `candour_blocked:${t.id}:d${day}:${recipient}`,
      })
      .onConflictDoNothing()
      .returning({ id: notification.id });
    notified += inserted.length;
  }
  if (notified > 0) {
    await tx.insert(auditEvent).values({
      tenantId: t.tenantId,
      action: "safety.candour.close_blocked_escalated",
      resourceType: "task",
      resourceId: t.id,
      scope: { incidentId, day, tier, told: notified },
    });
    return;
  }
  if (recipients.size > 0) return; // Everyone was told today already.
  // No one who manages incidents there holds either role: audited once a day, tried every run.
  const [already] = await tx
    .select({ id: auditEvent.id })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.resourceType, "task"),
        eq(auditEvent.resourceId, t.id),
        eq(auditEvent.action, "safety.candour.close_blocked_unrouted"),
        sql`${auditEvent.scope}->>'day' = ${String(day)}`,
      ),
    )
    .limit(1);
  if (already) return;
  await tx.insert(auditEvent).values({
    tenantId: t.tenantId,
    action: "safety.candour.close_blocked_unrouted",
    outcome: "error",
    resourceType: "task",
    resourceId: t.id,
    scope: { incidentId, day },
  });
}

/**
 * Raises, escalates and finishes the stuck-candour tasks of one organisation. Returns the tasks
 * raised; with no figure in the rate table it raises none and says so (`missingRate`).
 */
export async function raiseCandourBlockedTasks(
  tx: Transaction,
  tenantId: string,
  now: Date,
  missingRate: () => void = () => {},
): Promise<number> {
  let days: number;
  try {
    days = await rateNumber(tx, tenantId, CANDOUR_BLOCKED_RATE_KEY);
  } catch {
    missingRate();
    return 0;
  }
  return withTenantWideScope(tx, async () => {
    const waiting = await tx
      .select()
      .from(incident)
      .where(
        and(
          isNull(incident.deletedAt),
          ne(incident.status, "closed"),
          lt(incident.occurredAt, addUkDays(now, -days)),
        ),
      );
    let raised = 0;
    const views = await incidentCloseViews(tx, waiting);
    for (const row of waiting) {
      const view = views.get(row.id);
      if (!view) continue;
      const block = candourCloseBlock(view.candourState, view.candour);
      if (!block.noRecord && !block.open && block.stillToTell.length === 0) {
        await finishCandourBlockedTasks(tx, row.id, now, "unblocked");
        continue;
      }
      let [open] = await tx
        .select()
        .from(task)
        .where(
          and(
            eq(task.kind, CANDOUR_BLOCKED_TASK_KIND),
            eq(task.sourceType, CANDOUR_BLOCKED_SOURCE),
            eq(task.sourceId, row.id),
            inArray(task.status, ["open", "in_progress"]),
            isNull(task.deletedAt),
          ),
        )
        .limit(1);
      if (!open) {
        [open] = await tx
          .insert(task)
          .values({
            kind: CANDOUR_BLOCKED_TASK_KIND,
            title: "Finish the duty of candour so the incident can close",
            requiredPermission: "safety.incident.manage",
            locationId: row.locationId,
            sourceType: CANDOUR_BLOCKED_SOURCE,
            sourceId: row.id,
            assigneeRoleKey: "registered_manager",
            dueAt: now,
            priority: "urgent",
            createdAt: now,
          })
          .returning();
        if (!open) continue;
        await tx.insert(auditEvent).values({
          tenantId: open.tenantId,
          action: "safety.candour.close_blocked_raised",
          resourceType: "task",
          resourceId: open.id,
          scope: { incidentId: row.id, days },
        });
        raised++;
      }
      await escalate(tx, open, row.id, now);
    }
    return raised;
  });
}
