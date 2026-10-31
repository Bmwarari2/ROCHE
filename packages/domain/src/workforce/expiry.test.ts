import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { addDays } from "./dates";
import { expiryState, reminderDates } from "./expiry";
import { reminderDays, resolveWorkforceRates } from "./rates";

const rates = resolveWorkforceRates(readRateTable(), "england", "2026-10-31", null);
const offsets = reminderDays(rates);
const [first, second, third] = offsets as [number, number, number];
const EXPIRES = "2027-06-30";

describe("expiring documents (workforce.md rule 1)", () => {
  it.each([
    [first + 1, "valid", null],
    [first, "due_soon", first],
    [second + 1, "due_soon", first],
    [second, "due_soon", second],
    [third, "due_soon", third],
    [0, "due_soon", third],
    [-1, "expired", null],
  ] as const)("%i days before expiry: %s, reminder %s", (daysLeft, status, reminder) => {
    const today = addDays(EXPIRES, -daysLeft);
    const state = expiryState(EXPIRES, today, offsets);
    expect(state.status).toBe(status);
    expect(state.reminderDue).toBe(reminder);
  });

  it("raises each reminder once", () => {
    const today = addDays(EXPIRES, -second);
    expect(expiryState(EXPIRES, today, offsets, [first, second]).reminderDue).toBeNull();
  });

  it("raises only the nearest missed reminder, never the far one late", () => {
    const today = addDays(EXPIRES, -third);
    expect(expiryState(EXPIRES, today, offsets, []).reminderDue).toBe(third);
  });

  it("lists the reminder dates in order", () => {
    expect(reminderDates(EXPIRES, offsets)).toEqual(offsets.map((o) => addDays(EXPIRES, -o)));
  });
});
