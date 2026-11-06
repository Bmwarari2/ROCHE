/**
 * Minimum intervals, the when-required maximum in 24 hours and the last-given time (medicines.md
 * rules 16, 19 and 20; HZ-004, HZ-009, HZ-010; ADR-0082). Every gap is elapsed time between
 * drift-corrected instants, never wall-clock time, so a clock change neither shortens nor lengthens
 * it. The intervals come from the prescription or PRN protocol as transcribed on the entry, and
 * from the tenant's paracetamol rule for entries a person tagged paracetamol (applied across every
 * entry so tagged, which is how Harbour covers two products with the same ingredient without
 * matching ingredients). The 24-hour maximum is checked over every 24 hours that contains the
 * dose, before and after it, as the interval check is; a dose of the same medicine recorded in
 * another unit is never converted and never silently left out: it is named as not counted.
 */

import type { MarEntry, MedicineTag } from "./mar-entry";
import type { MedicinesRates } from "./rates";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** A dose the person took (given, self-administered or given by family), for intervals and totals. */
export interface GivenDose {
  readonly id: string;
  /** The entry version it was given from. */
  readonly entryId: string;
  /** That version's tags. */
  readonly tags: readonly MedicineTag[];
  /** Drift-corrected time it was given. */
  readonly at: Date;
  readonly quantity: number;
  readonly unitCode: string;
  readonly by: string;
  /** False while it waits on this device to sync: the last-given time says so. */
  readonly synced: boolean;
}

/** An entry and every earlier version of it, so intervals and totals count across changes. */
export function entryVersionIds(entry: MarEntry, all: readonly MarEntry[]): ReadonlySet<string> {
  const byId = new Map(all.map((e) => [e.id, e]));
  const ids = new Set<string>();
  for (let e: MarEntry | undefined = entry; e && !ids.has(e.id); ) {
    ids.add(e.id);
    e = e.replacesId === null ? undefined : byId.get(e.replacesId);
  }
  return ids;
}

export interface IntervalConflict {
  readonly previous: GivenDose;
  /** `prescribed`: the entry's own minimum interval; `paracetamol`: the tenant's rule for tagged entries. */
  readonly rule: "prescribed" | "paracetamol";
  readonly minutes: number;
  readonly nextAllowedAt: Date;
}

/**
 * Doses taken within a minimum interval of `at`, before or after it (a record entered later can
 * still be too close to a dose already recorded).
 */
export function intervalConflicts(
  entry: Pick<MarEntry, "minimumIntervalMinutes" | "tags">,
  versionIds: ReadonlySet<string>,
  history: readonly GivenDose[],
  at: Date,
  rates: Pick<MedicinesRates, "paracetamolMinIntervalHours">,
): readonly IntervalConflict[] {
  const conflicts: IntervalConflict[] = [];
  const check = (rule: IntervalConflict["rule"], minutes: number, doses: readonly GivenDose[]) => {
    for (const previous of doses) {
      if (Math.abs(at.getTime() - previous.at.getTime()) < minutes * MINUTE_MS) {
        const nextAllowedAt = new Date(previous.at.getTime() + minutes * MINUTE_MS);
        conflicts.push({ previous, rule, minutes, nextAllowedAt });
      }
    }
  };
  if (entry.minimumIntervalMinutes !== null) {
    check(
      "prescribed",
      entry.minimumIntervalMinutes,
      history.filter((d) => versionIds.has(d.entryId)),
    );
  }
  if (entry.tags.includes("paracetamol")) {
    check(
      "paracetamol",
      (rates.paracetamolMinIntervalHours * HOUR_MS) / MINUTE_MS,
      history.filter((d) => d.tags.includes("paracetamol")),
    );
  }
  return conflicts.sort((a, b) => b.previous.at.getTime() - a.previous.at.getTime());
}

/**
 * The doses of an entry's versions: those in the when-required dose's own unit count towards its
 * maximum; those in any other unit are never converted (Harbour does no unit arithmetic) and are
 * reported as not counted instead.
 */
function dosesOf(entry: MarEntry, versionIds: ReadonlySet<string>, history: readonly GivenDose[]) {
  const unit = entry.directions.kind === "when_required" ? entry.directions.dose.unit.code : null;
  const all = history.filter((d) => versionIds.has(d.entryId));
  return {
    all,
    counted: all.filter((d) => unit === null || d.unitCode === unit),
    otherUnit: all.filter((d) => unit !== null && d.unitCode !== unit),
  };
}

/** The total in the 24 hours up to and including `end`: (end - 24 hours, end]. */
function totalIn24Hours(doses: readonly GivenDose[], end: number): number {
  return doses
    .filter((d) => d.at.getTime() > end - DAY_MS && d.at.getTime() <= end)
    .reduce((sum, d) => sum + d.quantity, 0);
}

/**
 * The most taken in any 24 hours that contains `at`, before or after it. A 24 hours ending at a
 * dose after `at` (and less than 24 hours after it) still contains `at`, so a record entered later
 * than others is counted against the doses that follow it too. The largest total is always found
 * in a 24 hours ending at `at` or at one of those later doses.
 */
function mostIn24HoursAround(doses: readonly GivenDose[], at: Date): number {
  const t = at.getTime();
  const ends = [
    t,
    ...doses.map((d) => d.at.getTime()).filter((end) => end > t && end < t + DAY_MS),
  ];
  return Math.max(...ends.map((end) => totalIn24Hours(doses, end)));
}

export interface PrnStatus {
  readonly lastGiven: { readonly at: Date; readonly by: string; readonly synced: boolean } | null;
  readonly givenInLast24Hours: number;
  readonly maxPer24Hours: number | null;
  readonly remaining: number | null;
  /** Until when a minimum interval says to wait, if it does now. */
  readonly nextAllowedAt: Date | null;
  /** Every notice that applies, never only the first, so "not synced" is never hidden. */
  readonly notices: readonly string[];
}

export const PRN_NOTICES = {
  noMaximum:
    "No maximum in 24 hours is recorded for this medicine: the prescribed minimum interval applies. Ask the prescriber if you are unsure how much may be given in 24 hours.",
  maximumReached:
    "The most allowed in 24 hours has been given. Do not give more: contact the prescriber.",
  notSynced: "The last dose shown was recorded on this device and has not reached Harbour yet.",
  otherUnitNotCounted:
    "Not counted: a dose of this medicine was recorded in a different unit. Harbour never converts units, so it is not in the 24-hour total. Check it with the nurse in charge.",
} as const;

/** What the round shows beside a when-required medicine: last given, the 24-hour total and when next. */
export function prnStatus(
  entry: MarEntry,
  versionIds: ReadonlySet<string>,
  history: readonly GivenDose[],
  now: Date,
  rates: Pick<MedicinesRates, "paracetamolMinIntervalHours">,
): PrnStatus {
  const upToNow = (d: GivenDose) => d.at.getTime() <= now.getTime();
  const doses = dosesOf(entry, versionIds, history);
  // The last dose of the medicine in any unit: when it was last taken does not depend on its unit.
  const last = doses.all.filter(upToNow).sort((a, b) => b.at.getTime() - a.at.getTime())[0] ?? null;
  const max =
    entry.directions.kind === "when_required" ? entry.directions.maxQuantityPer24Hours : null;
  const given = totalIn24Hours(doses.counted.filter(upToNow), now.getTime());
  const remaining = max === null ? null : Math.max(0, max - given);
  const waits = intervalConflicts(entry, versionIds, history, now, rates)
    .map((c) => c.nextAllowedAt.getTime())
    .filter((t) => t > now.getTime());
  const notCounted = doses.otherUnit.some(
    (d) => upToNow(d) && d.at.getTime() > now.getTime() - DAY_MS,
  );
  const notices: string[] = [];
  if (max === null) notices.push(PRN_NOTICES.noMaximum);
  if (remaining === 0) notices.push(PRN_NOTICES.maximumReached);
  if (last && !last.synced) notices.push(PRN_NOTICES.notSynced);
  if (notCounted) notices.push(PRN_NOTICES.otherUnitNotCounted);
  return {
    lastGiven: last ? { at: last.at, by: last.by, synced: last.synced } : null,
    givenInLast24Hours: given,
    maxPer24Hours: max,
    remaining,
    nextAllowedAt: waits.length > 0 ? new Date(Math.max(...waits)) : null,
    notices,
  };
}

/**
 * Whether giving `quantity` at `at` would take the total over the prescribed maximum in any 24
 * hours that contains it, before or after it (`given` is the most already taken in such a 24
 * hours). Exceeding the maximum is never overridden on the round: the prescriber decides. Doses in
 * another unit are not counted: `prnDosesNotCounted` names them.
 */
export function prnMaximumExceeded(
  entry: MarEntry,
  versionIds: ReadonlySet<string>,
  history: readonly GivenDose[],
  quantity: number,
  at: Date,
): { readonly given: number; readonly max: number } | null {
  if (entry.directions.kind !== "when_required") return null;
  const max = entry.directions.maxQuantityPer24Hours;
  if (max === null) return null;
  const given = mostIn24HoursAround(dosesOf(entry, versionIds, history).counted, at);
  return given + quantity > max ? { given, max } : null;
}

/**
 * Doses of a when-required medicine recorded in another unit within 24 hours either side of `at`:
 * not in its 24-hour total, because Harbour never converts units, and so shown as not counted
 * (`PRN_NOTICES.otherUnitNotCounted`) rather than left out silently.
 */
export function prnDosesNotCounted(
  entry: MarEntry,
  versionIds: ReadonlySet<string>,
  history: readonly GivenDose[],
  at: Date,
): readonly GivenDose[] {
  return dosesOf(entry, versionIds, history).otherUnit.filter(
    (d) => Math.abs(d.at.getTime() - at.getTime()) < DAY_MS,
  );
}

/** When the outcome of a when-required dose falls due (`medicines.prn.outcome_check_minutes`). */
export function prnOutcomeDueAt(
  givenAt: Date,
  rates: Pick<MedicinesRates, "prnOutcomeCheckMinutes">,
): Date {
  return new Date(givenAt.getTime() + rates.prnOutcomeCheckMinutes * MINUTE_MS);
}

/** When-required doses whose outcome is due and not recorded, for the round and the handover. */
export function prnOutcomesOutstanding(
  doses: readonly { readonly id: string; readonly at: Date; readonly outcomeRecorded: boolean }[],
  now: Date,
  rates: Pick<MedicinesRates, "prnOutcomeCheckMinutes">,
): readonly string[] {
  return doses
    .filter((d) => !d.outcomeRecorded && prnOutcomeDueAt(d.at, rates).getTime() <= now.getTime())
    .map((d) => d.id);
}
