/**
 * Minimum intervals, the when-required maximum in 24 hours and the last-given time (medicines.md
 * rules 16, 19 and 20; HZ-004, HZ-009, HZ-010; ADR-0082). Every gap is elapsed time between
 * drift-corrected instants, never wall-clock time, so a clock change neither shortens nor lengthens
 * it. The intervals come from the prescription or PRN protocol as transcribed on the entry, and
 * from the tenant's paracetamol rule for entries a person tagged paracetamol (applied across every
 * entry so tagged, which is how Harbour covers two products with the same ingredient without
 * matching ingredients). The 24-hour total runs over the 24 hours up to the dose.
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

function dosesOf(entry: MarEntry, versionIds: ReadonlySet<string>, history: readonly GivenDose[]) {
  const unit = entry.directions.kind === "when_required" ? entry.directions.dose.unit.code : null;
  return history.filter((d) => versionIds.has(d.entryId) && (unit === null || d.unitCode === unit));
}

function totalIn24Hours(doses: readonly GivenDose[], at: Date): number {
  return doses
    .filter((d) => d.at.getTime() > at.getTime() - DAY_MS && d.at.getTime() <= at.getTime())
    .reduce((sum, d) => sum + d.quantity, 0);
}

export interface PrnStatus {
  readonly lastGiven: { readonly at: Date; readonly by: string; readonly synced: boolean } | null;
  readonly givenInLast24Hours: number;
  readonly maxPer24Hours: number | null;
  readonly remaining: number | null;
  /** Until when a minimum interval says to wait, if it does now. */
  readonly nextAllowedAt: Date | null;
  readonly notice: string | null;
}

export const PRN_NOTICES = {
  noMaximum:
    "No maximum in 24 hours is recorded for this medicine. Check with the prescriber before giving more than one dose in 24 hours.",
  maximumReached:
    "The most allowed in 24 hours has been given. Do not give more: contact the prescriber.",
  notSynced: "The last dose shown was recorded on this device and has not reached Harbour yet.",
} as const;

/** What the round shows beside a when-required medicine: last given, the 24-hour total and when next. */
export function prnStatus(
  entry: MarEntry,
  versionIds: ReadonlySet<string>,
  history: readonly GivenDose[],
  now: Date,
  rates: Pick<MedicinesRates, "paracetamolMinIntervalHours">,
): PrnStatus {
  const doses = dosesOf(entry, versionIds, history).filter((d) => d.at.getTime() <= now.getTime());
  const last = [...doses].sort((a, b) => b.at.getTime() - a.at.getTime())[0] ?? null;
  const max =
    entry.directions.kind === "when_required" ? entry.directions.maxQuantityPer24Hours : null;
  const given = totalIn24Hours(doses, now);
  const remaining = max === null ? null : Math.max(0, max - given);
  const waits = intervalConflicts(entry, versionIds, history, now, rates)
    .map((c) => c.nextAllowedAt.getTime())
    .filter((t) => t > now.getTime());
  const notice =
    max === null
      ? PRN_NOTICES.noMaximum
      : remaining === 0
        ? PRN_NOTICES.maximumReached
        : last && !last.synced
          ? PRN_NOTICES.notSynced
          : null;
  return {
    lastGiven: last ? { at: last.at, by: last.by, synced: last.synced } : null,
    givenInLast24Hours: given,
    maxPer24Hours: max,
    remaining,
    nextAllowedAt: waits.length > 0 ? new Date(Math.max(...waits)) : null,
    notice,
  };
}

/**
 * Whether giving `quantity` at `at` would take the total over the prescribed maximum in the 24
 * hours up to then. Exceeding the maximum is never overridden on the round: the prescriber decides.
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
  const given = totalIn24Hours(dosesOf(entry, versionIds, history), at);
  return given + quantity > max ? { given, max } : null;
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
