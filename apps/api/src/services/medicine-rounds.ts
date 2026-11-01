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
import { and, eq, isNull } from "drizzle-orm";
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
const STATE_ORDER = { late: 0, due: 1, not_yet_due: 2, recorded: 3 } as const;

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
      // The slot's doses, and any dose in the 24 hours before it still late with no outcome, so an
      // earlier missed dose is never off the round (clinical review M4).
      const reach = { from: new Date(range.from.getTime() - 86_400_000), to: range.to };
      return marEntryDoses(entry, reach).flatMap((d) => {
        const window = doseWindow(d.dueAt, isTimeCritical(entry), facts.rates);
        const recorded = eff.some(
          (r) => versionIds.has(r.medicationId) && r.dueAt?.getTime() === d.dueAt.getTime(),
        );
        const state = scheduledDoseState(window, recorded, now);
        if (d.dueAt.getTime() < range.from.getTime() && state !== "late") return [];
        return [
          {
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
          },
        ];
      });
    })
    // Late first, then due now, then not due yet, then recorded; time-critical first within each
    // (HZ-003; clinical review M5), then by due time.
    .sort(
      (a, b) =>
        STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
        Number(b.timeCritical) - Number(a.timeCritical) ||
        a.dueAt.localeCompare(b.dueAt),
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
  return { conflictId: row.id, standingId: row.standingId, message: CONFLICT_MESSAGE };
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
      ),
    );
  if (open) return { conflictId: open.id, standingId: open.standingId, message: CONFLICT_MESSAGE };
  const [row] = await tx
    .insert(medicationAdministrationConflict)
    .values({
      personId: e.personId,
      clientRecordId: e.clientRecordId,
      medicationId: e.entry.id,
      dueAt: e.dueAt,
      standingId: e.standing.id,
      uploaded: e.uploaded,
      problems: [...e.problems],
      deviceAt: e.deviceAt,
      deviceOffsetMs: e.deviceOffsetMs,
      uploadedBy: access.tenantUserId,
    })
    .returning();
  const conflict = row as ConflictRow;
  // Urgent when the dose is time-critical or the two records disagree (one given, one not): until
  // reviewed the MAR shows only the first (clinical review H2).
  const timeCritical = isTimeCritical(e.entry);
  const differ = e.uploaded.outcome !== e.standing.outcome;
  await tx.insert(task).values({
    kind: CONFLICT_TASK,
    title: differ
      ? "Two devices recorded different outcomes for one dose: review both records now"
      : timeCritical
        ? "A time-critical dose was recorded twice on different devices: review both records now"
        : "A dose was recorded twice on different devices: review both records",
    requiredPermission: "medicines.record.manage",
    personId: e.personId,
    locationId: e.locationId,
    sourceType: "medication_administration_conflict",
    sourceId: conflict.id,
    assigneeRoleKey: "clinical_lead",
    dueAt: new Date(),
    priority: timeCritical || differ ? "urgent" : "routine",
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
    problems: [...row.problems],
    deviceAt: row.deviceAt?.toISOString() ?? null,
    uploadedBy: row.uploadedBy,
    receivedAt: row.receivedAt.toISOString(),
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
