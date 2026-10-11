import { exitRecord, location, statutoryNotification, type Transaction, task } from "@harbour/db";
import {
  exitNotifications,
  NOTIFICATION_KINDS,
  type StatutoryNotificationKind,
} from "@harbour/domain";
import { and, eq, gte, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import { contextOfExit } from "./people";
import { upsertDraft } from "./safety";

/**
 * The safety module's handlers for the people lifecycle's death events (people.md section 6;
 * safety.md rules 1, 6 and 8; HZ-013). `people.person.died` drafts the notifications the exit
 * checklist names (`exitNotifications` with a `safetyKind`): the regulator's death notification,
 * the medical examiner information unless the person died in hospital, and LeDeR for a person with
 * a learning disability or an autistic person. Each draft belongs to its exit record (its source
 * key), so a death recorded in error and corrected never stands in for a later real death.
 * `people.person.status_corrected` flags that exit's drafts as no longer indicated, never closing
 * them, and gives a holder of `safety.notification.submit` a task for any already submitted: the
 * regulator must be told the earlier notification was made in error. Phase 1 drafts for
 * locations in England only, like the incident classifier.
 */

type ExitRow = typeof exitRecord.$inferSelect;
type NotificationRow = typeof statutoryNotification.$inferSelect;

const REQUIRED_CONTENT: Partial<Record<StatutoryNotificationKind, readonly string[]>> = {
  cqc_reg16_death: ["A description of the circumstances of the death (reg 16(3))"],
};

/** A classifier draft from an incident counts for this death when it is dated within a day. */
const SAME_DEATH_WINDOW_MS = 24 * 3_600_000;

export const exitSourceKey = (exitRecordId: string, kind: StatutoryNotificationKind) =>
  `exit:${exitRecordId}:${kind}`;

/** The safety kinds an exit drafts, by exit checklist item. */
export function draftedKinds(exit: ExitRow): Map<string, StatutoryNotificationKind> {
  const kinds = new Map<string, StatutoryNotificationKind>();
  for (const n of exitNotifications(contextOfExit(exit))) {
    if (n.safetyKind) kinds.set(n.itemKey, n.safetyKind);
  }
  return kinds;
}

/**
 * The notifications for this death, by kind: the drafts this exit made, or a draft the incident
 * classifier made for the same death (an incident about the person within a day of it). Drafts of
 * an earlier exit never count (HZ-013).
 */
export async function notificationsForExit(
  tx: Transaction,
  exit: ExitRow,
): Promise<Map<StatutoryNotificationKind, NotificationRow>> {
  const found = new Map<StatutoryNotificationKind, NotificationRow>();
  if (exit.kind !== "death") return found;
  const kinds = [...new Set(draftedKinds(exit).values())];
  if (kinds.length === 0) return found;
  const own = await tx
    .select()
    .from(statutoryNotification)
    .where(
      inArray(
        statutoryNotification.sourceKey,
        kinds.map((k) => exitSourceKey(exit.id, k)),
      ),
    );
  for (const row of own) found.set(row.kind as StatutoryNotificationKind, row);
  if (exit.leftAt) {
    const fromIncidents = await tx
      .select()
      .from(statutoryNotification)
      .where(
        and(
          eq(statutoryNotification.personId, exit.personId),
          inArray(statutoryNotification.kind, kinds),
          isNotNull(statutoryNotification.incidentId),
          eq(statutoryNotification.noLongerIndicated, false),
          gte(statutoryNotification.dueAt, new Date(exit.leftAt.getTime() - SAME_DEATH_WINDOW_MS)),
          lte(statutoryNotification.dueAt, new Date(exit.leftAt.getTime() + SAME_DEATH_WINDOW_MS)),
        ),
      );
    for (const row of fromIncidents) {
      const kind = row.kind as StatutoryNotificationKind;
      if (!found.has(kind)) found.set(kind, row);
    }
  }
  return found;
}

export async function draftDeathNotifications(
  tx: Transaction,
  tenantId: string,
  exitRecordId: string,
  now: Date,
): Promise<number> {
  const [row] = await tx
    .select({ exit: exitRecord, nation: location.nation })
    .from(exitRecord)
    .innerJoin(location, eq(location.id, exitRecord.locationId))
    .where(and(eq(exitRecord.id, exitRecordId), eq(exitRecord.kind, "death")));
  if (!row?.exit.leftAt || row.nation !== "england") return 0;
  const { exit } = row;
  const diedAt = exit.leftAt;
  if (!diedAt) return 0;
  const existing = await notificationsForExit(tx, exit);
  let drafted = 0;
  for (const kind of new Set(draftedKinds(exit).values())) {
    if (existing.has(kind)) continue;
    const info = NOTIFICATION_KINDS[kind];
    const result = await upsertDraft(
      tx,
      tenantId,
      {
        sourceKey: exitSourceKey(exit.id, kind),
        kind,
        locationId: exit.locationId,
        incidentId: null,
        personId: exit.personId,
        dueAt: diedAt,
        deadlines: [
          {
            key: "without_delay",
            dueAt: diedAt,
            wording: info.statutory
              ? "Due without delay: overdue until submitted or marked not required with a reason."
              : "Due without delay (Harbour sets this; the law sets no time): overdue until done or marked not required with a reason.",
            statutory: info.statutory,
          },
        ],
        provisional: false,
        reasons: [`${info.label}: recorded on the person's death`],
        requiredContent: REQUIRED_CONTENT[kind] ?? [],
        sources: [info.source],
        classifierVersion: null,
      },
      now,
    );
    if (result.created) drafted++;
  }
  return drafted;
}

export const CORRECTION_TASK_KIND = "safety.notification_correction";

/**
 * A death corrected as recorded in error: this exit's drafts are flagged and a person decides;
 * a notification already submitted gets a task to tell the regulator it was made in error.
 */
export async function withdrawDeathNotifications(
  tx: Transaction,
  exitRecordId: string,
  now: Date,
): Promise<{ flagged: number; corrections: number }> {
  const keys = Object.keys(NOTIFICATION_KINDS).map((kind) =>
    exitSourceKey(exitRecordId, kind as StatutoryNotificationKind),
  );
  const flagged = await tx
    .update(statutoryNotification)
    .set({
      noLongerIndicated: true,
      noLongerIndicatedReason: "The death was recorded in error and has been corrected.",
    })
    .where(
      and(
        inArray(statutoryNotification.sourceKey, keys),
        inArray(statutoryNotification.status, ["draft", "ready"]),
      ),
    )
    .returning({ id: statutoryNotification.id });
  const submitted = await tx
    .select()
    .from(statutoryNotification)
    .where(
      and(
        inArray(statutoryNotification.sourceKey, keys),
        eq(statutoryNotification.status, "submitted"),
      ),
    );
  let corrections = 0;
  for (const n of submitted) {
    const [open] = await tx
      .select({ id: task.id })
      .from(task)
      .where(
        and(
          eq(task.kind, CORRECTION_TASK_KIND),
          eq(task.sourceId, n.id),
          inArray(task.status, ["open", "in_progress"]),
          isNull(task.deletedAt),
        ),
      )
      .limit(1);
    if (open) continue;
    await tx.insert(task).values({
      kind: CORRECTION_TASK_KIND,
      title: "Tell the regulator an earlier notification was made in error",
      requiredPermission: "safety.notification.submit",
      personId: n.personId,
      locationId: n.locationId,
      sourceType: "statutory_notification",
      sourceId: n.id,
      assigneeRoleKey: "registered_manager",
      dueAt: now,
      priority: "urgent",
    });
    corrections++;
  }
  return { flagged: flagged.length, corrections };
}
