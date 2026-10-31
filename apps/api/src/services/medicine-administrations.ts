import type { AdministrationOut, DosingRecordOut } from "@harbour/contracts";
import {
  medication,
  medicationAdministration,
  medicationAdministrationWitness,
  medicationDosingRecord,
  type Transaction,
  task,
} from "@harbour/db";
import {
  type AdministrationEscalation,
  type AdministrationOutcome,
  DOSE_TAKEN_OUTCOMES,
  type DosingRecord,
  doseWindow,
  entryVersionIds,
  escalationAt,
  type GivenDose,
  isClosedRecord,
  isTimeCritical,
  type MarEntry,
  type MarSourceDocument,
  MEDICINES_RATE_KEYS,
  type MedicinesRates,
  marEntryDoses,
  OUTCOME_WORDS,
  type PersonStatus,
  type RateNation,
  REASON_WORDS,
  REVIEW_FLAG_WORDS,
  type ReviewFlag,
  resolveMedicinesRates,
  ukIsoDate,
} from "@harbour/domain";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { personEntries } from "./medicines";
import { loadPerson } from "./people";
import { rateRows } from "./rates";

/**
 * Between the administrations tables and slice 3's rules (medicines.md section 13; slice 22):
 * the facts the rules need (rates, the doses taken, the dosing records), the effective record for
 * each dose (corrections replace what they correct), the output, and the escalation tasks.
 */

export type AdministrationRow = typeof medicationAdministration.$inferSelect;
type DosingRow = typeof medicationDosingRecord.$inferSelect;
type WitnessRow = typeof medicationAdministrationWitness.$inferSelect;

/** Every medicines figure for the person's nation on a date, as numbers (the table stores text). */
export async function medicinesRates(
  tx: Transaction,
  tenantId: string,
  nation: Exclude<RateNation, "uk" | "all">,
  on: string,
): Promise<MedicinesRates> {
  const rows = await rateRows(tx, Object.values(MEDICINES_RATE_KEYS));
  const resolved = resolveMedicinesRates(rows, nation, on, tenantId);
  return Object.fromEntries(
    Object.entries(resolved).map(([k, v]) => [k, Number(v)]),
  ) as unknown as MedicinesRates;
}

/** Every administration of the person, oldest first. */
export async function personAdministrations(
  tx: Transaction,
  personId: string,
): Promise<AdministrationRow[]> {
  return tx
    .select()
    .from(medicationAdministration)
    .where(eq(medicationAdministration.personId, personId))
    .orderBy(asc(medicationAdministration.givenAt), asc(medicationAdministration.recordedAt));
}

/** Which record corrects each record (the correction's id), if any. */
export function supersededBy(rows: readonly AdministrationRow[]): Map<string, string> {
  return new Map(
    rows.filter((r) => r.supersedesId !== null).map((r) => [r.supersedesId as string, r.id]),
  );
}

/** The records nothing corrects: what the MAR says happened. */
export function effective(rows: readonly AdministrationRow[]): AdministrationRow[] {
  const corrected = supersededBy(rows);
  return rows.filter((r) => !corrected.has(r.id));
}

/** The doses the person took, from the effective records, for intervals and the 24-hour total. */
export function givenDoses(
  rows: readonly AdministrationRow[],
  entries: ReadonlyMap<string, MarEntry>,
): GivenDose[] {
  return effective(rows)
    .filter(
      (r) =>
        DOSE_TAKEN_OUTCOMES.has(r.outcome as AdministrationOutcome) &&
        r.quantity !== null &&
        r.unitCode !== null,
    )
    .map((r) => ({
      id: r.id,
      entryId: r.medicationId,
      tags: entries.get(r.medicationId)?.tags ?? [],
      at: r.givenAt,
      quantity: Number(r.quantity),
      unitCode: r.unitCode as string,
      by: r.recordedBy,
      synced: true,
    }));
}

/** The person's dosing records, as the rules read them. */
export async function personDosingRecords(
  tx: Transaction,
  personId: string,
): Promise<DosingRecord[]> {
  const rows = await tx
    .select()
    .from(medicationDosingRecord)
    .where(eq(medicationDosingRecord.personId, personId))
    .orderBy(asc(medicationDosingRecord.recordedAt));
  return rows.map(dosingRecordOf);
}

export function dosingRecordOf(r: DosingRow): DosingRecord {
  return {
    id: r.id,
    personId: r.personId,
    entryId: r.medicationId,
    source: {
      kind: r.sourceKind as MarSourceDocument["kind"],
      reference: r.sourceReference,
      documentId: r.sourceDocumentId,
    },
    doses: r.doses as DosingRecord["doses"],
    recordedBy: r.recordedBy,
    recordedAt: r.recordedAt,
    secondCheck:
      r.checkBy && r.checkAt
        ? {
            by: r.checkBy,
            at: r.checkAt,
            outcome: r.checkOutcome as "matches_source" | "differs_from_source",
            difference: r.checkDifference,
          }
        : null,
  };
}

export function dosingRecordOut(r: DosingRecord): DosingRecordOut {
  return {
    id: r.id,
    personId: r.personId,
    entryId: r.entryId,
    source: { kind: r.source.kind, reference: r.source.reference, documentId: r.source.documentId },
    doses: r.doses.map((d) => ({ date: d.date, time: d.time, quantity: d.quantity })),
    recorded: { id: r.recordedBy, at: r.recordedAt.toISOString() },
    secondCheck: r.secondCheck
      ? {
          id: r.secondCheck.by,
          at: r.secondCheck.at.toISOString(),
          outcome: r.secondCheck.outcome,
          difference: r.secondCheck.difference,
        }
      : null,
  };
}

const FLAG_WORDS: Readonly<Record<string, string>> = {
  ...REVIEW_FLAG_WORDS,
  early: "given early, with a reason",
  late: "given late, with a reason",
  interval_override: "given within the minimum interval, with a reason",
  competence_override: "recorded under a competence override",
  amount_differs: "the amount differs from the prescribed dose",
  entry_not_yet_checked: "the entry had not been checked yet",
  other_unit_not_counted: "a dose in another unit is not in the 24-hour total",
  over_maximum: "more than the most allowed in 24 hours was taken",
  given_before_recorded: "recorded after it was given",
  clock_drift: "the device clock was far from Harbour's",
};

export function flagWords(flags: readonly string[]): string[] {
  return flags.map((f) => FLAG_WORDS[f as ReviewFlag] ?? f);
}

export async function witnessesFor(
  tx: Transaction,
  ids: readonly string[],
): Promise<Map<string, WitnessRow>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select()
    .from(medicationAdministrationWitness)
    .where(inArray(medicationAdministrationWitness.administrationId, [...ids]));
  return new Map(rows.map((w) => [w.administrationId, w]));
}

export function administrationOut(
  r: AdministrationRow,
  correctedBy: ReadonlyMap<string, string>,
  witnesses: ReadonlyMap<string, WitnessRow>,
): AdministrationOut {
  const w = witnesses.get(r.id);
  return {
    id: r.id,
    personId: r.personId,
    entryId: r.medicationId,
    dueAt: r.dueAt?.toISOString() ?? null,
    outcome: r.outcome as AdministrationOut["outcome"],
    outcomeInWords: OUTCOME_WORDS[r.outcome as AdministrationOutcome] ?? r.outcome,
    reason: r.reasonCode
      ? {
          code: r.reasonCode,
          words: REASON_WORDS[r.reasonCode] ?? r.reasonCode,
          note: r.reasonNote,
        }
      : null,
    amount:
      r.quantity !== null && r.unitCode !== null
        ? { quantity: Number(r.quantity), unitCode: r.unitCode }
        : null,
    prescribed: (r.prescribed as AdministrationOut["prescribed"]) ?? null,
    dosingRecordId: r.dosingRecordId,
    givenAt: r.givenAt.toISOString(),
    recorded: { id: r.recordedBy, at: r.recordedAt.toISOString() },
    flags: [...r.flags],
    flagsInWords: flagWords(r.flags),
    givenBeforeRecordedReason: r.givenBeforeRecordedReason,
    supersedesId: r.supersedesId,
    correctionReason: r.correctionReason,
    supersededById: correctedBy.get(r.id) ?? null,
    witness: w
      ? {
          id: w.witnessId,
          at: w.witnessedAt.toISOString(),
          method: w.method as "step_up" | "device_factor",
        }
      : null,
  };
}

export const REVIEW_TASK = "medicines.administration.review";
export const OVER_MAXIMUM_TASK = "medicines.administration.over_maximum";
export const OUTSTANDING_DOSE_TASK = "medicines.dose.outstanding";

/**
 * The tasks an administration's escalations raise for the nurse in charge (medicines.md 13.6):
 * `urgent` over the 24-hour maximum, `warning` for a record to review. Words, never the medicine
 * or the dose, so a task list shows nothing clinical; the record is the task's evidence.
 */
export async function raiseEscalationTasks(
  tx: Transaction,
  input: {
    readonly personId: string;
    readonly locationId: string;
    readonly administrationId: string;
    readonly escalations: readonly AdministrationEscalation[];
    readonly at: Date;
  },
): Promise<{ severity: "urgent" | "warning"; message: string; taskId: string }[]> {
  const raised: { severity: "urgent" | "warning"; message: string; taskId: string }[] = [];
  for (const e of input.escalations) {
    const urgent = e.severity === "urgent";
    const [row] = await tx
      .insert(task)
      .values({
        kind: urgent ? OVER_MAXIMUM_TASK : REVIEW_TASK,
        title: urgent
          ? "More than the most allowed in 24 hours has been taken: review now"
          : "Review a medicines record flagged for the nurse in charge",
        requiredPermission: "medicines.record.manage",
        personId: input.personId,
        locationId: input.locationId,
        sourceType: "medication_administration",
        sourceId: input.administrationId,
        assigneeRoleKey: "clinical_lead",
        dueAt: input.at,
        priority: urgent ? "urgent" : "routine",
        details: { reason: e.reason },
      })
      .returning({ id: task.id });
    raised.push({ severity: e.severity, message: e.message, taskId: (row as { id: string }).id });
  }
  return raised;
}

/** An outstanding dose's task is done once an outcome is recorded for it (13.6). */
export async function closeOutstandingDoseTask(
  tx: Transaction,
  input: {
    readonly entryIds: readonly string[];
    readonly dueAt: Date;
    readonly administrationId: string;
    readonly by: string;
    readonly at: Date;
  },
) {
  if (input.entryIds.length === 0) return;
  await tx
    .update(task)
    .set({
      status: "done",
      completedAt: input.at,
      completedBy: input.by,
      evidenceType: "medication_administration",
      evidenceId: input.administrationId,
    })
    .where(
      and(
        eq(task.kind, OUTSTANDING_DOSE_TASK),
        eq(task.sourceType, "medication"),
        inArray(task.sourceId, [...input.entryIds]),
        eq(task.dueAt, input.dueAt),
        inArray(task.status, ["open", "in_progress"]),
      ),
    );
}

/**
 * Outstanding doses (rule 15; medicines.md 13.6): one task per scheduled dose in the last 24 hours
 * whose escalation time (the end of its window) has passed with no outcome, for the nurse in
 * charge, time-critical doses urgent, never twice. The dose stays outstanding until someone
 * records what happened; nothing makes it due again.
 */
export async function raiseOutstandingDoseTasks(
  tx: Transaction,
  tenantId: string,
  now: Date,
): Promise<number> {
  const people = await tx
    .selectDistinct({ personId: medication.personId })
    .from(medication)
    .where(isNull(medication.deletedAt));
  const ratesByNation = new Map<string, MedicinesRates>();
  let raised = 0;
  for (const { personId } of people) {
    const person = await loadPerson(tx, personId).catch(() => null);
    if (!person || isClosedRecord(person.status as PersonStatus)) continue;
    const rates =
      ratesByNation.get(person.nation) ??
      (await medicinesRates(tx, tenantId, person.nation, ukIsoDate(now)));
    ratesByNation.set(person.nation, rates);
    const entries = (await personEntries(tx, personId)).map((s) => s.entry);
    const recorded = effective(await personAdministrations(tx, personId));
    for (const entry of entries) {
      const versionIds = entryVersionIds(entry, entries);
      const doses = marEntryDoses(entry, { from: new Date(now.getTime() - DAY_MS), to: now });
      for (const dose of doses) {
        const window = doseWindow(dose.dueAt, isTimeCritical(entry), rates);
        if (escalationAt(window).getTime() > now.getTime()) continue;
        const done = recorded.some(
          (r) => versionIds.has(r.medicationId) && r.dueAt?.getTime() === dose.dueAt.getTime(),
        );
        if (done) continue;
        const [already] = await tx
          .select({ id: task.id })
          .from(task)
          .where(
            and(
              eq(task.kind, OUTSTANDING_DOSE_TASK),
              eq(task.sourceType, "medication"),
              inArray(task.sourceId, [...versionIds]),
              eq(task.dueAt, dose.dueAt),
            ),
          )
          .limit(1);
        if (already) continue;
        await tx.insert(task).values({
          kind: OUTSTANDING_DOSE_TASK,
          title: window.timeCritical
            ? "A time-critical dose has no outcome: find out what happened and record it"
            : "A dose has no outcome: find out what happened and record it",
          requiredPermission: "medicines.emar.administer",
          personId,
          locationId: person.locationId,
          sourceType: "medication",
          sourceId: entry.id,
          assigneeRoleKey: "clinical_lead",
          dueAt: dose.dueAt,
          windowEnd: window.lateAfter,
          priority: window.timeCritical ? "urgent" : "routine",
          details: { dueAt: dose.dueAt.toISOString(), timeCritical: window.timeCritical },
        });
        raised += 1;
      }
    }
  }
  return raised;
}

const DAY_MS = 86_400_000;
