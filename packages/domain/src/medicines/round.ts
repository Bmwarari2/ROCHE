/**
 * A person's round (medicines.md 13.7, 13.8 and 15.1), shared by the API and the phone so both
 * compute the same doses from the same facts: the scheduled doses in a time slot, each with its
 * window, its state in words and its notices, late first, time-critical first within each state,
 * then by due time; and each when-required medicine that may be given now, with when it was last
 * given. The phone runs it on its synced rows (Phase 2 slice 69; HZ-003, HZ-004); the server still
 * checks every record when it arrives.
 */
import { addUkDays } from "../shared/time";
import { type AdministrationOutcome, DOSE_TAKEN_OUTCOMES } from "./administration";
import { formatDose } from "./dose";
import { entryVersionIds, type GivenDose, prnStatus } from "./intervals";
import {
  type MarEntry,
  marEntryDoses,
  marEntryStatus,
  type UncheckedEntryPolicy,
} from "./mar-entry";
import type { MedicinesRates } from "./rates";
import {
  doseNotices,
  doseWindow,
  isTimeCritical,
  SCHEDULED_DOSE_WORDS,
  type ScheduledDoseState,
  scheduledDoseState,
} from "./timing";

/** An administration record as the round reads it, from the database or the phone's copy. */
export interface AdministrationFact {
  readonly id: string;
  readonly medicationId: string;
  readonly supersedesId: string | null;
  readonly dueAt: Date | null;
  readonly givenAt: Date;
  readonly outcome: string;
  readonly quantity: string | number | null;
  readonly unitCode: string | null;
  readonly administeredBy: string;
  /** False while it waits on this device to sync. Omitted: it came from the server. */
  readonly synced?: boolean;
}

/** A dose with an open conflict, so the round says a review is waiting (clinical re-review H3). */
export interface PendingConflict {
  readonly medicationId: string;
  readonly dueAt: Date;
}

export const REVIEW_PENDING_WORDS = "Recorded twice on different devices: waiting for review";

/**
 * Said beside a when-required medicine whose minimum interval reaches back before the
 * administrations the phone holds, when none of them is inside it (HZ-004).
 */
export const LAST_DOSE_NOT_ON_DEVICE_WORDS =
  "The last dose may be older than the records on this phone. Check the last dose with the nurse in charge before giving.";

const STATE_ORDER: Record<ScheduledDoseState, number> = {
  late: 0,
  due: 1,
  not_yet_due: 2,
  recorded: 3,
};

/** Which record corrects each record (the correction's id), if any. */
export function supersededBy(rows: readonly AdministrationFact[]): Map<string, string> {
  return new Map(
    rows.filter((r) => r.supersedesId !== null).map((r) => [r.supersedesId as string, r.id]),
  );
}

/** The records nothing corrects: what the MAR says happened. */
export function effectiveRecords<R extends AdministrationFact>(rows: readonly R[]): R[] {
  const corrected = supersededBy(rows);
  return rows.filter((r) => !corrected.has(r.id));
}

/** The doses the person took, from the effective records, for intervals and the 24-hour total. */
export function takenDoses(
  rows: readonly AdministrationFact[],
  entries: ReadonlyMap<string, MarEntry>,
): GivenDose[] {
  return effectiveRecords(rows)
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
      by: r.administeredBy,
      synced: r.synced ?? true,
    }));
}

export interface RoundScheduledDose {
  readonly entryId: string;
  readonly productName: string;
  readonly dueAt: string;
  readonly date: string;
  readonly time: string;
  readonly dayName: string | null;
  readonly clockChange: "time_skipped" | "time_repeated" | null;
  readonly doseInWords: string;
  readonly timeCritical: boolean;
  readonly state: ScheduledDoseState;
  readonly stateInWords: string;
  readonly reviewPending: boolean;
  readonly reviewInWords: string | null;
  readonly opensAt: string;
  readonly lateAfter: string;
  readonly notices: string[];
  readonly entryStatus: {
    readonly words: string;
    readonly mayGive: boolean;
    readonly notice: string | null;
  };
}

export interface RoundWhenRequired {
  readonly entryId: string;
  readonly productName: string;
  readonly lastGiven: { readonly at: string; readonly by: string; readonly synced: boolean } | null;
  readonly givenInLast24Hours: number;
  readonly maxPer24Hours: number | null;
  readonly remaining: number | null;
  readonly nextAllowedAt: string | null;
  readonly notices: string[];
  /** The interval reaches before the records this device holds and none is inside it (HZ-004). */
  readonly lastDoseNotOnDevice: boolean;
}

export interface RoundFacts {
  readonly entries: readonly MarEntry[];
  readonly rows: readonly AdministrationFact[];
  readonly rates: MedicinesRates;
  readonly policy: UncheckedEntryPolicy;
  readonly pending?: readonly PendingConflict[];
  /**
   * The earliest administration the facts can hold (the phone's window). Omitted on the server,
   * which holds them all.
   */
  readonly historyFrom?: Date;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** How far back a when-required medicine's intervals look. */
function intervalReachMs(entry: MarEntry, rates: MedicinesRates): number {
  const prescribed = (entry.minimumIntervalMinutes ?? 0) * MINUTE_MS;
  const paracetamol = entry.tags.includes("paracetamol")
    ? rates.paracetamolMinIntervalHours * HOUR_MS
    : 0;
  return Math.max(prescribed, paracetamol);
}

export function medicineRound(
  facts: RoundFacts,
  range: { readonly from: Date; readonly to: Date },
  at: Date,
  now: Date,
): { doses: RoundScheduledDose[]; whenRequired: RoundWhenRequired[] } {
  const pending = facts.pending ?? [];
  const eff = effectiveRecords(facts.rows);
  const history = takenDoses(facts.rows, new Map(facts.entries.map((e) => [e.id, e])));
  const doses = facts.entries
    .flatMap((entry) => {
      const versionIds = entryVersionIds(entry, facts.entries);
      const status = marEntryStatus(entry, at, facts.policy);
      // The slot's doses, and any dose since the same UK clock time the day before that is still
      // late or due, so an earlier dose is never off the round (clinical review M4; re-review H1
      // and M6: a UK day back, not 24 hours, so a clock change moves nothing out of reach).
      const reach = { from: addUkDays(range.from, -1), to: range.to };
      return marEntryDoses(entry, reach).flatMap((d): RoundScheduledDose[] => {
        const window = doseWindow(d.dueAt, isTimeCritical(entry), facts.rates);
        const recorded = eff.some(
          (r) => versionIds.has(r.medicationId) && r.dueAt?.getTime() === d.dueAt.getTime(),
        );
        const state = scheduledDoseState(window, recorded, now);
        if (
          d.dueAt.getTime() < range.from.getTime() &&
          (state === "recorded" || state === "not_yet_due")
        ) {
          return [];
        }
        const reviewPending = pending.some(
          (p) => versionIds.has(p.medicationId) && p.dueAt.getTime() === d.dueAt.getTime(),
        );
        return [
          {
            entryId: entry.id,
            productName: entry.product.name,
            dueAt: d.dueAt.toISOString(),
            date: d.date,
            time: d.time,
            // The weekday for a non-daily pattern, and a clock change moving or repeating the time
            // (HZ-009, H-553; re-review H2).
            dayName: d.dayName,
            clockChange: d.clockChange,
            doseInWords: formatDose(d.dose),
            timeCritical: window.timeCritical,
            state,
            stateInWords: SCHEDULED_DOSE_WORDS[state],
            reviewPending,
            reviewInWords: reviewPending ? REVIEW_PENDING_WORDS : null,
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
        marEntryStatus(e, at, facts.policy).mayGive,
    )
    .map((entry): RoundWhenRequired => {
      const versionIds = entryVersionIds(entry, facts.entries);
      const s = prnStatus(entry, versionIds, history, at, facts.rates);
      const reachFrom = at.getTime() - intervalReachMs(entry, facts.rates);
      const insideReach = history.some(
        (d) =>
          (versionIds.has(d.entryId) ||
            (entry.tags.includes("paracetamol") && d.tags.includes("paracetamol"))) &&
          d.at.getTime() > reachFrom &&
          d.at.getTime() <= at.getTime(),
      );
      const lastDoseNotOnDevice =
        facts.historyFrom !== undefined && reachFrom < facts.historyFrom.getTime() && !insideReach;
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
        notices: lastDoseNotOnDevice
          ? [LAST_DOSE_NOT_ON_DEVICE_WORDS, ...s.notices]
          : [...s.notices],
        lastDoseNotOnDevice,
      };
    });
  return { doses, whenRequired };
}
