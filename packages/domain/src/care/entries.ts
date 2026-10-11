/**
 * Time rules for notes, observations and chart entries (care.md section 4 rule 3; hazards HZ-017
 * and HZ-010). An entry recorded more than `care_note.late_entry_hours` hours after the event is
 * flagged late everywhere it appears; an event time later than the recording time plus the clock
 * drift tolerance (`sync.clock_drift_flag_minutes`) is refused as a future entry.
 */

import type { CareRates } from "./rates";

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

/**
 * True when the entry was recorded more than the late-entry threshold after the event. Exactly at
 * the threshold is not late.
 */
export function isLateEntry(
  occurredAt: Date,
  recordedAt: Date,
  rates: Pick<CareRates, "lateEntryHours">,
): boolean {
  return recordedAt.getTime() - occurredAt.getTime() > rates.lateEntryHours * MS_PER_HOUR;
}

export type EntryTimeCheck =
  | { readonly ok: true; readonly lateEntry: boolean }
  | { readonly ok: false; readonly reason: "future_entry"; readonly message: string };

/** Validates an entry's event time against its recording time before it is saved. */
export function checkEntryTime(
  occurredAt: Date,
  recordedAt: Date,
  rates: Pick<CareRates, "lateEntryHours" | "clockDriftMinutes">,
): EntryTimeCheck {
  if (occurredAt.getTime() - recordedAt.getTime() > rates.clockDriftMinutes * MS_PER_MINUTE) {
    return {
      ok: false,
      reason: "future_entry",
      message: "The time of the event is in the future. Check the time and the device clock.",
    };
  }
  return { ok: true, lateEntry: isLateEntry(occurredAt, recordedAt, rates) };
}
