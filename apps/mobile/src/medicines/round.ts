/**
 * The medicines round on the phone (Phase 2 slice 69; medicines.md 13.8; HZ-001, HZ-003, HZ-004).
 * The synced MAR entry versions, their schedule times and the recent administrations become the
 * domain's `MarEntry` and `AdministrationFact`, and `medicineRound`, the API's own rule, gives each
 * person's doses: a replaced version and its replacement never both give a dose, because each
 * version's doses run from `marEntryDosesFrom` to `marEntryEnd`.
 *
 * The round is offered only on a trusted device (eMAR is off on a rooted or jailbroken phone, or
 * one whose integrity is unknown), once a complete sync has reached it (every priority, so no stop
 * or administration is still on its way), and once the medicines figures are on the phone. Pure,
 * so every rule is tested without a device.
 */
import {
  type AdministrationFact,
  type Dose,
  type MarEntry,
  type MedicinesRates,
  medicineRound,
  type RoundScheduledDose,
  type RoundWhenRequired,
  type SchedulePattern,
  ukDateOf,
} from "@harbour/domain";
import { medsRecentDays } from "@harbour/sync/client";
import { parseInstant } from "../care/time";

/** A `medication` row as the phone holds it. */
export interface MedicationLocalRow {
  readonly id: string;
  readonly person_id: string;
  readonly medicine_id: string | null;
  readonly version: number | null;
  readonly replaces_id: string | null;
  readonly state: string | null;
  readonly vmp_id: string | null;
  readonly amp_id: string | null;
  readonly product_name: string | null;
  readonly route_code: string | null;
  readonly route_name: string | null;
  readonly directions: string | null;
  readonly pattern_kind: string | null;
  readonly interval_days: number | null;
  readonly weekdays: string | null;
  readonly interval_weeks: number | null;
  readonly anchor_on: string | null;
  readonly day_of_month: number | null;
  readonly prn_dose: string | null;
  readonly prn_max_per_24h: string | null;
  readonly tags: string | null;
  readonly minimum_interval_minutes: number | null;
  readonly indication: string | null;
  readonly special_instructions: string | null;
  readonly starts_at: string | null;
  readonly stops_at: string | null;
  readonly stop_at: string | null;
  readonly stop_effective_at: string | null;
  readonly cd_schedule: string | null;
  readonly check_outcome: string | null;
  readonly replaced_by_id: string | null;
  readonly replaced_from: string | null;
  readonly origin: string | null;
  readonly corrected_part_way_through: string | null;
  readonly earlier_doses_due_on: string | null;
  readonly earlier_doses_due_reason: string | null;
}

export interface ScheduleLocalRow {
  readonly medication_id: string;
  readonly position: number | null;
  readonly time: string | null;
  readonly dose_kind: string | null;
  readonly quantity: string | null;
  readonly from_quantity: string | null;
  readonly to_quantity: string | null;
  readonly unit_code: string | null;
  readonly unit_name: string | null;
}

export interface AdministrationLocalRow {
  readonly id: string;
  readonly person_id: string;
  readonly medication_id: string;
  readonly due_at: string | null;
  readonly outcome: string | null;
  readonly quantity: string | null;
  readonly unit_code: string | null;
  readonly given_at: string | null;
  readonly administered_by: string | null;
  /** Who recorded it, which decides who may correct it on the phone, as the API does. */
  readonly recorded_by?: string | null;
  readonly supersedes_id: string | null;
  /** The request this phone queued (local only): set until the server's row replaces it. */
  readonly request: string | null;
}

function json<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function patternOf(row: MedicationLocalRow): SchedulePattern {
  switch (row.pattern_kind) {
    case "every_n_days":
      return {
        kind: "every_n_days",
        intervalDays: row.interval_days ?? 0,
        anchorOn: row.anchor_on ?? "",
      };
    case "weekly":
      return {
        kind: "weekly",
        weekdays: (json<string[]>(row.weekdays) ?? []) as Extract<
          SchedulePattern,
          { kind: "weekly" }
        >["weekdays"],
        intervalWeeks: row.interval_weeks ?? 1,
        anchorOn: row.anchor_on ?? "",
      };
    case "monthly":
      return { kind: "monthly", dayOfMonth: row.day_of_month ?? 1 };
    default:
      return { kind: "every_day" };
  }
}

function doseOf(row: ScheduleLocalRow): Dose {
  const unit = { code: row.unit_code ?? "", name: row.unit_name ?? "" };
  if (row.dose_kind === "range") {
    return { kind: "range", from: Number(row.from_quantity), to: Number(row.to_quantity), unit };
  }
  if (row.dose_kind === "variable") return { kind: "variable", unit };
  return { kind: "amount", quantity: Number(row.quantity), unit };
}

/**
 * A synced version as the domain reads it, or null when a field the round needs is missing or
 * unreadable: such a version is listed as unreadable on the round, never left out silently.
 */
export function entryFromRows(
  row: MedicationLocalRow,
  times: readonly ScheduleLocalRow[],
): MarEntry | null {
  const startsAt = parseInstant(row.starts_at);
  const origin = row.origin;
  if (
    !startsAt ||
    !row.product_name ||
    !row.vmp_id ||
    (origin !== "transcribed" && origin !== "reconciliation" && origin !== "import") ||
    (row.directions !== "regular" && row.directions !== "when_required")
  ) {
    return null;
  }
  const prnDose = json<Dose>(row.prn_dose);
  if (row.directions === "when_required" && !prnDose) return null;
  const stopAt = parseInstant(row.stop_at);
  const stopEffectiveAt = parseInstant(row.stop_effective_at);
  const unknown = "";
  return {
    id: row.id,
    personId: row.person_id,
    version: row.version ?? 1,
    origin,
    state: (row.state ?? "active") as MarEntry["state"],
    product: { vmpId: row.vmp_id, ampId: row.amp_id, name: row.product_name },
    route: { code: row.route_code ?? unknown, name: row.route_name ?? unknown },
    directions:
      row.directions === "regular"
        ? {
            kind: "regular",
            schedule: {
              pattern: patternOf(row),
              times: [...times]
                .filter((t) => t.time)
                .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
                .map((t) => ({ time: t.time as string, dose: doseOf(t) })),
            },
          }
        : {
            kind: "when_required",
            dose: prnDose as Dose,
            maxQuantityPer24Hours:
              row.prn_max_per_24h === null ? null : Number(row.prn_max_per_24h),
          },
    tags: (json<string[]>(row.tags) ?? []) as MarEntry["tags"],
    minimumIntervalMinutes: row.minimum_interval_minutes,
    indication: row.indication,
    specialInstructions: row.special_instructions,
    prescriber: unknown,
    startsAt,
    stopsAt: parseInstant(row.stops_at),
    reviewOn: null,
    source: { kind: "prescription" as const, reference: unknown, documentId: null },
    transcribedBy: unknown,
    transcribedAt: startsAt,
    replacesId: row.replaces_id,
    // The phone holds only whether a second check was made and what it found.
    secondCheck:
      row.check_outcome === "matches_source" || row.check_outcome === "differs_from_source"
        ? { by: unknown, at: startsAt, outcome: row.check_outcome, difference: null }
        : null,
    stop:
      stopAt && stopEffectiveAt
        ? {
            by: unknown,
            at: stopAt,
            effectiveAt: stopEffectiveAt,
            reason: unknown,
            source: { kind: "prescription" as const, reference: unknown, documentId: null },
          }
        : null,
    replacedById: row.replaced_by_id,
    replacedFrom: parseInstant(row.replaced_from),
    reanchor: null,
    // Withdrawn versions never reach the phone (ADR-0130).
    withdrawn: null,
    correctedPartWayThrough: row.corrected_part_way_through,
    earlierDosesDue:
      row.earlier_doses_due_on && row.earlier_doses_due_reason
        ? { date: row.earlier_doses_due_on, reason: row.earlier_doses_due_reason }
        : null,
  };
}

export function administrationFact(row: AdministrationLocalRow): AdministrationFact | null {
  const givenAt = parseInstant(row.given_at);
  if (!givenAt || !row.outcome || !row.administered_by) return null;
  return {
    id: row.id,
    medicationId: row.medication_id,
    supersedesId: row.supersedes_id,
    dueAt: parseInstant(row.due_at),
    givenAt,
    outcome: row.outcome,
    quantity: row.quantity,
    unitCode: row.unit_code,
    administeredBy: row.administered_by,
    synced: row.request === null,
  };
}

/** The earliest administration the phone can hold: 00:00 UTC on the first `meds_recent_days`. */
export function phoneHistoryFrom(now: Date): Date {
  const first = medsRecentDays(now)[0] ?? now.toISOString().slice(0, 10);
  return new Date(`${first}T00:00:00Z`);
}

export type RoundGate =
  | { readonly kind: "ready" }
  | { readonly kind: "device_not_trusted"; readonly status: "compromised" | "unknown" }
  | { readonly kind: "waiting_for_sync" }
  | { readonly kind: "waiting_for_figures" };

/**
 * Whether the round may be offered: a trusted device first (eMAR is off on a rooted or jailbroken
 * phone, MASVS; section 17.2), then a complete sync (HZ-004: every priority), then the figures.
 */
export function roundGate(input: {
  readonly integrity: "trusted" | "compromised" | "unknown" | null;
  readonly hasSynced: boolean;
  readonly rates: MedicinesRates | null;
  readonly demo?: boolean;
}): RoundGate {
  if (!input.demo && input.integrity !== "trusted") {
    return {
      kind: "device_not_trusted",
      status: input.integrity === "compromised" ? "compromised" : "unknown",
    };
  }
  if (!input.hasSynced) return { kind: "waiting_for_sync" };
  if (!input.rates) return { kind: "waiting_for_figures" };
  return { kind: "ready" };
}

export interface PersonRound {
  readonly personId: string;
  readonly doses: readonly RoundScheduledDose[];
  readonly whenRequired: readonly RoundWhenRequired[];
  /** Versions the phone could not read: named, never dropped (HZ-003). */
  readonly unreadable: readonly string[];
  /** Controlled drugs are recorded with a witness, not yet on the phone (slice 70). */
  readonly controlledDrugIds: ReadonlySet<string>;
}

/** Each person's round from the phone's rows, for the slot from `from` to `to`. */
export function phoneRound(input: {
  readonly medications: readonly MedicationLocalRow[];
  readonly schedules: readonly ScheduleLocalRow[];
  readonly administrations: readonly AdministrationLocalRow[];
  readonly rates: MedicinesRates;
  readonly from: Date;
  readonly to: Date;
  readonly now: Date;
}): PersonRound[] {
  const timesBy = new Map<string, ScheduleLocalRow[]>();
  for (const s of input.schedules) {
    const list = timesBy.get(s.medication_id) ?? [];
    list.push(s);
    timesBy.set(s.medication_id, list);
  }
  const people = [...new Set(input.medications.map((m) => m.person_id))].sort();
  const historyFrom = phoneHistoryFrom(input.now);
  return people.map((personId) => {
    const rows = input.medications.filter((m) => m.person_id === personId);
    const entries: MarEntry[] = [];
    const unreadable: string[] = [];
    for (const row of rows) {
      const e = entryFromRows(row, timesBy.get(row.id) ?? []);
      if (e) entries.push(e);
      else unreadable.push(row.product_name ?? row.id);
    }
    const facts = input.administrations
      .filter((a) => a.person_id === personId)
      .map(administrationFact)
      .filter((a): a is AdministrationFact => a !== null);
    const round = medicineRound(
      {
        entries,
        rows: facts,
        rates: input.rates,
        policy: "give_with_notice",
        historyFrom,
      },
      { from: input.from, to: input.to },
      input.now,
      input.now,
    );
    return {
      personId,
      doses: round.doses,
      whenRequired: round.whenRequired,
      unreadable,
      controlledDrugIds: new Set(rows.filter((r) => r.cd_schedule != null).map((r) => r.id)),
    };
  });
}

/** The slot a dose belongs to, by its UK time ("08:00"): the round is read slot by slot. */
export function doseSlots(rounds: readonly PersonRound[]): {
  readonly time: string;
  readonly date: string;
  readonly doses: readonly (RoundScheduledDose & { readonly personId: string })[];
}[] {
  const bySlot = new Map<string, (RoundScheduledDose & { personId: string })[]>();
  for (const r of rounds) {
    for (const d of r.doses) {
      const key = `${d.date} ${d.time}`;
      const list = bySlot.get(key) ?? [];
      list.push({ ...d, personId: r.personId });
      bySlot.set(key, list);
    }
  }
  return [...bySlot.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, doses]) => {
      const [date, time] = key.split(" ") as [string, string];
      return { date, time, doses };
    });
}

/** Today's UK date, for the pack's expiry check. */
export function ukToday(now: Date): string {
  return ukDateOf(now);
}
