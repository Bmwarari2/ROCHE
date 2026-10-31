import { describe, expect, it } from "vitest";
import {
  draft,
  entry,
  PRODUCT,
  TABLET_FACTS,
  TRANSCRIBER,
  UNIT,
} from "../../test/medicines-fixtures";
import { tableMedicinesRates } from "../../test/rate-table";
import { fromUkWallClock, toUkWallClock } from "../shared/time";
import {
  entryVersionIds,
  type GivenDose,
  intervalConflicts,
  PRN_NOTICES,
  prnMaximumExceeded,
  prnOutcomeDueAt,
  prnOutcomesOutstanding,
  prnStatus,
} from "./intervals";
import { changeMarEntry, type MarEntry, type MarEntryDraft, type MedicineTag } from "./mar-entry";
import { driftCorrectedTime } from "./timing";

const rates = tableMedicinesRates();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const prnDirections: MarEntryDraft["directions"] = {
  kind: "when_required",
  dose: { kind: "range", from: 1, to: 2, unit: UNIT.tablet },
  maxQuantityPer24Hours: 8,
};
const prn = entry({ directions: prnDirections, minimumIntervalMinutes: 240 }, "entry-prn");
const only = (e: MarEntry) => new Set([e.id]);
const given = (id: string, at: Date, overrides: Partial<GivenDose> = {}): GivenDose => ({
  id,
  entryId: "entry-prn",
  tags: [],
  at,
  quantity: 2,
  unitCode: UNIT.tablet.code,
  by: "member-carer",
  synced: true,
  ...overrides,
});
const at = (hour: number, minute = 0) => fromUkWallClock(2026, 11, 2, hour, minute);

describe("minimum intervals come from the prescription, or the tenant's rule for tagged entries", () => {
  it("the prescribed interval counts doses from every version of the entry", () => {
    const change = changeMarEntry(
      [prn],
      draft({ directions: prnDirections, minimumIntervalMinutes: 240, startsAt: at(9) }),
      TABLET_FACTS,
      {
        id: "entry-prn-2",
        by: TRANSCRIBER,
        at: at(9),
        origin: "transcribed",
      },
    );
    if (!change.ok) throw new Error("change refused");
    const versions = entryVersionIds(change.next, [prn, change.next]);
    expect([...versions].sort()).toEqual(["entry-prn", "entry-prn-2"]);
    const conflicts = intervalConflicts(change.next, versions, [given("d1", at(8))], at(11), rates);
    expect(conflicts).toMatchObject([{ rule: "prescribed", minutes: 240, nextAllowedAt: at(12) }]);
    expect(intervalConflicts(change.next, versions, [given("d1", at(8))], at(12), rates)).toEqual(
      [],
    );
  });

  it("checks a record entered later against the doses after it too", () => {
    expect(intervalConflicts(prn, only(prn), [given("d1", at(12))], at(10), rates)).toHaveLength(1);
  });

  it("applies the paracetamol rule across every entry tagged paracetamol, and to no untagged entry whatever its name (ADR-0082)", () => {
    const tagged: MedicineTag[] = ["paracetamol"];
    const coCodamol = given("d1", at(8), { entryId: "entry-other", tags: tagged });
    const regular = { minimumIntervalMinutes: null, tags: tagged };
    const conflicts = intervalConflicts(
      regular,
      new Set(["entry-reg"]),
      [coCodamol],
      at(10),
      rates,
    );
    expect(conflicts).toMatchObject([
      { rule: "paracetamol", minutes: rates.paracetamolMinIntervalHours * 60 },
    ]);
    // An untagged paracetamol product is not caught by name or ingredient: tagging is a person's job.
    const untagged = {
      ...entry({ product: PRODUCT.paracetamolCapsules }),
      minimumIntervalMinutes: null,
    };
    expect(intervalConflicts(untagged, new Set(["x"]), [coCodamol], at(10), rates)).toEqual([]);
  });
});

/** Hours between two times on the UK wall clock (same or next day). */
const wallHours = (a: Date, b: Date) => {
  const minutes = (d: Date) => toUkWallClock(d).hour * 60 + toUkWallClock(d).minute;
  return (minutes(b) - minutes(a)) / 60;
};

describe("hazard HZ-009 a 4-hour minimum interval spanning a clock change is measured in elapsed time", () => {
  const hours = rates.paracetamolMinIntervalHours;
  const tagged = { minimumIntervalMinutes: null, tags: ["paracetamol"] as MedicineTag[] };
  const versions = new Set(["entry-x"]);

  it("when the clocks go back, the full interval has passed though the clock shows an hour less", () => {
    const previous = fromUkWallClock(2026, 10, 25, 0, 30);
    const next = new Date(previous.getTime() + hours * HOUR);
    expect(wallHours(previous, next)).toBe(hours - 1);
    const history = [given("d1", previous, { tags: ["paracetamol"] })];
    expect(intervalConflicts(tagged, versions, history, next, rates)).toEqual([]);
    expect(
      intervalConflicts(tagged, versions, history, new Date(next.getTime() - MINUTE), rates),
    ).toHaveLength(1);
  });

  it("when the clocks go forward, the clock shows the full interval but an hour less has passed", () => {
    const previous = fromUkWallClock(2026, 3, 29, 0, 30);
    const next = fromUkWallClock(2026, 3, 29, hours, 30);
    expect(wallHours(previous, next)).toBe(hours);
    const history = [given("d1", previous, { tags: ["paracetamol"] })];
    expect(intervalConflicts(tagged, versions, history, next, rates)).toMatchObject([
      { nextAllowedAt: new Date(previous.getTime() + hours * HOUR) },
    ]);
  });
});

describe("hazard HZ-010 the minimum-interval check uses the drift-corrected clock", () => {
  const history = [given("d1", at(8), { tags: ["paracetamol"] })];
  const tagged = { minimumIntervalMinutes: null, tags: ["paracetamol"] as MedicineTag[] };
  const versions = new Set(["entry-x"]);
  const allowedFrom = new Date(at(8).getTime() + rates.paracetamolMinIntervalHours * HOUR);

  it("a fast device reads the interval as passed when it has not", () => {
    const deviceAt = new Date(allowedFrom.getTime() + 5 * MINUTE);
    const corrected = driftCorrectedTime(deviceAt, -10 * MINUTE, rates);
    expect(intervalConflicts(tagged, versions, history, deviceAt, rates)).toEqual([]);
    expect(intervalConflicts(tagged, versions, history, corrected.at, rates)).toHaveLength(1);
  });

  it("a slow device reads the interval as not passed when it has", () => {
    const deviceAt = new Date(allowedFrom.getTime() - 8 * MINUTE);
    const corrected = driftCorrectedTime(deviceAt, 10 * MINUTE, rates);
    expect(intervalConflicts(tagged, versions, history, deviceAt, rates)).toHaveLength(1);
    expect(intervalConflicts(tagged, versions, history, corrected.at, rates)).toEqual([]);
  });
});

describe("hazard HZ-004 enforces the PRN maximum in 24 hours", () => {
  const history = [given("d1", at(1)), given("d2", at(6)), given("d3", at(11))];

  it.each([
    ["up to the maximum", 2, null],
    ["over the maximum", 3, { given: 6, max: 8 }],
  ])("%s", (_name, quantity, exceeded) => {
    expect(prnMaximumExceeded(prn, only(prn), history, quantity, at(16))).toEqual(exceeded);
  });

  it("counts the 24 hours up to the dose in elapsed time, so a dose 24 hours ago no longer counts", () => {
    const later = new Date(at(1).getTime() + 24 * HOUR);
    expect(prnMaximumExceeded(prn, only(prn), history, 4, later)).toBeNull();
    expect(prnMaximumExceeded(prn, only(prn), history, 5, later)).toEqual({ given: 4, max: 8 });
  });

  it("counts only this medicine's versions in its own unit, and has no maximum for a regular entry", () => {
    const other = [
      ...history,
      given("x", at(12), { entryId: "entry-other" }),
      given("y", at(12), { unitCode: "uom-ml" }),
    ];
    expect(prnMaximumExceeded(prn, only(prn), other, 2, at(16))).toBeNull();
    expect(prnMaximumExceeded(entry(), new Set(["entry-1"]), history, 100, at(16))).toBeNull();
    const noMax = entry(
      { directions: { ...prnDirections, maxQuantityPer24Hours: null } },
      "entry-prn",
    );
    expect(prnMaximumExceeded(noMax, only(noMax), history, 100, at(16))).toBeNull();
  });
});

describe("hazard HZ-004 shows the last-given time for every when-required medicine", () => {
  it("shows when, by whom, the 24-hour total, what remains and when the interval allows the next", () => {
    const status = prnStatus(
      prn,
      only(prn),
      [given("d1", at(6)), given("d2", at(11))],
      at(13),
      rates,
    );
    expect(status).toEqual({
      lastGiven: { at: at(11), by: "member-carer", synced: true },
      givenInLast24Hours: 4,
      maxPer24Hours: 8,
      remaining: 4,
      nextAllowedAt: at(15),
      notice: null,
    });
  });

  it.each([
    [
      "no maximum recorded",
      { ...prnDirections, maxQuantityPer24Hours: null },
      [],
      PRN_NOTICES.noMaximum,
    ],
    [
      "the maximum given",
      prnDirections,
      [given("a", at(1), { quantity: 4 }), given("b", at(6), { quantity: 4 })],
      PRN_NOTICES.maximumReached,
    ],
    [
      "the last dose still on this device",
      prnDirections,
      [given("a", at(6), { synced: false })],
      PRN_NOTICES.notSynced,
    ],
  ] as const)("says so when %s", (_name, directions, history, notice) => {
    const e = entry({ directions, minimumIntervalMinutes: 240 }, "entry-prn");
    expect(prnStatus(e, only(e), history, at(13), rates).notice).toBe(notice);
  });

  it("never shows a dose recorded for later as already given", () => {
    expect(prnStatus(prn, only(prn), [given("d1", at(14))], at(13), rates).lastGiven).toBeNull();
  });
});

describe("the outcome of a when-required dose is followed up", () => {
  it("falls due after the table's figure and is listed until recorded", () => {
    expect(prnOutcomeDueAt(at(8), rates)).toEqual(
      new Date(at(8).getTime() + rates.prnOutcomeCheckMinutes * MINUTE),
    );
    const due = prnOutcomeDueAt(at(8), rates);
    const doses = [
      { id: "a", at: at(8), outcomeRecorded: false },
      { id: "b", at: at(8), outcomeRecorded: true },
      { id: "c", at: due, outcomeRecorded: false },
    ];
    expect(prnOutcomesOutstanding(doses, due, rates)).toEqual(["a"]);
  });
});
