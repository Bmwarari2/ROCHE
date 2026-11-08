import { describe, expect, it } from "vitest";
import { entry, UNIT } from "../../test/medicines-fixtures";
import { tableMedicinesRates } from "../../test/rate-table";
import { fromUkWallClock } from "../shared/time";
import {
  type AdministrationFact,
  effectiveRecords,
  LAST_DOSE_NOT_ON_DEVICE_WORDS,
  medicineRound,
  takenDoses,
} from "./round";

const rates = tableMedicinesRates();
const at = (day: number, hour: number, minute = 0) => fromUkWallClock(2026, 11, day, hour, minute);
// Starts on the 3rd, so the day before adds no late doses of its own.
const regular = entry({ startsAt: fromUkWallClock(2026, 11, 3, 0, 0) }, "entry-regular");
const prn = (minimumIntervalMinutes: number | null, id = "entry-prn") =>
  entry(
    {
      directions: {
        kind: "when_required",
        dose: { kind: "amount", quantity: 1, unit: UNIT.tablet },
        maxQuantityPer24Hours: 4,
      },
      minimumIntervalMinutes,
    },
    id,
  );
const record = (overrides: Partial<AdministrationFact> & { id: string }): AdministrationFact => ({
  medicationId: "entry-regular",
  supersedesId: null,
  dueAt: null,
  givenAt: at(3, 8),
  outcome: "given",
  quantity: "2",
  unitCode: UNIT.tablet.code,
  administeredBy: "member-carer",
  ...overrides,
});
const slot = { from: at(3, 6), to: at(3, 12) };

describe("the round the API and the phone share (HZ-003)", () => {
  it.each([
    ["before its window opens", at(3, 6), "not_yet_due"],
    ["inside its window", at(3, 8), "due"],
    ["after its window", at(3, 11), "late"],
  ] as const)("a dose not recorded is %s: %s", (_case, now, state) => {
    const round = medicineRound(
      { entries: [regular], rows: [], rates, policy: "give_with_notice" },
      slot,
      now,
      now,
    );
    expect(round.doses.map((d) => [d.time, d.state])).toContainEqual(["08:00", state]);
  });

  it("counts a dose recorded once a correction is taken into account", () => {
    const first = record({ id: "a1", dueAt: at(3, 8) });
    const corrected = record({ id: "a2", dueAt: at(3, 8), supersedesId: "a1", outcome: "refused" });
    expect(effectiveRecords([first, corrected]).map((r) => r.id)).toEqual(["a2"]);
    const round = medicineRound(
      { entries: [regular], rows: [first, corrected], rates, policy: "give_with_notice" },
      slot,
      at(3, 9),
      at(3, 9),
    );
    expect(round.doses.find((d) => d.time === "08:00")?.state).toBe("recorded");
    // A refusal is recorded but is not a dose taken.
    expect(takenDoses([first, corrected], new Map())).toEqual([]);
  });

  it("puts a late dose before one due now", () => {
    const round = medicineRound(
      { entries: [regular], rows: [], rates, policy: "give_with_notice" },
      { from: at(3, 6), to: at(3, 20) },
      at(3, 18),
      at(3, 18),
    );
    expect(round.doses.map((d) => [d.time, d.state])).toEqual([
      ["08:00", "late"],
      ["18:00", "due"],
    ]);
  });

  it("marks a dose recorded on this device and not yet synced as unsynced in the last given", () => {
    const e = prn(240);
    const round = medicineRound(
      {
        entries: [e],
        rows: [record({ id: "p1", medicationId: e.id, givenAt: at(3, 8), synced: false })],
        rates,
        policy: "give_with_notice",
      },
      slot,
      at(3, 9),
      at(3, 9),
    );
    expect(round.whenRequired[0]?.lastGiven).toMatchObject({ synced: false });
  });
});

describe("hazard HZ-004 a medicine whose interval is longer than the phone's window says the last dose is not on this phone", () => {
  const historyFrom = at(1, 0);
  it.each([
    // [case, minimum interval in minutes, records, expected]
    ["an interval inside the window", 240, [], false],
    ["an interval reaching before the window with no dose inside it", 60 * 24 * 40, [], true],
    [
      "an interval reaching before the window with a dose inside it",
      60 * 24 * 40,
      [record({ id: "p1", medicationId: "entry-prn", givenAt: at(2, 8), quantity: "1" })],
      false,
    ],
  ] as const)("%s", (_case, minutes, rows, expected) => {
    const round = medicineRound(
      { entries: [prn(minutes)], rows, rates, policy: "give_with_notice", historyFrom },
      slot,
      at(3, 9),
      at(3, 9),
    );
    const w = round.whenRequired[0];
    expect(w?.lastDoseNotOnDevice).toBe(expected);
    expect(w?.notices.includes(LAST_DOSE_NOT_ON_DEVICE_WORDS)).toBe(expected);
  });

  it("never says so on the server, which holds every record", () => {
    const round = medicineRound(
      { entries: [prn(60 * 24 * 40)], rows: [], rates, policy: "give_with_notice" },
      slot,
      at(3, 9),
      at(3, 9),
    );
    expect(round.whenRequired[0]?.lastDoseNotOnDevice).toBe(false);
  });
});
