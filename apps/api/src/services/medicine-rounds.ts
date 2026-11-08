import type { MedicineRound } from "@harbour/contracts";
import { medication, medicationAdministrationConflict, type Transaction, task } from "@harbour/db";
import {
  isTimeCritical,
  type MarEntry,
  type MedicinesRates,
  medicineRound,
  type PendingConflict,
  REVIEW_PENDING_WORDS,
} from "@harbour/domain";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx } from "../http/audit";
import type { AppEnv, TenantAccess } from "../http/context";
import { publish } from "../outbox";
import {
  type AdministrationRow,
  administrationOut,
  personAdministrations,
  supersededBy,
  witnessesFor,
} from "./medicine-administrations";
import { UNCHECKED_POLICY } from "./medicines";

/**
 * A person's round (medicines.md 13.7 and 15.1): the scheduled doses in a time slot, each with its
 * window, its state in words and its notices, time-critical doses first and then by due time; and
 * each when-required medicine that may be given now, with when it was last given. The person and
 * location views share it.
 */

/** Outcomes that mean the person took the dose. */
export const TAKEN: ReadonlySet<string> = new Set([
  "given",
  "self_administered",
  "given_by_family",
]);

export type { PendingConflict };
export { REVIEW_PENDING_WORDS };

/** The open first conflicts for a person, for the round. */
export function pendingConflicts(tx: Transaction, personId: string): Promise<PendingConflict[]> {
  return tx
    .select({
      medicationId: medicationAdministrationConflict.medicationId,
      dueAt: medicationAdministrationConflict.dueAt,
    })
    .from(medicationAdministrationConflict)
    .where(
      and(
        eq(medicationAdministrationConflict.personId, personId),
        isNull(medicationAdministrationConflict.resolvedAt),
        isNull(medicationAdministrationConflict.joinsId),
      ),
    );
}

export function roundFor(
  facts: {
    readonly entries: readonly MarEntry[];
    readonly rows: readonly AdministrationRow[];
    readonly rates: MedicinesRates;
    readonly pending?: readonly PendingConflict[];
  },
  range: { readonly from: Date; readonly to: Date },
  at: Date,
  now: Date,
): Pick<MedicineRound, "doses" | "whenRequired"> {
  // The phone runs the same round on its synced rows (slice 69); the server holds every record, so
  // nothing here is "not on this device".
  const round = medicineRound({ ...facts, policy: UNCHECKED_POLICY }, range, at, now);
  return {
    doses: round.doses,
    whenRequired: round.whenRequired.map(({ lastDoseNotOnDevice: _, ...w }) => w),
  };
}

export type ConflictRow = typeof medicationAdministrationConflict.$inferSelect;
export const CONFLICT_TASK = "medicines.administration.conflict";
/** A routine conflict's review is due within a shift (a policy figure for the CSO, H-1271). */
export const ROUTINE_REVIEW_MS = 8 * 3_600_000;
const DIFFER_TITLE =
  "Two devices recorded different outcomes for one dose: review both records now";

const CONFLICT_MESSAGE =
  "This dose was already recorded on another device. Your record is kept for review by the person in charge.";

/**
 * The conflict a device's record was kept as, if it was (a resend finds it); "mismatch" when the
 * id was kept for another person, dose or outcome (security review L4).
 */
export async function conflictForClientRecord(
  tx: Transaction,
  clientRecordId: string,
  expect: {
    readonly personId: string;
    readonly entryId: string;
    readonly dueAt: string | null;
    readonly outcome: string;
  },
) {
  const [row] = await tx
    .select()
    .from(medicationAdministrationConflict)
    .where(eq(medicationAdministrationConflict.clientRecordId, clientRecordId));
  if (!row) return null;
  const sent = row.uploaded as { outcome?: string };
  if (
    row.personId !== expect.personId ||
    row.medicationId !== expect.entryId ||
    expect.dueAt === null ||
    row.dueAt.getTime() !== new Date(expect.dueAt).getTime() ||
    sent.outcome !== expect.outcome
  ) {
    return "mismatch" as const;
  }
  return {
    conflictId: row.joinsId ?? row.id,
    standingId: row.standingId,
    message: CONFLICT_MESSAGE,
  };
}

/**
 * Keeps a device's second record of a dose as a conflict and raises a review task for the nurse in
 * charge, urgent for a time-critical dose, in words that name no medicine (medicines.md 15.4).
 */
export async function raiseConflict(
  c: Context<AppEnv>,
  tx: Transaction,
  access: TenantAccess,
  e: {
    readonly personId: string;
    readonly locationId: string;
    readonly clientRecordId: string;
    readonly entry: MarEntry;
    readonly dueAt: Date;
    readonly standing: AdministrationRow;
    readonly uploaded: { readonly outcome: string } & Record<string, unknown>;
    readonly problems: readonly string[];
    readonly deviceAt: Date | null;
    readonly deviceOffsetMs: number | null;
    readonly rates: MedicinesRates;
  },
) {
  // One open conflict per dose and uploader: a further upload joins it (security review H1).
  const [open] = await tx
    .select()
    .from(medicationAdministrationConflict)
    .where(
      and(
        eq(medicationAdministrationConflict.personId, e.personId),
        eq(medicationAdministrationConflict.medicationId, e.entry.id),
        eq(medicationAdministrationConflict.dueAt, e.dueAt),
        eq(medicationAdministrationConflict.uploadedBy, access.tenantUserId),
        isNull(medicationAdministrationConflict.resolvedAt),
        isNull(medicationAdministrationConflict.joinsId),
      ),
    );
  // A further upload of the dose by the same person is kept beside the first, with its own client
  // id and payload so a resend finds it, and joins its review (security re-review M4).
  const [row] = await tx
    .insert(medicationAdministrationConflict)
    .values({
      personId: e.personId,
      clientRecordId: e.clientRecordId,
      medicationId: e.entry.id,
      dueAt: e.dueAt,
      standingId: e.standing.id,
      joinsId: open?.id ?? null,
      uploaded: e.uploaded,
      problems: [...e.problems],
      deviceAt: e.deviceAt,
      deviceOffsetMs: e.deviceOffsetMs,
      uploadedBy: access.tenantUserId,
    })
    .returning();
  if (open) {
    // A later upload that disagrees with the record that stands makes the review urgent (re-review M2).
    if (TAKEN.has(e.uploaded.outcome) !== TAKEN.has(e.standing.outcome)) {
      await tx
        .update(task)
        .set({ priority: "urgent", title: DIFFER_TITLE, dueAt: new Date() })
        .where(
          and(
            eq(task.kind, CONFLICT_TASK),
            eq(task.sourceId, open.id),
            eq(task.priority, "routine"),
            inArray(task.status, ["open", "in_progress"]),
          ),
        );
    }
    await auditInTx(tx, access, {
      action: "medicines.administration.conflict_joined",
      resourceType: "medication_administration_conflict",
      resourceId: open.id,
      scope: {
        personId: e.personId,
        joinedId: (row as ConflictRow).id,
        clientRecordId: e.clientRecordId,
        problems: e.problems,
      },
      requestId: c.get("requestId"),
    });
    return { conflictId: open.id, standingId: open.standingId, message: CONFLICT_MESSAGE };
  }
  const conflict = row as ConflictRow;
  // Urgent when the dose is time-critical or the two records disagree (one given, one not): until
  // reviewed the MAR shows only the first (clinical review H2).
  const timeCritical = isTimeCritical(e.entry);
  // One says taken and the other not (re-review M1).
  const differ = TAKEN.has(e.uploaded.outcome) !== TAKEN.has(e.standing.outcome);
  const urgent = timeCritical || differ;
  await tx.insert(task).values({
    kind: CONFLICT_TASK,
    title: differ
      ? DIFFER_TITLE
      : timeCritical
        ? "A time-critical dose was recorded twice on different devices: review both records now"
        : "A dose was recorded twice on different devices: review both records",
    requiredPermission: "medicines.record.manage",
    personId: e.personId,
    locationId: e.locationId,
    sourceType: "medication_administration_conflict",
    sourceId: conflict.id,
    assigneeRoleKey: "clinical_lead",
    // Escalation runs from the due time whatever the priority, so a routine duplicate is due within
    // the shift, not at once (re-review M3; H-1271).
    dueAt: urgent ? new Date() : new Date(Date.now() + ROUTINE_REVIEW_MS),
    priority: urgent ? "urgent" : "routine",
  });
  await auditInTx(tx, access, {
    action: "medicines.administration.conflict_raised",
    resourceType: "medication_administration_conflict",
    resourceId: conflict.id,
    scope: {
      personId: e.personId,
      standingId: e.standing.id,
      clientRecordId: e.clientRecordId,
      problems: e.problems,
      outcomesDiffer: differ,
    },
    requestId: c.get("requestId"),
  });
  await publish(tx, {
    context: "medicines",
    aggregateType: "medication_administration_conflict",
    aggregateId: conflict.id,
    type: "medicines.administration.conflict_raised",
    payload: { personId: e.personId, conflictId: conflict.id },
  });
  return { conflictId: conflict.id, standingId: e.standing.id, message: CONFLICT_MESSAGE };
}

/** An uploaded record as the device sent it: all of it, for the reviewer (re-review L6). */
function uploadedOut(row: ConflictRow) {
  const up = row.uploaded as {
    id: string;
    outcome: string;
    amount?: { quantity: number; unitCode: string } | null;
    reason?: { code: string; note?: string | null } | null;
    givenAt?: string | null;
    timingReason?: string | null;
    amountDifferenceReason?: string | null;
    givenBy?: string | null;
    givenBeforeRecorded?: { reason: string } | null;
  };
  return {
    id: up.id,
    outcome: up.outcome as "given",
    amount: up.amount ?? null,
    reason: up.reason ? { code: up.reason.code, note: up.reason.note ?? null } : null,
    givenAt: up.givenAt ?? null,
    timingReason: up.timingReason ?? null,
    amountDifferenceReason: up.amountDifferenceReason ?? null,
    givenBy: up.givenBy ?? null,
    givenBeforeRecordedReason: up.givenBeforeRecorded?.reason ?? null,
    problems: [...row.problems],
    deviceAt: row.deviceAt?.toISOString() ?? null,
    uploadedBy: row.uploadedBy,
    receivedAt: row.receivedAt.toISOString(),
  };
}

/** The further uploads that joined a conflict, oldest first. */
export function joinedTo(tx: Transaction, conflictId: string): Promise<ConflictRow[]> {
  return tx
    .select()
    .from(medicationAdministrationConflict)
    .where(eq(medicationAdministrationConflict.joinsId, conflictId))
    .orderBy(asc(medicationAdministrationConflict.receivedAt));
}

/** Whether the entry's product has a controlled drug schedule (as the routes' isControlledDrug). */
async function controlledDrugEntry(tx: Transaction, entryId: string): Promise<boolean> {
  const [row] = await tx
    .select({ cd: medication.cdSchedule })
    .from(medication)
    .where(eq(medication.id, entryId));
  return Boolean(row?.cd);
}

/** A conflict with both records (and any further uploads), for the nurse in charge. */
export async function conflictOut(
  tx: Transaction,
  row: ConflictRow,
  rows: readonly AdministrationRow[],
) {
  const standing = rows.find((r) => r.id === row.standingId) as AdministrationRow;
  const first = uploadedOut(row);
  // The latest record for the dose, through any corrections, so the reader corrects that one.
  const later = supersededBy(rows);
  let current = standing;
  for (let i = 0; later.has(current.id) && i < rows.length; i++) {
    current = rows.find((r) => r.id === later.get(current.id)) ?? current;
  }
  const witnesses = await witnessesFor(tx, [...new Set([standing.id, current.id])]);
  return {
    id: row.id,
    personId: row.personId,
    entryId: row.medicationId,
    dueAt: row.dueAt.toISOString(),
    standing: administrationOut(standing, later, witnesses),
    current: administrationOut(current, later, witnesses),
    controlledDrug: await controlledDrugEntry(tx, row.medicationId),
    uploaded: first,
    joined: (await joinedTo(tx, row.id)).map(uploadedOut),
    problems: first.problems,
    deviceAt: first.deviceAt,
    uploadedBy: row.uploadedBy,
    receivedAt: first.receivedAt,
    resolution:
      row.resolvedAt && row.resolvedBy && row.resolution
        ? {
            outcome: row.resolution as "first_stands" | "corrected" | "both_given",
            correctionId: row.correctionId,
            note: row.resolutionNote ?? "",
            by: row.resolvedBy,
            at: row.resolvedAt.toISOString(),
          }
        : null,
  };
}

export const RETROSPECTIVE_TASK = "medicines.administration.conflict_retrospective";

/**
 * Everyone who took part in a conflict's dose: its uploaders and the givers they named, who
 * recorded and gave the record that stood and the record that stands now, and who recorded the
 * correction named in the decision. Used to mark a self-review and to keep each of them from
 * closing its retrospective review (clinical reviews B1 and recheck).
 */
export function conflictParties(
  row: ConflictRow,
  joined: readonly ConflictRow[],
  rows: readonly AdministrationRow[],
  correctionId: string | null,
): (string | null | undefined)[] {
  const standing = rows.find((r) => r.id === row.standingId);
  const later = supersededBy(rows);
  let current = standing;
  for (let i = 0; current && later.has(current.id) && i < rows.length; i++) {
    const nextId = later.get(current.id);
    current = rows.find((r) => r.id === nextId) ?? current;
  }
  const named = correctionId ? rows.find((r) => r.id === correctionId) : undefined;
  return [
    row.uploadedBy,
    ...joined.map((r) => r.uploadedBy),
    ...[row, ...joined].map((r) => (r.uploaded as { givenBy?: string | null }).givenBy),
    standing?.recordedBy,
    standing?.administeredBy,
    current?.recordedBy,
    current?.administeredBy,
    named?.recordedBy,
  ];
}

/**
 * Why someone may not close a self-reviewed conflict's retrospective review: they decided it, or
 * took part in its dose (`conflictParties`), so the review would not be independent.
 */
export async function retrospectiveRefusal(
  tx: Transaction,
  tenantUserId: string,
  conflictId: string | null,
): Promise<string | null> {
  if (!conflictId) return null;
  const [row] = await tx
    .select()
    .from(medicationAdministrationConflict)
    .where(eq(medicationAdministrationConflict.id, conflictId));
  if (!row) return "missing_permission";
  const rows = await personAdministrations(tx, row.personId);
  // Refuse when the records cannot be seen: the check is never skipped (security recheck).
  if (
    !rows.some((r) => r.id === row.standingId) ||
    (row.correctionId !== null && !rows.some((r) => r.id === row.correctionId))
  ) {
    return "missing_permission";
  }
  const parties = conflictParties(row, await joinedTo(tx, conflictId), rows, row.correctionId);
  return [row.resolvedBy, ...parties].includes(tenantUserId) ? "own_decision" : null;
}
