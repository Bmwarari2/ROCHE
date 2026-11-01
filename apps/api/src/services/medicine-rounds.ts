import type { MedicineRound } from "@harbour/contracts";
import { medicationAdministrationConflict, type Transaction, task } from "@harbour/db";
import {
  doseNotices,
  doseWindow,
  entryVersionIds,
  formatDose,
  isTimeCritical,
  type MarEntry,
  type MedicinesRates,
  marEntryDoses,
  marEntryStatus,
  prnStatus,
  SCHEDULED_DOSE_WORDS,
  scheduledDoseState,
} from "@harbour/domain";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx } from "../http/audit";
import type { AppEnv, TenantAccess } from "../http/context";
import { publish } from "../outbox";
import {
  type AdministrationRow,
  administrationOut,
  effective,
  givenDoses,
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
export function roundFor(
  facts: {
    readonly entries: readonly MarEntry[];
    readonly rows: readonly AdministrationRow[];
    readonly rates: MedicinesRates;
  },
  range: { readonly from: Date; readonly to: Date },
  at: Date,
  now: Date,
): Pick<MedicineRound, "doses" | "whenRequired"> {
  const eff = effective(facts.rows);
  const history = givenDoses(facts.rows, new Map(facts.entries.map((e) => [e.id, e])));
  const doses = facts.entries
    .flatMap((entry) => {
      const versionIds = entryVersionIds(entry, facts.entries);
      const status = marEntryStatus(entry, at, UNCHECKED_POLICY);
      return marEntryDoses(entry, range).map((d) => {
        const window = doseWindow(d.dueAt, isTimeCritical(entry), facts.rates);
        const recorded = eff.some(
          (r) => versionIds.has(r.medicationId) && r.dueAt?.getTime() === d.dueAt.getTime(),
        );
        const state = scheduledDoseState(window, recorded, now);
        return {
          entryId: entry.id,
          productName: entry.product.name,
          dueAt: d.dueAt.toISOString(),
          date: d.date,
          time: d.time,
          doseInWords: formatDose(d.dose),
          timeCritical: window.timeCritical,
          state,
          stateInWords: SCHEDULED_DOSE_WORDS[state],
          opensAt: window.opensAt.toISOString(),
          lateAfter: window.lateAfter.toISOString(),
          notices: [...doseNotices(entry, facts.rates)],
          entryStatus: status,
        };
      });
    })
    // Time-critical doses first (HZ-003), then by due time.
    .sort(
      (a, b) => Number(b.timeCritical) - Number(a.timeCritical) || a.dueAt.localeCompare(b.dueAt),
    );
  const whenRequired = facts.entries
    .filter(
      (e) =>
        e.directions.kind === "when_required" &&
        e.withdrawn === null &&
        marEntryStatus(e, at, UNCHECKED_POLICY).mayGive,
    )
    .map((entry) => {
      const s = prnStatus(entry, entryVersionIds(entry, facts.entries), history, at, facts.rates);
      return {
        entryId: entry.id,
        productName: entry.product.name,
        lastGiven: s.lastGiven
          ? { at: s.lastGiven.at.toISOString(), by: s.lastGiven.by, synced: s.lastGiven.synced }
          : null,
        givenInLast24Hours: s.givenInLast24Hours,
        maxPer24Hours: s.maxPer24Hours,
        remaining: s.remaining,
        nextAllowedAt: s.nextAllowedAt?.toISOString() ?? null,
        notices: [...s.notices],
      };
    });
  return { doses, whenRequired };
}

export type ConflictRow = typeof medicationAdministrationConflict.$inferSelect;
export const CONFLICT_TASK = "medicines.administration.conflict";

const CONFLICT_MESSAGE =
  "This dose was already recorded on another device. Your record is kept for the nurse in charge to review; it is not added to the MAR until they decide.";

/** The conflict a device's record was kept as, if it was (a resend finds it). */
export async function conflictForClientRecord(tx: Transaction, clientRecordId: string) {
  const [row] = await tx
    .select()
    .from(medicationAdministrationConflict)
    .where(eq(medicationAdministrationConflict.clientRecordId, clientRecordId));
  return row ? { conflictId: row.id, standingId: row.standingId, message: CONFLICT_MESSAGE } : null;
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
    readonly uploaded: unknown;
    readonly deviceAt: Date | null;
    readonly deviceOffsetMs: number | null;
    readonly rates: MedicinesRates;
  },
) {
  const [row] = await tx
    .insert(medicationAdministrationConflict)
    .values({
      personId: e.personId,
      clientRecordId: e.clientRecordId,
      medicationId: e.entry.id,
      dueAt: e.dueAt,
      standingId: e.standing.id,
      uploaded: e.uploaded,
      deviceAt: e.deviceAt,
      deviceOffsetMs: e.deviceOffsetMs,
      uploadedBy: access.tenantUserId,
    })
    .returning();
  const conflict = row as ConflictRow;
  const timeCritical = isTimeCritical(e.entry);
  await tx.insert(task).values({
    kind: CONFLICT_TASK,
    title: timeCritical
      ? "A time-critical dose was recorded twice on different devices: review both records now"
      : "A dose was recorded twice on different devices: review both records",
    requiredPermission: "medicines.record.manage",
    personId: e.personId,
    locationId: e.locationId,
    sourceType: "medication_administration_conflict",
    sourceId: conflict.id,
    assigneeRoleKey: "clinical_lead",
    dueAt: new Date(),
    priority: timeCritical ? "urgent" : "routine",
  });
  await auditInTx(tx, access, {
    action: "medicines.administration.conflict_raised",
    resourceType: "medication_administration_conflict",
    resourceId: conflict.id,
    scope: { personId: e.personId, standingId: e.standing.id, clientRecordId: e.clientRecordId },
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

/** A conflict with both records, for the nurse in charge. */
export async function conflictOut(
  tx: Transaction,
  row: ConflictRow,
  rows: readonly AdministrationRow[],
) {
  const standing = rows.find((r) => r.id === row.standingId) as AdministrationRow;
  const up = row.uploaded as {
    id: string;
    outcome: string;
    amount: { quantity: number; unitCode: string } | null;
    reason: { code: string; note: string | null } | null;
    givenAt: string | null;
  };
  return {
    id: row.id,
    personId: row.personId,
    entryId: row.medicationId,
    dueAt: row.dueAt.toISOString(),
    standing: administrationOut(
      standing,
      supersededBy(rows),
      await witnessesFor(tx, [standing.id]),
    ),
    uploaded: {
      id: up.id,
      outcome: up.outcome as "given",
      amount: up.amount ?? null,
      reason: up.reason ? { code: up.reason.code, note: up.reason.note ?? null } : null,
      givenAt: up.givenAt ?? null,
    },
    deviceAt: row.deviceAt?.toISOString() ?? null,
    uploadedBy: row.uploadedBy,
    receivedAt: row.receivedAt.toISOString(),
    resolution:
      row.resolvedAt && row.resolvedBy && row.resolution
        ? {
            outcome: row.resolution as "first_stands" | "corrected",
            correctionId: row.correctionId,
            note: row.resolutionNote ?? "",
            by: row.resolvedBy,
            at: row.resolvedAt.toISOString(),
          }
        : null,
  };
}
