import type { StatementOfPurposeContent as ContentOut } from "@harbour/contracts";
import { auditEvent, notification, statementOfPurposeVersion, type Transaction } from "@harbour/db";
import {
  checkStatementOfPurpose,
  type EscalationStep,
  formatUkDate,
  nextEscalationAt,
  STATEMENT_OF_PURPOSE_MESSAGES,
  type StatementOfPurposeContent,
} from "@harbour/domain";
import { and, eq, gt, inArray, isNull, lte } from "drizzle-orm";
import { publish } from "../outbox";
import { overdueChain, submitHolders, withTenantWideScope } from "./safety";

/**
 * The statement of purpose (quality.md rules 11 to 15; QUAL-009): a version as the API shows it,
 * and the regulation 12(3) clock's overdue alerts. The database numbers versions, keeps approved
 * ones fixed, supersedes on approval and sets when CQC must have a revision (migration 0057).
 */

export type StatementRow = typeof statementOfPurposeVersion.$inferSelect;

/** Alerts about one version are found by this source (and acknowledged when it is recorded). */
export const STATEMENT_SOURCE = "statement_of_purpose_version";
export const NOTIFICATION_OVERDUE = "quality.statement_of_purpose.notification_overdue";
/** Audited, at most daily per version, when nobody active can record the notification. */
export const STATEMENT_UNROUTED = "quality.statement_of_purpose.unrouted";

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Where a version stands against the clock, from the times the database worked out. */
function notificationOf(row: StatementRow, now: Date) {
  const base = { dueAt: iso(row.notificationDueAt), notifiedBy: row.notifiedBy };
  if (row.notificationDueAt === null) {
    return { ...base, state: "not_required" as const, notifiedAt: null, late: false };
  }
  if (row.notifiedAt !== null) {
    return {
      ...base,
      state: "notified" as const,
      notifiedAt: row.notifiedAt.toISOString(),
      late: row.notifiedAt > row.notificationDueAt,
    };
  }
  return {
    ...base,
    state: now > row.notificationDueAt ? ("overdue" as const) : ("due" as const),
    notifiedAt: null,
    late: false,
  };
}

export function statementItem(row: StatementRow, now: Date = new Date()) {
  const content = row.content as StatementOfPurposeContent;
  const checklist = checkStatementOfPurpose(content);
  return {
    id: row.id,
    versionNumber: row.versionNumber,
    state: row.state as "draft" | "approved" | "superseded" | "discarded",
    kind: row.kind as "baseline" | "revision",
    content: row.content as ContentOut,
    authorId: row.authorId,
    contributorIds: row.contributorIds,
    supersedesId: row.supersedesId,
    missing: checklist.items.flatMap((i) =>
      i.problems.map((p) => STATEMENT_OF_PURPOSE_MESSAGES[p]),
    ),
    warnings: checklist.warnings.map(() => "No registered manager is listed."),
    changeSummary: row.changeSummary as unknown[],
    registrationPrompts: row.registrationPrompts as unknown[],
    approvedBy: row.approvedBy,
    approvedAt: iso(row.approvedAt),
    notification: notificationOf(row, now),
    discardReason: row.discardReason,
    version: row.version,
  };
}

/** Stops the overdue alerts' escalation once the notification is recorded. */
export async function acknowledgeStatementAlerts(tx: Transaction, versionId: string, now: Date) {
  await withTenantWideScope(tx, () =>
    tx
      .update(notification)
      .set({ acknowledgedAt: now, escalateAt: null })
      .where(
        and(
          eq(notification.sourceType, STATEMENT_SOURCE),
          eq(notification.sourceId, versionId),
          isNull(notification.acknowledgedAt),
        ),
      ),
  );
}

/**
 * Revisions past their regulation 12(3) date with no notification recorded (rule 15): the holders
 * of `safety.notification.submit` are told once, urgently, through the tenant's overdue chain
 * (as statutory notifications are, safety.md rule 10), and
 * `quality.statement_of_purpose.notification_overdue` is published once. With nobody to tell, the
 * gap is audited at most daily and tried again on the next run.
 */
export async function escalateOverdueStatements(
  tx: Transaction,
  tenantId: string,
  now: Date,
): Promise<number> {
  const overdue = await tx
    .select()
    .from(statementOfPurposeVersion)
    .where(
      and(
        inArray(statementOfPurposeVersion.state, ["approved", "superseded"]),
        lte(statementOfPurposeVersion.notificationDueAt, now),
        isNull(statementOfPurposeVersion.notifiedAt),
      ),
    );
  let alerted = 0;
  for (const version of overdue) {
    const [told] = await tx
      .select({ id: notification.id })
      .from(notification)
      .where(
        and(eq(notification.sourceType, STATEMENT_SOURCE), eq(notification.sourceId, version.id)),
      )
      .limit(1);
    if (told) continue;
    const recipients = await submitHolders(tx, null, now);
    if (recipients.length === 0) {
      const [recent] = await tx
        .select({ id: auditEvent.id })
        .from(auditEvent)
        .where(
          and(
            eq(auditEvent.action, STATEMENT_UNROUTED),
            eq(auditEvent.resourceId, version.id),
            gt(auditEvent.occurredAt, new Date(now.getTime() - 86_400_000)),
          ),
        )
        .limit(1);
      if (!recent) {
        await tx.insert(auditEvent).values({
          tenantId,
          action: STATEMENT_UNROUTED,
          outcome: "error",
          resourceType: STATEMENT_SOURCE,
          resourceId: version.id,
          reason: "no_active_submitter",
        });
      }
      continue;
    }
    const chain = await overdueChain(tx, tenantId);
    const escalateAt = nextEscalationAt(chain.steps as EscalationStep[], {
      createdAt: now,
      stepsFired: 0,
      acknowledgedAt: null,
    });
    for (const recipient of recipients) {
      await tx
        .insert(notification)
        .values({
          recipientTenantUserId: recipient,
          kind: NOTIFICATION_OVERDUE,
          severity: "urgent",
          title: `Statement of purpose version ${version.versionNumber} is overdue at CQC`,
          body: `It was due at CQC by ${
            version.notificationDueAt ? formatUkDate(version.notificationDueAt) : "its due date"
          }. Send CQC the written details of the revision, then record when it was sent.`,
          link: `/quality/statement-of-purpose/${version.id}`,
          channels: ["in_app", "push"],
          sourceType: STATEMENT_SOURCE,
          sourceId: version.id,
          dedupeKey: `statement_of_purpose_overdue:${version.id}`,
          escalationChainId: chain.id,
          escalateAt,
        })
        .onConflictDoNothing();
    }
    await publish(tx, {
      context: "quality",
      aggregateType: STATEMENT_SOURCE,
      aggregateId: version.id,
      type: NOTIFICATION_OVERDUE,
      payload: {
        versionId: version.id,
        dueAt: version.notificationDueAt?.toISOString() ?? null,
      },
    });
    alerted++;
  }
  return alerted;
}
