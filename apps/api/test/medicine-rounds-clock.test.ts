import { describe, expect, it } from "vitest";
import { entry } from "../../../packages/domain/test/medicines-fixtures";
import { tableMedicinesRates } from "../../../packages/domain/test/rate-table";
import { roundFor } from "../src/services/medicine-rounds";

/**
 * The round across a clock change (Phase 2 slice 48; HZ-009; H-1277): the reach for earlier doses
 * is the same UK clock time the day before, so a dose from yesterday still late or due is on the
 * round whichever way the clocks moved, and each dose carries its clock-change words.
 */

const daily0800 = {
  ...entry({ startsAt: new Date("2026-03-01T00:00:00Z") }),
  transcribedAt: new Date("2026-03-01T00:00:00Z"),
};
const facts = { entries: [daily0800], rows: [], rates: tableMedicinesRates("2026-03-01") };

describe("hazard HZ-009 a round slot across a clock change keeps yesterday's late dose", () => {
  it.each([
    // Autumn: 25/10/2026 08:00 GMT; yesterday's 08:00 BST is 07:00Z, 25 hours earlier.
    ["autumn", "2026-10-25T08:00:00Z", "2026-10-24T07:00:00.000Z"],
    // Spring: 29/03/2026 08:00 BST; yesterday's 08:00 GMT is 08:00Z, 23 hours earlier.
    ["spring", "2026-03-29T07:00:00Z", "2026-03-28T08:00:00.000Z"],
  ])("the %s change", (_label, slotStart, yesterday) => {
    const from = new Date(slotStart);
    const to = new Date(from.getTime() + 2 * 3_600_000);
    const now = new Date(from.getTime() + 15 * 60_000);
    const round = roundFor(facts, { from, to }, now, now);
    const late = round.doses.find((d) => d.dueAt === yesterday);
    expect(late?.state).toBe("late");
    expect(round.doses[0]?.dueAt).toBe(yesterday);
    expect(round.doses.find((d) => d.dueAt === from.toISOString())?.state).not.toBe("late");
  });
});
