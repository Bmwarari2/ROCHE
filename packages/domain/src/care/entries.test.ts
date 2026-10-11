import { describe, expect, it } from "vitest";
import { tableCareRates } from "../../test/rate-table";
import { checkEntryTime, isLateEntry } from "./entries";

/** Late and future entries (hazards HZ-017 and HZ-010); thresholds come from the rate table. */

const rates = tableCareRates();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const recordedAt = new Date("2026-10-11T14:00:00Z");
const earlier = (ms: number) => new Date(recordedAt.getTime() - ms);
const later = (ms: number) => new Date(recordedAt.getTime() + ms);

describe("hazard HZ-017 entries older than the late-entry threshold are flagged late", () => {
  it.each([
    ["recorded at the time of the event", earlier(0), false],
    [
      "recorded one minute inside the threshold",
      earlier(rates.lateEntryHours * HOUR - MINUTE),
      false,
    ],
    ["recorded exactly at the threshold", earlier(rates.lateEntryHours * HOUR), false],
    ["recorded one minute past the threshold", earlier(rates.lateEntryHours * HOUR + MINUTE), true],
    ["recorded a day later", earlier(24 * HOUR), true],
  ])("%s", (_name, occurredAt, late) => {
    expect(isLateEntry(occurredAt, recordedAt, rates)).toBe(late);
    expect(checkEntryTime(occurredAt, recordedAt, rates)).toEqual({ ok: true, lateEntry: late });
  });

  it("measures elapsed time, so the autumn clock change does not hide a late entry", () => {
    // 00:30 BST to 01:30 GMT on 25 October 2026 reads as one hour on the wall clock but is two.
    const occurredAt = new Date("2026-10-24T23:30:00Z");
    const recorded = new Date(occurredAt.getTime() + rates.lateEntryHours * HOUR + MINUTE);
    expect(isLateEntry(occurredAt, recorded, rates)).toBe(true);
  });

  it("follows a tenant's own threshold from the rate table", () => {
    const occurredAt = earlier(rates.lateEntryHours * HOUR + MINUTE);
    expect(isLateEntry(occurredAt, recordedAt, { lateEntryHours: rates.lateEntryHours + 1 })).toBe(
      false,
    );
  });
});

describe("hazard HZ-017 future event times beyond the clock-drift tolerance are refused", () => {
  it.each([
    ["an event within the tolerance", later(rates.clockDriftMinutes * MINUTE), true],
    [
      "an event one minute beyond the tolerance",
      later((rates.clockDriftMinutes + 1) * MINUTE),
      false,
    ],
    ["an event tomorrow", later(24 * HOUR), false],
  ])("%s", (_name, occurredAt, accepted) => {
    const check = checkEntryTime(occurredAt, recordedAt, rates);
    expect(check.ok).toBe(accepted);
    if (!check.ok) {
      expect(check).toEqual({
        ok: false,
        reason: "future_entry",
        message: "The time of the event is in the future. Check the time and the device clock.",
      });
    }
  });
});
