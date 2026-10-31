import type { MedicineEntry } from "@harbour/contracts";
import { document, medication, medicationSchedule, type Transaction } from "@harbour/db";
import {
  type Dose,
  describeSchedule,
  formatDose,
  type MarEntry,
  type MarEntryState,
  type MarSourceDocument,
  marEntryStatus,
  type RegularSchedule,
  type SchedulePattern,
  type UncheckedEntryPolicy,
} from "@harbour/domain";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { HttpProblem, problems } from "../http/problem";

/**
 * Between the medicines tables and the slice 2 domain (medicines.md section 2; slice 16). The
 * domain decides; this module only turns rows into `MarEntry` values and back. The API passes the
 * rules every version it holds (`versions`, `entryVersions`, `earlierEntries`), never a subset
 * (#135 sixth review), and tries them at the time of recording (HZ-010).
 */

type MedicationRow = typeof medication.$inferSelect;
type ScheduleRow = typeof medicationSchedule.$inferSelect;

/**
 * Tenant policy for entries awaiting their second check (H-550). Until a tenant setting exists the
 * default in force applies: give with the notice beside it.
 */
export const UNCHECKED_POLICY: UncheckedEntryPolicy = "give_with_notice";

export interface StoredEntry {
  readonly entry: MarEntry;
  readonly medicineId: string;
}

const num = (value: string | null): number => Number(value);

function doseOf(row: ScheduleRow): Dose {
  const unit = { code: row.unitCode, name: row.unitName };
  if (row.doseKind === "range") {
    return { kind: "range", from: num(row.fromQuantity), to: num(row.toQuantity), unit };
  }
  if (row.doseKind === "variable") return { kind: "variable", unit };
  return { kind: "amount", quantity: num(row.quantity), unit };
}

function patternOf(row: MedicationRow): SchedulePattern {
  switch (row.patternKind) {
    case "every_n_days":
      return {
        kind: "every_n_days",
        intervalDays: row.intervalDays ?? 0,
        anchorOn: row.anchorOn ?? "",
      };
    case "weekly":
      return {
        kind: "weekly",
        weekdays: (row.weekdays ?? []) as Extract<SchedulePattern, { kind: "weekly" }>["weekdays"],
        intervalWeeks: row.intervalWeeks ?? 1,
        anchorOn: row.anchorOn ?? "",
      };
    case "monthly":
      return { kind: "monthly", dayOfMonth: row.dayOfMonth ?? 1 };
    default:
      return { kind: "every_day" };
  }
}

const source = (kind: string, reference: string, documentId: string | null): MarSourceDocument => ({
  kind: kind as MarSourceDocument["kind"],
  reference,
  documentId,
});

export function entryOf(row: MedicationRow, times: readonly ScheduleRow[]): MarEntry {
  return {
    id: row.id,
    personId: row.personId,
    version: row.version,
    origin: row.origin as MarEntry["origin"],
    state: row.state as MarEntryState,
    product: { vmpId: row.vmpId, ampId: row.ampId, name: row.productName },
    route: { code: row.routeCode, name: row.routeName },
    directions:
      row.directions === "regular"
        ? {
            kind: "regular",
            schedule: {
              pattern: patternOf(row),
              times: [...times]
                .sort((a, b) => a.position - b.position)
                .map((t) => ({ time: t.time, dose: doseOf(t) })),
            },
          }
        : {
            kind: "when_required",
            dose: row.prnDose as Dose,
            maxQuantityPer24Hours: row.prnMaxPer24h === null ? null : Number(row.prnMaxPer24h),
          },
    tags: (row.tags ?? []) as MarEntry["tags"],
    minimumIntervalMinutes: row.minimumIntervalMinutes,
    indication: row.indication,
    specialInstructions: row.specialInstructions,
    prescriber: row.prescriber,
    startsAt: row.startsAt,
    stopsAt: row.stopsAt,
    reviewOn: row.reviewOn,
    source: source(row.sourceKind, row.sourceReference, row.sourceDocumentId),
    transcribedBy: row.transcribedBy,
    transcribedAt: row.transcribedAt,
    replacesId: row.replacesId,
    secondCheck:
      row.checkBy && row.checkAt
        ? {
            by: row.checkBy,
            at: row.checkAt,
            outcome: row.checkOutcome as "matches_source" | "differs_from_source",
            difference: row.checkDifference,
          }
        : null,
    stop:
      row.stopBy && row.stopAt && row.stopEffectiveAt
        ? {
            by: row.stopBy,
            at: row.stopAt,
            effectiveAt: row.stopEffectiveAt,
            reason: row.stopReason ?? "",
            source: source(
              row.stopSourceKind ?? "",
              row.stopSourceReference ?? "",
              row.stopSourceDocumentId,
            ),
          }
        : null,
    replacedById: row.replacedById,
    replacedFrom: row.replacedFrom,
    reanchor:
      row.reanchorBy && row.reanchorAt
        ? { by: row.reanchorBy, at: row.reanchorAt, reason: row.reanchorReason ?? "" }
        : null,
    withdrawn:
      row.withdrawnBy && row.withdrawnAt
        ? { by: row.withdrawnBy, at: row.withdrawnAt, reason: row.withdrawnReason ?? "" }
        : null,
    correctedPartWayThrough: row.correctedPartWayThrough,
    earlierDosesDue:
      row.earlierDosesDueOn && row.earlierDosesDueReason
        ? { date: row.earlierDosesDueOn, reason: row.earlierDosesDueReason }
        : null,
  };
}

/** Every version of every medicine the person has, with each version's medicine. */
export async function personEntries(tx: Transaction, personId: string): Promise<StoredEntry[]> {
  const rows = await tx
    .select()
    .from(medication)
    .where(and(eq(medication.personId, personId), isNull(medication.deletedAt)))
    .orderBy(asc(medication.transcribedAt), asc(medication.version));
  if (rows.length === 0) return [];
  const times = await tx
    .select()
    .from(medicationSchedule)
    .where(
      inArray(
        medicationSchedule.medicationId,
        rows.map((r) => r.id),
      ),
    );
  return rows.map((row) => ({
    entry: entryOf(
      row,
      times.filter((t) => t.medicationId === row.id),
    ),
    medicineId: row.medicineId,
  }));
}

function patternColumns(schedule: RegularSchedule | null) {
  const p = schedule?.pattern;
  return {
    patternKind: p?.kind ?? null,
    intervalDays: p?.kind === "every_n_days" ? p.intervalDays : null,
    weekdays: p?.kind === "weekly" ? [...p.weekdays] : null,
    intervalWeeks: p?.kind === "weekly" ? p.intervalWeeks : null,
    anchorOn: p && "anchorOn" in p ? p.anchorOn : null,
    dayOfMonth: p?.kind === "monthly" ? p.dayOfMonth : null,
  };
}

const setOnce = (e: MarEntry) => ({
  state: e.state,
  checkBy: e.secondCheck?.by ?? null,
  checkAt: e.secondCheck?.at ?? null,
  checkOutcome: e.secondCheck?.outcome ?? null,
  checkDifference: e.secondCheck?.difference ?? null,
  stopBy: e.stop?.by ?? null,
  stopAt: e.stop?.at ?? null,
  stopEffectiveAt: e.stop?.effectiveAt ?? null,
  stopReason: e.stop?.reason ?? null,
  stopSourceKind: e.stop?.source.kind ?? null,
  stopSourceReference: e.stop?.source.reference ?? null,
  stopSourceDocumentId: e.stop?.source.documentId ?? null,
  replacedById: e.replacedById,
  replacedFrom: e.replacedFrom,
  withdrawnBy: e.withdrawn?.by ?? null,
  withdrawnAt: e.withdrawn?.at ?? null,
  withdrawnReason: e.withdrawn?.reason ?? null,
});

/**
 * Writes a new version (a transcription, a change, a start): the row and its times together. Its
 * stop, when a change carried one over (rule 6b), is written with it; the state stays
 * `not_yet_checked` (the trigger refuses anything else on a new row), as the domain gives it.
 */
export async function insertEntry(
  tx: Transaction,
  entry: MarEntry,
  medicineId: string,
  links: { reconciliationId?: string | null; importBatchId?: string | null } = {},
): Promise<void> {
  const d = entry.directions;
  const once = setOnce(entry);
  await tx.insert(medication).values({
    id: entry.id,
    personId: entry.personId,
    medicineId,
    version: entry.version,
    replacesId: entry.replacesId,
    origin: entry.origin,
    vmpId: entry.product.vmpId,
    ampId: entry.product.ampId,
    productName: entry.product.name,
    routeCode: entry.route.code,
    routeName: entry.route.name,
    directions: d.kind,
    ...patternColumns(d.kind === "regular" ? d.schedule : null),
    prnDose: d.kind === "when_required" ? d.dose : null,
    prnMaxPer24h:
      d.kind === "when_required" && d.maxQuantityPer24Hours !== null
        ? String(d.maxQuantityPer24Hours)
        : null,
    tags: [...entry.tags],
    minimumIntervalMinutes: entry.minimumIntervalMinutes,
    indication: entry.indication,
    specialInstructions: entry.specialInstructions,
    prescriber: entry.prescriber,
    startsAt: entry.startsAt,
    stopsAt: entry.stopsAt,
    reviewOn: entry.reviewOn,
    sourceKind: entry.source.kind,
    sourceReference: entry.source.reference,
    sourceDocumentId: entry.source.documentId,
    transcribedBy: entry.transcribedBy,
    transcribedAt: entry.transcribedAt,
    state: "not_yet_checked",
    stopBy: once.stopBy,
    stopAt: once.stopAt,
    stopEffectiveAt: once.stopEffectiveAt,
    stopReason: once.stopReason,
    stopSourceKind: once.stopSourceKind,
    stopSourceReference: once.stopSourceReference,
    stopSourceDocumentId: once.stopSourceDocumentId,
    reanchorBy: entry.reanchor?.by ?? null,
    reanchorAt: entry.reanchor?.at ?? null,
    reanchorReason: entry.reanchor?.reason ?? null,
    correctedPartWayThrough: entry.correctedPartWayThrough,
    earlierDosesDueOn: entry.earlierDosesDue?.date ?? null,
    earlierDosesDueReason: entry.earlierDosesDue?.reason ?? null,
    reconciliationId: links.reconciliationId ?? null,
    importBatchId: links.importBatchId ?? null,
  });
  if (d.kind === "regular") {
    await tx.insert(medicationSchedule).values(
      d.schedule.times.map((t, position) => ({
        personId: entry.personId,
        medicationId: entry.id,
        position,
        time: t.time,
        doseKind: t.dose.kind,
        quantity: t.dose.kind === "amount" ? String(t.dose.quantity) : null,
        fromQuantity: t.dose.kind === "range" ? String(t.dose.from) : null,
        toQuantity: t.dose.kind === "range" ? String(t.dose.to) : null,
        unitCode: t.dose.unit.code,
        unitName: t.dose.unit.name,
      })),
    );
  }
}

/**
 * Records what the domain set on an existing version: its check, stop, replacement or withdrawal
 * and the state that follows. The write-once trigger refuses anything else.
 */
export async function updateEntry(tx: Transaction, entry: MarEntry): Promise<void> {
  const [row] = await tx
    .update(medication)
    .set(setOnce(entry))
    .where(eq(medication.id, entry.id))
    .returning({ id: medication.id });
  if (!row) throw new Error("medication row not found for update");
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

/** The directions in words, from the domain ("2 tablets every day at 08:00"). */
export function directionsInWords(entry: MarEntry): string {
  const d = entry.directions;
  return d.kind === "regular"
    ? describeSchedule(d.schedule)
    : `${formatDose(d.dose)} when required`;
}

export function entryOut(stored: StoredEntry, now: Date): MedicineEntry {
  const e = stored.entry;
  return {
    id: e.id,
    medicineId: stored.medicineId,
    personId: e.personId,
    version: e.version,
    replacesId: e.replacesId,
    state: e.state === "withdrawn" ? "withdrawn" : e.state,
    origin: e.origin,
    product: e.product,
    route: e.route,
    // Only readonly arrays differ: the weekday codes now match the contract (checked by tsc on input).
    directions: e.directions as MedicineEntry["directions"],
    directionsInWords: directionsInWords(e),
    indication: e.indication,
    specialInstructions: e.specialInstructions,
    prescriber: e.prescriber,
    startsAt: e.startsAt.toISOString(),
    stopsAt: iso(e.stopsAt),
    reviewOn: e.reviewOn,
    tags: [...e.tags],
    minimumIntervalMinutes: e.minimumIntervalMinutes,
    source: e.source,
    transcribed: { id: e.transcribedBy, at: e.transcribedAt.toISOString() },
    secondCheck: e.secondCheck
      ? {
          id: e.secondCheck.by,
          at: e.secondCheck.at.toISOString(),
          outcome: e.secondCheck.outcome,
          difference: e.secondCheck.difference,
        }
      : null,
    stop: e.stop
      ? {
          id: e.stop.by,
          at: e.stop.at.toISOString(),
          effectiveAt: e.stop.effectiveAt.toISOString(),
          reason: e.stop.reason,
          source: e.stop.source,
        }
      : null,
    replacedById: e.replacedById,
    replacedFrom: iso(e.replacedFrom),
    reanchor: e.reanchor
      ? { id: e.reanchor.by, at: e.reanchor.at.toISOString(), reason: e.reanchor.reason }
      : null,
    withdrawn: e.withdrawn
      ? { id: e.withdrawn.by, at: e.withdrawn.at.toISOString(), reason: e.withdrawn.reason }
      : null,
    status: marEntryStatus(e, now, UNCHECKED_POLICY),
  };
}

/**
 * Medicines writes for one person run one at a time (a transaction-scoped advisory lock), so two
 * people transcribing the same product at once cannot both pass rule 6's one entry per product
 * (security review, finding 1).
 */
export async function lockPerson(tx: Transaction, personId: string) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`medicines:${personId}`}, 0))`,
  );
}

/**
 * A source document must be this person's, available (scanned clean, not removed): never another
 * person's letter or one outside the caller's scope (RLS applies here, unlike a foreign key;
 * security review, finding 2).
 */
export async function requireDocuments(
  tx: Transaction,
  personId: string,
  ids: readonly (string | null | undefined)[],
) {
  for (const documentId of ids) {
    if (!documentId) continue;
    const [doc] = await tx
      .select({ id: document.id })
      .from(document)
      .where(
        and(
          eq(document.id, documentId),
          eq(document.personId, personId),
          eq(document.status, "available"),
          isNull(document.deletedAt),
        ),
      );
    if (!doc) throw problems.invalid("Choose a document from this person's record.");
  }
}

function dbCode(error: unknown): string | undefined {
  return (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
}

/** A second change from the same version lands on the unique (medicine, version) key. */
export async function guardConcurrent<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const code = dbCode(error);
    if (code === "23505") {
      throw problems.conflict("The medicine changed while you were working on it. Read it again.");
    }
    // A database rule refusing what the domain allowed: said as a refusal, never a conflict.
    if (code === "23514" || code === "23503") {
      throw new HttpProblem(
        422,
        "medicine_refused_by_record",
        "The medicines record cannot be changed like this.",
        "The record's own rules refused this change. Read the medicine again and check what you entered.",
      );
    }
    throw error;
  }
}
