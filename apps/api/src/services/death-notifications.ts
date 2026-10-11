import { exitRecord, location, statutoryNotification, type Transaction } from "@harbour/db";
import {
  exitNotifications,
  NOTIFICATION_KINDS,
  type StatutoryNotificationKind,
} from "@harbour/domain";
import { and, eq, inArray } from "drizzle-orm";
import { contextOfExit } from "./people";
import { upsertDraft } from "./safety";

/**
 * The safety module's handlers for the people lifecycle's death events (people.md section 6;
 * safety.md rules 1, 6 and 8; HZ-013). `people.person.died` drafts the statutory notifications
 * the exit checklist names (`exitNotifications`): the regulator's death notification, the medical
 * examiner information unless the person died in hospital, and LeDeR for a person with a learning
 * disability or an autistic person. `people.person.status_corrected` flags those drafts as no
 * longer indicated, never closing them: a holder of `safety.notification.submit` decides.
 * Phase 1 drafts for locations in England only, like the incident classifier.
 */

/** Exit checklist items whose notification is a statutory draft in the safety module. */
export const DEATH_NOTIFICATION_KINDS: Readonly<Record<string, StatutoryNotificationKind>> = {
  regulator_death_notification: "cqc_reg16_death",
  medical_examiner_information: "medical_examiner",
  leder_notification: "leder",
};

const REQUIRED_CONTENT: Partial<Record<StatutoryNotificationKind, readonly string[]>> = {
  cqc_reg16_death: ["A description of the circumstances of the death (reg 16(3))"],
};

const sourceKey = (exitRecordId: string, kind: StatutoryNotificationKind) =>
  `exit:${exitRecordId}:${kind}`;

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
  let drafted = 0;
  for (const notification of exitNotifications(contextOfExit(exit))) {
    const kind = DEATH_NOTIFICATION_KINDS[notification.itemKey];
    if (!kind || !notification.statutory) continue;
    // One draft per death: one the incident classifier already made for this person stands.
    const existing = await tx
      .select({ id: statutoryNotification.id })
      .from(statutoryNotification)
      .where(
        and(
          eq(statutoryNotification.personId, exit.personId),
          eq(statutoryNotification.kind, kind),
          eq(statutoryNotification.noLongerIndicated, false),
          inArray(statutoryNotification.status, ["draft", "ready", "submitted"]),
        ),
      )
      .limit(1);
    if (existing.length > 0) continue;
    const info = NOTIFICATION_KINDS[kind];
    const result = await upsertDraft(
      tx,
      tenantId,
      {
        sourceKey: sourceKey(exit.id, kind),
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

/** A death corrected as recorded in error: its drafts are flagged, and a person decides. */
export async function withdrawDeathNotifications(
  tx: Transaction,
  exitRecordId: string,
): Promise<number> {
  const flagged = await tx
    .update(statutoryNotification)
    .set({
      noLongerIndicated: true,
      noLongerIndicatedReason: "The death was recorded in error and has been corrected.",
    })
    .where(
      and(
        inArray(
          statutoryNotification.sourceKey,
          Object.values(DEATH_NOTIFICATION_KINDS).map((kind) => sourceKey(exitRecordId, kind)),
        ),
        inArray(statutoryNotification.status, ["draft", "ready"]),
      ),
    )
    .returning({ id: statutoryNotification.id });
  return flagged.length;
}
