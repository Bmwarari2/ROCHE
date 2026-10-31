/**
 * When a scheduled dose is due, early or late (medicines.md rules 13 to 15; HZ-003, HZ-009,
 * HZ-010; ADR-0082). Every window is the tenant's own figure from the rate table: a regular dose
 * has `medicines.dose_window.*`, and an entry a person tagged time-critical at transcription has
 * the narrower `medicines.time_critical.*` (never wider than the regular window). A scheduled dose
 * is recorded no earlier than its own window opens (HZ-004 review: a later dose, this evening's or
 * tomorrow's, can no longer be recorded at the morning round); anywhere inside its window it is on
 * time, and after it late. Given before its due time it asks a reason only for an entry tagged
 * time-critical, or when it brings two doses closer than the schedule allows (`earlyNeedsReason`;
 * #162 third clinical review, against alert fatigue). A dose with no outcome after its window is
 * late and stays outstanding until someone records what happened; nothing closes it. Times are compared as elapsed UTC instants, on the drift-corrected
 * clock, so a window on the night the clocks change is as long as on any other night.
 */

import type { MarEntry } from "./mar-entry";
import type { MedicinesRates } from "./rates";

const MINUTE_MS = 60_000;

type WindowRates = Pick<
  MedicinesRates,
  "doseEarlyMinutes" | "doseLateMinutes" | "timeCriticalEarlyMinutes" | "timeCriticalLateMinutes"
>;

/** Time-critical only when a person tagged the entry so at transcription (ADR-0082). */
export function isTimeCritical(entry: Pick<MarEntry, "tags">): boolean {
  return entry.tags.includes("time_critical");
}

export interface DoseWindow {
  readonly dueAt: Date;
  /** The dose cannot be recorded before this. */
  readonly opensAt: Date;
  /** With no outcome after this, the dose is late, outstanding and escalated. */
  readonly lateAfter: Date;
  readonly timeCritical: boolean;
}

function windowMinutes(timeCritical: boolean, rates: WindowRates): [number, number] {
  if (!timeCritical) return [rates.doseEarlyMinutes, rates.doseLateMinutes];
  return [
    Math.min(rates.timeCriticalEarlyMinutes, rates.doseEarlyMinutes),
    Math.min(rates.timeCriticalLateMinutes, rates.doseLateMinutes),
  ];
}

/** The window around a scheduled dose, narrower for a time-critical entry. */
export function doseWindow(dueAt: Date, timeCritical: boolean, rates: WindowRates): DoseWindow {
  const [early, late] = windowMinutes(timeCritical, rates);
  return {
    dueAt,
    opensAt: new Date(dueAt.getTime() - early * MINUTE_MS),
    lateAfter: new Date(dueAt.getTime() + late * MINUTE_MS),
    timeCritical,
  };
}

export type RecordedTiming = "before_window" | "on_time" | "late";

/**
 * Where a dose recorded at `at` falls against its window: before the window opens (refused, unless
 * it has already happened), anywhere inside the window (on time), or after (late, with a reason).
 */
export function recordedTiming(window: DoseWindow, at: Date): RecordedTiming {
  if (at.getTime() < window.opensAt.getTime()) return "before_window";
  if (at.getTime() > window.lateAfter.getTime()) return "late";
  return "on_time";
}

/**
 * Whether a dose given inside its window but before its due time needs a reason (it is then
 * recorded as early). Only for an entry tagged time-critical, whose timing is the point of the tag;
 * or when the time since the entry's last dose (`lastGivenAt`) is shorter than the scheduled gap
 * from the previous dose (`previousDueAt`) less the window's own early side, so two doses given at
 * opposite ends of their windows are not brought closer than the schedule allows unnoticed. Any
 * other dose inside its window is on time and asks nothing.
 */
export function earlyNeedsReason(
  window: DoseWindow,
  at: Date,
  lastGivenAt: Date | null,
  previousDueAt: Date | null,
): boolean {
  const t = at.getTime();
  if (t < window.opensAt.getTime() || t >= window.dueAt.getTime()) return false;
  if (window.timeCritical) return true;
  if (lastGivenAt === null || previousDueAt === null) return false;
  const earlySide = window.dueAt.getTime() - window.opensAt.getTime();
  const scheduledGap = window.dueAt.getTime() - previousDueAt.getTime();
  return t - lastGivenAt.getTime() < scheduledGap - earlySide;
}

export type ScheduledDoseState = "not_yet_due" | "due" | "late" | "recorded";

export const SCHEDULED_DOSE_WORDS: Readonly<Record<ScheduledDoseState, string>> = {
  not_yet_due: "Not due yet",
  due: "Due now",
  late: "Late: no outcome recorded",
  recorded: "Outcome recorded",
};

/**
 * Where a scheduled dose stands. A late dose stays late, and outstanding, until an outcome is
 * recorded: it never closes itself (HZ-003).
 */
export function scheduledDoseState(
  window: DoseWindow,
  recorded: boolean,
  now: Date,
): ScheduledDoseState {
  if (recorded) return "recorded";
  if (now.getTime() < window.opensAt.getTime()) return "not_yet_due";
  if (now.getTime() > window.lateAfter.getTime()) return "late";
  return "due";
}

/**
 * When an outstanding dose is escalated: the end of its window, so a time-critical dose escalates
 * sooner (HZ-003). Slice 48 sends it through the escalation chain, which a tenant cannot switch
 * off for time-critical doses (HZ-008).
 */
export function escalationAt(window: DoseWindow): Date {
  return window.lateAfter;
}

/**
 * The tenant's rules an entry's tags switch on, in words for the MAR and the round, with the
 * figures from the rate table. The prescriber's own instructions are shown as written beside them.
 */
export function doseNotices(
  entry: Pick<MarEntry, "tags">,
  rates: WindowRates &
    Pick<MedicinesRates, "paracetamolMinIntervalHours" | "bisphosphonateBeforeFoodMinutes">,
): readonly string[] {
  const notices: string[] = [];
  if (isTimeCritical(entry)) {
    const [early, late] = windowMinutes(true, rates);
    notices.push(
      `Time-critical: give between ${early} minutes before and ${late} minutes after the time due.`,
    );
  }
  if (entry.tags.includes("bisphosphonate")) {
    notices.push(
      `Give at least ${rates.bisphosphonateBeforeFoodMinutes} minutes before food or drink, as the label says.`,
    );
  }
  if (entry.tags.includes("paracetamol")) {
    notices.push(
      `Paracetamol: at least ${rates.paracetamolMinIntervalHours} hours between doses of any medicine tagged paracetamol.`,
    );
  }
  return notices;
}

export interface CorrectedTime {
  readonly at: Date;
  /** False when the device's offset from the server is not known yet (never synced). */
  readonly corrected: boolean;
  /** The device clock is further from the server's than `sync.clock_drift_flag_minutes` (HZ-010). */
  readonly drifted: boolean;
}

/**
 * A time read from a device clock, corrected by the offset measured at its last sync (the server's
 * clock minus the device's), so intervals are measured on the server's clock (HZ-010).
 */
export function driftCorrectedTime(
  deviceAt: Date,
  offsetMs: number | null,
  rates: Pick<MedicinesRates, "clockDriftMinutes">,
): CorrectedTime {
  if (offsetMs === null) return { at: deviceAt, corrected: false, drifted: false };
  return {
    at: new Date(deviceAt.getTime() + offsetMs),
    corrected: true,
    drifted: Math.abs(offsetMs) > rates.clockDriftMinutes * MINUTE_MS,
  };
}
