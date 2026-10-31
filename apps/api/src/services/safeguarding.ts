import {
  auditEvent,
  escalationChain,
  notification,
  person,
  type SafeguardingConcernRow,
  safeguardingConcern,
  type Transaction,
} from "@harbour/db";
import { type EscalationStep, nextEscalationAt, ukIsoDate } from "@harbour/domain";
import { and, eq, gt, isNull, lt, lte, or } from "drizzle-orm";
import { publish } from "../outbox";
import { rateNumber } from "./rates";
import { OVERDUE_ESCALATION_RATE_KEY, permissionHolders, withTenantWideScope } from "./safety";

/**
 * The safeguarding log's clock in the notification centre (Phase 2 slice 13; safety.md
 * "Safeguarding log"; HZ-126 and HZ-013). A concern still waiting for a referral decision past its
 * target tells the holders of `safety.safeguarding.manage` at its location once, through the
 * tenant's escalation chain; referring or deciding not to refer acknowledges the alerts.
 */

export const SAFEGUARDING_CHAIN_KEY = "safety.safeguarding.overdue";
export const SAFEGUARDING_REFERRAL_RATE_KEY = "safeguarding.referral_hours";
export const SAFEGUARDING_UNROUTED_ACTION = "safety.safeguarding.unrouted";
/**
 * An overdue concern is alerted again each day while it waits, so acknowledging the alert in the
 * notification centre never silences it (clinical review round 1).
 */
export const SAFEGUARDING_REALERT_MS = 24 * 3_600_000;

/** The tenant's chain, or the default: the owner role after the notification escalation minutes. */
export async function safeguardingChain(tx: Transaction, tenantId: string) {
  const [existing] = await tx
    .select()
    .from(escalationChain)
    .where(and(eq(escalationChain.key, SAFEGUARDING_CHAIN_KEY), isNull(escalationChain.deletedAt)));
  if (existing) return existing;
  const minutes = await rateNumber(tx, tenantId, OVERDUE_ESCALATION_RATE_KEY);
  const steps: EscalationStep[] = [
    { afterMinutes: minutes, targetRoleKey: "owner", channels: ["in_app", "email"] },
  ];
  const [created] = await tx
    .insert(escalationChain)
    .values({ key: SAFEGUARDING_CHAIN_KEY, name: "Overdue safeguarding referral", steps })
    .returning();
  if (!created) throw new Error("escalation chain was not created");
  return created;
}

/** Audited once a day when nobody active can manage the log where the concern is (as HZ-013). */
async function recordUnrouted(tx: Transaction, row: SafeguardingConcernRow, now: Date) {
  const [recent] = await tx
    .select({ id: auditEvent.id })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.action, SAFEGUARDING_UNROUTED_ACTION),
        eq(auditEvent.resourceType, "safeguarding_concern"),
        eq(auditEvent.resourceId, row.id),
        gt(auditEvent.occurredAt, new Date(now.getTime() - 86_400_000)),
      ),
    )
    .limit(1);
  if (recent) return;
  await tx.insert(auditEvent).values({
    tenantId: row.tenantId,
    action: SAFEGUARDING_UNROUTED_ACTION,
    outcome: "error",
    resourceType: "safeguarding_concern",
    resourceId: row.id,
    reason: "no_active_manager",
    scope: {
      locationId: row.locationId,
      dueAt: row.referralDueAt.toISOString(),
      reasonCode: "no_active_manager",
    },
  });
}

/**
 * Tells the managers once about each concern past its referral target and still at `concern`.
 * Runs in the worker's tenant sweep with tenant-wide scope. Returns how many were alerted.
 */
export async function escalateOverdueSafeguardingReferrals(
  tx: Transaction,
  tenantId: string,
  now: Date,
): Promise<number> {
  // Routed by where the person lives now, not where the concern was raised (review round 1).
  const found = await tx
    .select({ concern: safeguardingConcern, homeId: person.locationId })
    .from(safeguardingConcern)
    .innerJoin(person, eq(person.id, safeguardingConcern.personId))
    .where(
      and(
        eq(safeguardingConcern.state, "concern"),
        lte(safeguardingConcern.referralDueAt, now),
        or(
          isNull(safeguardingConcern.overdueNotifiedAt),
          lt(
            safeguardingConcern.overdueNotifiedAt,
            new Date(now.getTime() - SAFEGUARDING_REALERT_MS),
          ),
        ),
        isNull(safeguardingConcern.deletedAt),
      ),
    )
    .limit(500);
  const overdue = found.map((f) => ({ ...f.concern, locationId: f.homeId }));
  if (overdue.length === 0) return 0;
  const chain = await safeguardingChain(tx, tenantId);
  const steps = chain.steps as EscalationStep[];
  let alerted = 0;
  for (const row of overdue) {
    const recipients = await permissionHolders(
      tx,
      "safety.safeguarding.manage",
      row.locationId,
      now,
    );
    if (recipients.length === 0) {
      await recordUnrouted(tx, row, now);
      continue;
    }
    alerted++;
    for (const recipient of recipients) {
      await tx
        .insert(notification)
        .values({
          recipientTenantUserId: recipient,
          kind: "safety.safeguarding.overdue",
          severity: "urgent",
          title: "A safeguarding concern has not been referred",
          body: "Open it to record the referral to the local authority, or why it is not referred.",
          link: `/safeguarding/${row.id}`,
          channels: ["in_app", "push"],
          sourceType: "safeguarding_concern",
          sourceId: row.id,
          personId: row.personId,
          locationId: row.locationId,
          dedupeKey: `safeguarding_overdue:${row.id}:${ukIsoDate(now)}`,
          escalationChainId: chain.id,
          escalateAt: nextEscalationAt(steps, {
            createdAt: now,
            stepsFired: 0,
            acknowledgedAt: null,
          }),
        })
        .onConflictDoNothing();
    }
    await tx
      .update(safeguardingConcern)
      .set({ overdueNotifiedAt: now })
      .where(eq(safeguardingConcern.id, row.id));
    await publish(tx, {
      context: "safety",
      aggregateType: "safeguarding_concern",
      aggregateId: row.id,
      type: "safety.safeguarding.overdue",
      payload: { concernId: row.id, dueAt: row.referralDueAt.toISOString() },
    });
  }
  return alerted;
}

/** Stops the chain once the concern is referred or a reason not to refer is recorded. */
export async function acknowledgeSafeguardingAlerts(
  tx: Transaction,
  concernId: string,
  now: Date,
): Promise<void> {
  await withTenantWideScope(tx, async () => {
    await tx
      .update(notification)
      .set({ acknowledgedAt: now, escalateAt: null })
      .where(
        and(
          eq(notification.sourceType, "safeguarding_concern"),
          eq(notification.sourceId, concernId),
          isNull(notification.acknowledgedAt),
        ),
      );
  });
}

/**
 * A decision not to refer is never one person's alone and unseen (clinical review round 1): the
 * other holders of `safety.safeguarding.manage` at the person's home are told, as information.
 * Whether it needs a second person's agreement is for the CSO (H-599).
 */
export async function tellManagersNotReferred(
  tx: Transaction,
  row: SafeguardingConcernRow,
  decidedBy: string,
  now: Date,
): Promise<number> {
  const [home] = await tx
    .select({ locationId: person.locationId })
    .from(person)
    .where(eq(person.id, row.personId));
  const locationId = home?.locationId ?? row.locationId;
  const others = (
    await permissionHolders(tx, "safety.safeguarding.manage", locationId, now)
  ).filter((id) => id !== decidedBy);
  for (const recipient of others) {
    await tx
      .insert(notification)
      .values({
        recipientTenantUserId: recipient,
        kind: "safety.safeguarding.not_referred",
        severity: "warning",
        title: "A safeguarding concern was not referred",
        body: "A manager decided not to refer a concern to the local authority. Open it to read why.",
        link: `/safeguarding/${row.id}`,
        channels: ["in_app"],
        sourceType: "safeguarding_concern",
        sourceId: row.id,
        personId: row.personId,
        locationId,
        dedupeKey: `safeguarding_not_referred:${row.id}:${recipient}`,
      })
      .onConflictDoNothing();
  }
  return others.length;
}
