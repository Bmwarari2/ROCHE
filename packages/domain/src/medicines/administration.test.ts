import { describe, expect, it } from "vitest";
import { CHECKER, entry, PERSON, UNIT } from "../../test/medicines-fixtures";
import { CLINIC_RECORD, WARFARIN } from "../../test/medicines-variable";
import { tableMedicinesRates } from "../../test/rate-table";
import { formatUkTime, fromUkWallClock } from "../shared/time";
import {
  type AdministrationFlag,
  type AdministrationInput,
  type AdministrationProblem,
  checkAdministration,
  checkAmendment,
  checkCorrection,
  checkRoundClose,
  marRowLocked,
  OUTCOME_REASONS,
  OUTCOME_WORDS,
  REASON_WORDS,
  type RecordedAdministration,
  type RoundDose,
} from "./administration";
import { checkDosingRecord, recordDosingRecord } from "./dosing-record";
import type { GivenDose } from "./intervals";
import { type MarEntry, recordSecondCheck } from "./mar-entry";

const rates = tableMedicinesRates();
const MINUTE = 60_000;
const CARER = "member-carer";
const at = (day: number, hour: number, minute = 0) => fromUkWallClock(2026, 11, day, hour, minute);
const checkedEntry = (e: MarEntry): MarEntry => {
  const result = recordSecondCheck(e, {
    by: CHECKER,
    at: new Date("2026-11-01T12:00:00Z"),
    competence: "current",
    comparedWithSource: true,
    outcome: "matches_source",
    difference: null,
  });
  if (!result.ok) throw new Error("check refused");
  return result.entry;
};
const PARACETAMOL = checkedEntry(entry());
const PRN = checkedEntry(
  entry(
    {
      directions: {
        kind: "when_required",
        dose: { kind: "range", from: 1, to: 2, unit: UNIT.tablet },
        maxQuantityPer24Hours: 8,
      },
      minimumIntervalMinutes: 240,
    },
    "entry-prn",
  ),
);
const given = (id: string, when: Date, overrides: Partial<GivenDose> = {}): GivenDose => ({
  id,
  entryId: "entry-prn",
  tags: [],
  at: when,
  quantity: 2,
  unitCode: UNIT.tablet.code,
  by: CARER,
  synced: true,
  ...overrides,
});

function input(overrides: Partial<AdministrationInput> = {}): AdministrationInput {
  return {
    personId: PERSON,
    entry: PARACETAMOL,
    dueAt: at(2, 8),
    outcome: "given",
    reason: null,
    amount: { quantity: 2, unitCode: UNIT.tablet.code },
    amountDifferenceReason: null,
    at: at(2, 8, 5),
    timingReason: null,
    intervalOverrideReason: null,
    administrator: { id: CARER, competence: "current" },
    competenceOverride: null,
    policy: "give_with_notice",
    alreadyRecorded: false,
    recordedDueTimes: [],
    versionIds: new Set([overrides.entry?.id ?? "entry-1"]),
    history: [],
    dosingRecords: [],
    ...overrides,
  };
}
const prnInput = (overrides: Partial<AdministrationInput> = {}) =>
  input({
    entry: PRN,
    dueAt: null,
    versionIds: new Set(["entry-prn"]),
    at: at(2, 13),
    ...overrides,
  });
const problems = (i: AdministrationInput): AdministrationProblem[] => {
  const result = checkAdministration(i, rates);
  return result.ok ? [] : result.issues.map((x) => x.problem);
};

describe("hazard HZ-003 refuses an administration without person, dose and outcome", () => {
  it.each<[string, Partial<AdministrationInput>, AdministrationProblem[]]>([
    ["no person selected", { personId: null }, ["person_required"]],
    ["no medicine selected", { entry: null }, ["dose_required"]],
    ["no scheduled dose chosen for a regular medicine", { dueAt: null }, ["dose_required"]],
    ["no outcome", { outcome: null }, ["outcome_required"]],
    [
      "none of them",
      { personId: null, entry: null, outcome: null },
      ["person_required", "dose_required", "outcome_required"],
    ],
  ])("refuses a record with %s", (_name, overrides, expected) => {
    expect(problems(input(overrides))).toEqual(expected);
  });

  it("records a dose with all three, and says what was prescribed", () => {
    expect(checkAdministration(input(), rates)).toEqual({
      ok: true,
      flags: [],
      prescribed: { kind: "amount", quantity: 2, unit: UNIT.tablet },
      escalations: [],
    });
  });
});

describe("the dose recorded is the person's, scheduled, and recorded once", () => {
  it("hazard HZ-001 refuses a record for a medicine on another person's MAR", () => {
    expect(problems(input({ personId: "person-ben-example" }))).toEqual(["wrong_person"]);
  });

  it.each<[string, Partial<AdministrationInput>]>([
    ["a time the medicine is not due", { dueAt: at(2, 9) }],
    [
      "a due time for a when-required medicine",
      { entry: PRN, dueAt: at(2, 8), versionIds: new Set(["entry-prn"]) },
    ],
  ])("refuses %s", (_name, overrides) => {
    expect(problems(input(overrides))).toContain("dose_not_scheduled");
  });

  it("hazard HZ-004 refuses a second record for a dose that already has one: it is corrected instead", () => {
    expect(problems(input({ alreadyRecorded: true }))).toEqual(["already_recorded"]);
  });
});

describe("outcomes and coded reasons", () => {
  it("words every outcome and every reason, never by colour alone", () => {
    for (const [outcome, codes] of Object.entries(OUTCOME_REASONS)) {
      expect(OUTCOME_WORDS[outcome as keyof typeof OUTCOME_WORDS]).not.toBe("");
      for (const code of codes) expect(REASON_WORDS[code]).toBeTruthy();
    }
  });

  it.each<[string, Partial<AdministrationInput>, AdministrationProblem[]]>([
    ["refused with no reason", { outcome: "refused", amount: null }, ["reason_required"]],
    [
      "refused, declined",
      { outcome: "refused", amount: null, reason: { code: "declined", note: null } },
      [],
    ],
    [
      "not given, asleep",
      { outcome: "omitted", amount: null, reason: { code: "asleep", note: null } },
      [],
    ],
    [
      "not given with a reason for another outcome",
      { outcome: "omitted", amount: null, reason: { code: "declined", note: null } },
      ["reason_not_for_outcome"],
    ],
    [
      "not given, other, with nothing said",
      { outcome: "omitted", amount: null, reason: { code: "other", note: " " } },
      ["note_required"],
    ],
    [
      "withheld with nothing said",
      { outcome: "withheld", amount: null, reason: { code: "prescriber_instruction", note: null } },
      ["note_required"],
    ],
    [
      "withheld on the prescriber's word",
      {
        outcome: "withheld",
        amount: null,
        reason: {
          code: "prescriber_instruction",
          note: "Dr Example by phone 08:10: hold until review",
        },
      },
      [],
    ],
    [
      "not available",
      { outcome: "not_available", amount: null, reason: { code: "out_of_stock", note: null } },
      [],
    ],
    [
      "given with a reason code",
      { reason: { code: "declined", note: null } },
      ["reason_not_for_outcome"],
    ],
  ])("%s", (_name, overrides, expected) => {
    expect(problems(input(overrides))).toEqual(expected);
  });
});

describe("only an entry that may be given is given from", () => {
  it.each<[string, Partial<AdministrationInput>]>([
    [
      "an entry whose check found a difference",
      {
        entry: (() => {
          const r = recordSecondCheck(entry(), {
            by: CHECKER,
            at: new Date("2026-11-01T12:00:00Z"),
            competence: "current",
            comparedWithSource: true,
            outcome: "differs_from_source",
            difference: "The letter says 1 tablet",
          });
          if (!r.ok) throw new Error("check refused");
          return r.entry;
        })(),
      },
    ],
    [
      "an unchecked entry, where the tenant holds them",
      { entry: entry(), policy: "hold_until_checked" },
    ],
    [
      "an entry not started yet",
      { entry: entry({ startsAt: at(3, 0) }), dueAt: at(3, 8), at: at(2, 8) },
    ],
  ])("refuses a dose from %s", (_name, overrides) => {
    expect(problems(input(overrides))).toContain("entry_not_usable");
  });

  it("gives from an unchecked entry by default, flagged", () => {
    expect(checkAdministration(input({ entry: entry() }), rates)).toMatchObject({
      ok: true,
      flags: ["entry_not_yet_checked"],
    });
  });

  it("records a refusal from an entry it may not give from", () => {
    const held = input({
      entry: entry(),
      policy: "hold_until_checked",
      outcome: "refused",
      amount: null,
      reason: { code: "declined", note: null },
    });
    expect(problems(held)).toEqual([]);
  });
});

describe("hazard HZ-005 the amount given is the dose prescribed, or the difference is explained", () => {
  it.each<[string, Partial<AdministrationInput>, AdministrationProblem[]]>([
    ["no amount", { amount: null }, ["amount_required"]],
    ["another unit", { amount: { quantity: 2, unitCode: UNIT.ml.code } }, ["amount_wrong_unit"]],
    ["no number", { amount: { quantity: 0, unitCode: UNIT.tablet.code } }, ["amount_not_a_dose"]],
    [
      "less than prescribed, unexplained",
      { amount: { quantity: 1, unitCode: UNIT.tablet.code } },
      ["amount_differs_needs_reason"],
    ],
  ])("refuses %s", (_name, overrides, expected) => {
    expect(problems(input(overrides))).toEqual(expected);
  });

  it("records a different amount with what happened, flagged for review", () => {
    const partial = input({
      amount: { quantity: 1, unitCode: UNIT.tablet.code },
      amountDifferenceReason: "Spat out one tablet",
    });
    expect(checkAdministration(partial, rates)).toMatchObject({
      ok: true,
      flags: ["amount_differs"],
    });
  });

  it("accepts any amount within a prescribed range", () => {
    expect(problems(prnInput({ amount: { quantity: 1, unitCode: UNIT.tablet.code } }))).toEqual([]);
    expect(problems(prnInput({ amount: { quantity: 3, unitCode: UNIT.tablet.code } }))).toEqual([
      "amount_differs_needs_reason",
    ]);
  });
});

describe("hazard HZ-005 a variable dose is given only from a checked dosing record", () => {
  const warfarin = checkedEntry(WARFARIN);
  const base = {
    entry: warfarin,
    dueAt: at(2, 18),
    at: at(2, 18, 5),
    versionIds: new Set(["entry-warf"]),
    amount: { quantity: 3, unitCode: UNIT.mg.code },
  };
  const record = recordDosingRecord(warfarin, CLINIC_RECORD, {
    id: "dosing-1",
    by: CARER,
    at: at(1, 15),
  });
  if (!record.ok) throw new Error("record refused");
  const checkedRecord = checkDosingRecord(record.record, {
    by: CHECKER,
    at: at(1, 16),
    competence: "current",
    comparedWithSource: true,
    outcome: "matches_source",
    difference: null,
  });
  if (!checkedRecord.ok) throw new Error("check refused");

  const newer = (
    id: string,
    quantity: number,
    outcome: "matches_source" | "differs_from_source" | null,
  ) => {
    const r = recordDosingRecord(
      warfarin,
      { ...CLINIC_RECORD, doses: [{ date: "2026-11-02", time: "18:00", quantity }] },
      { id, by: CARER, at: at(2, 9) },
    );
    if (!r.ok) throw new Error("record refused");
    if (outcome === null) return r.record;
    const c = checkDosingRecord(r.record, {
      by: CHECKER,
      at: at(2, 10),
      competence: "current",
      comparedWithSource: true,
      outcome,
      difference: outcome === "differs_from_source" ? "The letter says 2 mg" : null,
    });
    if (!c.ok) throw new Error("check refused");
    return c.record;
  };

  it.each<[string, Partial<AdministrationInput>, AdministrationProblem[]]>([
    ["no dosing record", {}, ["no_checked_dosing_record"]],
    [
      "a dosing record nobody has checked",
      { dosingRecords: [record.record] },
      ["dosing_record_not_checked"],
    ],
    [
      "a newer record for the day not yet checked, beside an older checked one (never the older dose)",
      {
        dosingRecords: [checkedRecord.record, newer("dosing-2", 1, null)],
        amount: { quantity: 3, unitCode: UNIT.mg.code },
      },
      ["dosing_record_not_checked"],
    ],
    [
      "a newer record for the day whose check found a difference, beside an older checked one",
      {
        dosingRecords: [newer("dosing-2", 1, "differs_from_source"), checkedRecord.record],
        amount: { quantity: 3, unitCode: UNIT.mg.code },
      },
      ["dosing_record_differs"],
    ],
    [
      "the newer checked record's dose",
      {
        dosingRecords: [checkedRecord.record, newer("dosing-2", 1, "matches_source")],
        amount: { quantity: 1, unitCode: UNIT.mg.code },
      },
      [],
    ],
  ])("hazard HZ-005 refuses or gives a variable dose from %s", (_name, overrides, expected) => {
    expect(problems(input({ ...base, ...overrides }))).toEqual(expected);
  });

  it("gives the checked record's dose, and asks why for another amount", () => {
    const ok = checkAdministration(
      input({ ...base, dosingRecords: [checkedRecord.record] }),
      rates,
    );
    expect(ok).toEqual({
      ok: true,
      flags: [],
      prescribed: { kind: "amount", quantity: 3, unit: UNIT.mg },
      escalations: [],
    });
    const other = input({
      ...base,
      dosingRecords: [checkedRecord.record],
      amount: { quantity: 2.5, unitCode: UNIT.mg.code },
    });
    expect(problems(other)).toEqual(["amount_differs_needs_reason"]);
  });
});

describe("hazard HZ-004 a scheduled dose is recorded no earlier than its own window, early inside it and late after it", () => {
  const minutes = (n: number) => new Date(at(2, 8).getTime() + n * MINUTE);
  const critical = checkedEntry(entry({ tags: ["time_critical"] }));
  const morningDone = { recordedDueTimes: [at(2, 8)], history: [] };
  it.each<[string, Partial<AdministrationInput>, AdministrationProblem[] | AdministrationFlag[]]>([
    [
      "a minute before its window opens",
      { at: minutes(-rates.doseEarlyMinutes - 1) },
      ["dose_not_due_yet"],
    ],
    [
      "as its window opens, with no reason",
      { at: minutes(-rates.doseEarlyMinutes) },
      ["timing_reason_required"],
    ],
    [
      "a minute before its due time, with no reason",
      { at: minutes(-1) },
      ["timing_reason_required"],
    ],
    ["at its due time", { at: at(2, 8) }, []],
    ["at the end of its window", { at: minutes(rates.doseLateMinutes) }, []],
    [
      "a minute after its window, with no reason",
      { at: minutes(rates.doseLateMinutes + 1) },
      ["timing_reason_required"],
    ],
    [
      "this evening's dose at the morning round (the #162 probe)",
      { dueAt: at(2, 18), at: at(2, 8, 6), timingReason: "Going out", ...morningDone },
      ["dose_not_due_yet"],
    ],
    [
      "tomorrow's morning dose at today's round (the #162 probe)",
      { dueAt: at(3, 8), at: at(2, 8, 6), timingReason: "Going out", ...morningDone },
      ["dose_not_due_yet"],
    ],
    [
      "a refusal recorded before the window opens (never filled in ahead)",
      {
        outcome: "refused",
        amount: null,
        reason: { code: "declined", note: null },
        at: minutes(-rates.doseEarlyMinutes - 1),
      },
      ["dose_not_due_yet"],
    ],
    [
      "a time-critical dose a minute before its narrower window, inside the regular one",
      { entry: critical, at: minutes(-rates.timeCriticalEarlyMinutes - 1), timingReason: "Early" },
      ["dose_not_due_yet"],
    ],
  ])("refuses, or asks why, a dose recorded %s", (_name, overrides, expected) => {
    expect(problems(input(overrides))).toEqual(expected);
  });

  it.each<[string, Partial<AdministrationInput>, AdministrationFlag[]]>([
    ["early, inside its window", { at: minutes(-rates.doseEarlyMinutes) }, ["early"]],
    ["late, after its window", { at: minutes(rates.doseLateMinutes + 1) }, ["late"]],
    [
      "time-critical, as its narrower window opens",
      { entry: critical, at: minutes(-rates.timeCriticalEarlyMinutes) },
      ["early"],
    ],
    [
      "taken by the person before its window opened (a fact, recorded)",
      { outcome: "self_administered", at: minutes(-rates.doseEarlyMinutes - 1) },
      ["before_window"],
    ],
  ])("records a dose %s with the reason, flagged", (_name, overrides, flags) => {
    expect(
      checkAdministration(input({ ...overrides, timingReason: "Person asked for it then" }), rates),
    ).toMatchObject({ ok: true, flags });
  });

  it("names when the window opens", () => {
    const result = checkAdministration(
      input({ dueAt: at(2, 18), at: at(2, 8, 6), ...morningDone }),
      rates,
    );
    const opens = new Date(at(2, 18).getTime() - rates.doseEarlyMinutes * MINUTE);
    expect(result.ok ? "" : result.issues[0]?.message).toBe(
      `This dose is not due yet. Its window opens at ${formatUkTime(opens)} on 02/11/2026: record it then.`,
    );
  });

  it("holds a time-critical entry to its narrower window after the due time too", () => {
    const when = minutes(rates.timeCriticalLateMinutes + 1);
    expect(problems(input({ at: when }))).toEqual([]);
    expect(problems(input({ entry: critical, at: when }))).toEqual(["timing_reason_required"]);
  });
});

describe("hazard HZ-009 a dose is recorded by its window in elapsed time on the days the clocks change", () => {
  // Doses prescribed at 02:01 and 01:59 every day: on 28/03/2027 the clocks go forward at 01:00
  // GMT, so 02:01 BST is a minute after the change; on 31/10/2027 they go back at 02:00 BST, so
  // the first 01:59 is a minute before it.
  const daily = (time: string, id: string) =>
    checkedEntry(
      entry(
        {
          directions: {
            kind: "regular",
            schedule: {
              pattern: { kind: "every_day" },
              times: [{ time, dose: { kind: "amount", quantity: 2, unit: UNIT.tablet } }],
            },
          },
        },
        id,
      ),
    );
  const night = daily("02:01", "entry-night");
  const late = daily("01:59", "entry-late");
  const forward = fromUkWallClock(2027, 3, 28, 2, 1);
  const back = fromUkWallClock(2027, 10, 31, 1, 59);
  const record = (e: MarEntry, due: Date, minutes: number, timingReason: string | null = null) =>
    input({
      entry: e,
      versionIds: new Set([e.id]),
      dueAt: due,
      at: new Date(due.getTime() + minutes * MINUTE),
      timingReason,
    });
  it.each<[string, AdministrationInput, AdministrationProblem[]]>([
    [
      "forward: a minute before the window opens, the clock reading an hour more",
      record(night, forward, -rates.doseEarlyMinutes - 1, "Early"),
      ["dose_not_due_yet"],
    ],
    [
      "forward: as the window opens, early with a reason",
      record(night, forward, -rates.doseEarlyMinutes, "Early"),
      [],
    ],
    ["back: at the end of the window, on time", record(late, back, rates.doseLateMinutes), []],
    [
      "back: a minute after the window, late, the clock reading an hour less",
      record(late, back, rates.doseLateMinutes + 1),
      ["timing_reason_required"],
    ],
  ])("%s", (_name, recorded, expected) => {
    expect(problems(recorded)).toEqual(expected);
  });
});

describe("hazard HZ-004 a later dose is not given while an earlier dose of the medicine that day has no outcome", () => {
  const evening = { dueAt: at(2, 18), at: at(2, 18) };
  it.each<[string, Partial<AdministrationInput>, AdministrationProblem[]]>([
    ["given with the morning dose outstanding", evening, ["earlier_dose_outstanding"]],
    [
      "given once the morning dose has an outcome",
      { ...evening, recordedDueTimes: [at(2, 8)] },
      [],
    ],
    [
      "refused by the person with the morning dose outstanding (no dose given)",
      { ...evening, outcome: "refused", amount: null, reason: { code: "declined", note: null } },
      [],
    ],
    [
      "the morning dose, with yesterday evening's outstanding (another day)",
      { dueAt: at(3, 8), at: at(3, 8) },
      [],
    ],
  ])("%s", (_name, overrides, expected) => {
    expect(problems(input(overrides))).toEqual(expected);
  });

  it("says which dose to record first", () => {
    const result = checkAdministration(input(evening), rates);
    expect(result.ok ? "" : result.issues[0]?.message).toBe(
      "The 08:00 dose on 02/11/2026 has no outcome. Record what happened to it before giving this one.",
    );
    const four = checkedEntry(
      entry({
        directions: {
          kind: "regular",
          schedule: {
            pattern: { kind: "every_day" },
            times: ["08:00", "12:00", "18:00"].map((time) => ({
              time,
              dose: { kind: "amount" as const, quantity: 2, unit: UNIT.tablet },
            })),
          },
        },
      }),
    );
    const both = checkAdministration(input({ ...evening, entry: four }), rates);
    expect(both.ok ? "" : both.issues[0]?.message).toBe(
      "The 08:00 and 12:00 doses on 02/11/2026 have no outcome. Record what happened to them before giving this one.",
    );
  });

  it("records a dose the person already took, flagged for the nurse in charge", () => {
    expect(
      checkAdministration(input({ ...evening, outcome: "given_by_family" }), rates),
    ).toMatchObject({ ok: true, flags: ["earlier_dose_outstanding"] });
  });
});

describe("hazard HZ-004 blocks a second administration within the minimum interval unless an override reason is given", () => {
  const history = [given("d1", at(2, 11))];

  it("refuses a dose within the prescribed interval with no reason, and flags one with a reason", () => {
    expect(problems(prnInput({ history }))).toEqual(["interval_override_required"]);
    expect(
      checkAdministration(
        prnInput({ history, intervalOverrideReason: "Prescriber agreed by phone at 12:50" }),
        rates,
      ),
    ).toMatchObject({ ok: true, flags: ["interval_override"] });
  });

  it("applies the paracetamol rule across entries a person tagged paracetamol", () => {
    const tagged = checkedEntry(entry({ tags: ["paracetamol"] }));
    const other = [given("d1", at(2, 6), { entryId: "entry-cocodamol", tags: ["paracetamol"] })];
    expect(problems(input({ entry: tagged, history: other }))).toEqual([
      "interval_override_required",
    ]);
    expect(problems(input({ entry: PARACETAMOL, history: other }))).toEqual([]);
  });

  it("never lets an override reason take a when-required medicine over its 24-hour maximum", () => {
    const full = [
      given("a", at(2, 1)),
      given("b", at(2, 5)),
      given("c", at(2, 9), { quantity: 2 }),
      given("d", at(2, 12, 30), { quantity: 1 }),
    ];
    const over = prnInput({ history: full, intervalOverrideReason: "Prescriber agreed" });
    expect(problems(over)).toEqual(["prn_maximum_reached"]);
  });
});

describe("hazard HZ-004 a dose the person took themselves, or their family gave, counts towards the 24-hour maximum and is always recorded", () => {
  // Eight tablets, the maximum, in the 24 hours up to 13:00, none inside the 4-hour interval.
  const full = [
    given("a", at(2, 1)),
    given("b", at(2, 5)),
    given("c", at(2, 8)),
    given("d", at(2, 9)),
  ];
  const two = { quantity: 2, unitCode: UNIT.tablet.code };
  it.each<[string, Partial<AdministrationInput>, AdministrationProblem[]]>([
    [
      "taken by the person with no amount",
      { outcome: "self_administered", amount: null },
      ["amount_required"],
    ],
    [
      "given by family with no amount",
      { outcome: "given_by_family", amount: null },
      ["amount_required"],
    ],
    [
      "taken by the person at the maximum with no amount (the #162 probe)",
      { outcome: "given_by_family", amount: null, history: full },
      ["amount_required"],
    ],
    [
      "given by staff at the maximum",
      { outcome: "given", amount: two, history: full },
      ["prn_maximum_reached"],
    ],
    [
      "taken by the person with its amount, under the maximum",
      { outcome: "self_administered", amount: two },
      [],
    ],
  ])("%s", (_name, overrides, expected) => {
    expect(problems(prnInput(overrides))).toEqual(expected);
  });

  it.each(["self_administered", "given_by_family"] as const)(
    "records a dose %s over the maximum, flagged and escalated urgently (the #162 probe)",
    (outcome) => {
      expect(checkAdministration(prnInput({ outcome, amount: two, history: full }), rates)).toEqual(
        {
          ok: true,
          flags: ["over_maximum"],
          prescribed: PRN.directions.kind === "when_required" ? PRN.directions.dose : null,
          escalations: [
            {
              severity: "urgent",
              reason: "over_maximum",
              message:
                "More than the most allowed in 24 hours has been taken: 10 tablets against a maximum of 8 tablets. Tell the nurse in charge now, who follows your organisation's policy and contacts the prescriber.",
            },
          ],
        },
      );
    },
  );

  it("needs no amount for a dose taken from a regular entry, which has no 24-hour maximum", () => {
    expect(problems(input({ outcome: "self_administered", amount: null }))).toEqual([]);
  });

  it("counts a dose already taken, so staff cannot then give over the maximum", () => {
    const taken = [
      given("a", at(2, 1)),
      given("b", at(2, 5)),
      given("f", at(2, 9), { quantity: 4 }),
    ];
    expect(problems(prnInput({ amount: two, history: taken }))).toEqual(["prn_maximum_reached"]);
  });

  it("asks what happened, never refuses, a dose already taken inside the interval", () => {
    const close = [given("d1", at(2, 11))];
    const result = checkAdministration(
      prnInput({ outcome: "self_administered", amount: two, history: close }),
      rates,
    );
    expect(result.ok ? "" : result.issues[0]?.message).toBe(
      "This dose was taken within the prescribed minimum interval of another. Say what happened.",
    );
  });

  it("flags a dose of the medicine in another unit as not counted, never converting it", () => {
    const ml = [given("m", at(2, 9), { unitCode: UNIT.ml.code, quantity: 10 })];
    expect(checkAdministration(prnInput({ amount: two, history: ml }), rates)).toMatchObject({
      ok: true,
      flags: ["other_unit_not_counted"],
    });
  });
});

describe("hazard HZ-119 expired medicines competence blocks an administration", () => {
  it.each(["expired", "not_held"] as const)(
    "refuses every outcome from a member whose competence is %s",
    (competence) => {
      expect(problems(input({ administrator: { id: CARER, competence } }))).toEqual([
        competence === "expired" ? "competence_expired" : "competence_not_held",
      ]);
      const refusal = input({
        administrator: { id: CARER, competence },
        outcome: "refused",
        amount: null,
        reason: { code: "declined", note: null },
      });
      expect(problems(refusal)).toHaveLength(1);
    },
  );

  it("never lets an override through for a member who was never signed off (NICE SC1 1.18)", () => {
    const override = {
      memberId: CARER,
      approvedBy: "member-manager",
      reason: "Short-staffed",
      from: at(2, 7),
      until: at(2, 12),
    };
    expect(
      problems(
        input({
          administrator: { id: CARER, competence: "not_held" },
          competenceOverride: override,
        }),
      ),
    ).toEqual(["competence_not_held"]);
  });

  it("lets a manager's override through, logged as a flag for the override report", () => {
    const override = {
      memberId: CARER,
      approvedBy: "member-manager",
      reason: "Check booked Friday",
      from: at(2, 7),
      until: at(2, 12),
    };
    expect(
      checkAdministration(
        input({
          administrator: { id: CARER, competence: "expired" },
          competenceOverride: override,
        }),
        rates,
      ),
    ).toMatchObject({ ok: true, flags: ["competence_override"] });
  });
});

describe("hazard HZ-003 a round cannot close with outstanding doses without a reason", () => {
  const doses: RoundDose[] = [
    { entryId: "a", dueAt: at(2, 8), timeCritical: false, recorded: true },
    { entryId: "b", dueAt: at(2, 8), timeCritical: false, recorded: false },
    { entryId: "c", dueAt: at(2, 8, 30), timeCritical: true, recorded: false },
  ];

  it("refuses to close with doses outstanding, listing them time-critical first", () => {
    const result = checkRoundClose(doses, null);
    expect(result).toMatchObject({
      ok: false,
      message: "2 doses have no outcome. Record them, or say why the round closes without them.",
    });
    expect(result.outstanding.map((d) => d.entryId)).toEqual(["c", "b"]);
  });

  it("closes with a reason, keeping the outstanding doses for the handover, and closes freely when none are", () => {
    expect(checkRoundClose(doses, "Two people out on a trip; doses with them")).toMatchObject({
      ok: true,
      outstanding: [{ entryId: "c" }, { entryId: "b" }],
    });
    expect(checkRoundClose([doses[0] as RoundDose], null)).toEqual({ ok: true, outstanding: [] });
  });
});

describe("hazard HZ-004 a MAR row locks once synced and changes only by a referenced correction", () => {
  const record: RecordedAdministration = {
    id: "admin-1",
    personId: PERSON,
    entryId: "entry-1",
    dueAt: at(2, 8),
    recordedBy: CARER,
    serverReceivedAt: null,
    supersededById: null,
  };
  const synced = { ...record, serverReceivedAt: at(2, 8, 7) };

  it("lets the author amend it on the device until it syncs, and no one after", () => {
    expect(marRowLocked(record)).toBe(false);
    expect(checkAmendment(record, CARER)).toBeNull();
    expect(checkAmendment(record, "member-other")).toBe("not_author");
    expect(marRowLocked(synced)).toBe(true);
    expect(checkAmendment(synced, CARER)).toBe("row_locked");
  });

  const refusal = input({
    outcome: "refused",
    amount: null,
    reason: { code: "declined", note: null },
    alreadyRecorded: true,
  });
  const correctionProblems = (
    original: RecordedAdministration,
    reason: string,
    corrected: AdministrationInput,
  ) => {
    const result = checkCorrection(original, { reason, record: corrected }, rates);
    return result.ok ? [] : result.issues.map((i) => i.problem);
  };

  it.each<[string, RecordedAdministration, string, AdministrationInput, string[]]>([
    [
      "the latest record, for the same person and dose, with a reason",
      synced,
      "Recorded as given; the person refused",
      refusal,
      [],
    ],
    [
      "a record already corrected",
      { ...synced, supersededById: "admin-2" },
      "Refused",
      refusal,
      ["already_corrected"],
    ],
    ["with no reason", synced, " ", refusal, ["correction_reason_required"]],
    [
      "that moves the record to another dose",
      synced,
      "Wrong dose",
      { ...refusal, dueAt: at(2, 18), at: at(2, 18) },
      ["correction_moves_dose"],
    ],
    [
      "that moves the record to another person",
      synced,
      "Wrong person",
      { ...refusal, personId: "person-ben-example" },
      ["correction_moves_dose", "wrong_person"],
    ],
  ])(
    "hazard HZ-004 takes or refuses a correction of %s",
    (_name, original, reason, corrected, expected) => {
      expect(correctionProblems(original, reason, corrected)).toEqual(expected);
    },
  );

  // "Refused" corrected to "given" meets every rule a dose given then would (the #162 review).
  const toGiven = (overrides: Partial<AdministrationInput>) =>
    input({ alreadyRecorded: true, ...overrides });
  const prnRecord: RecordedAdministration = {
    ...synced,
    id: "admin-p",
    entryId: "entry-prn",
    dueAt: null,
  };
  it.each<[string, RecordedAdministration, AdministrationInput, AdministrationProblem[]]>([
    ["a dose given then", synced, toGiven({}), []],
    [
      "by a member whose competence has expired",
      synced,
      toGiven({ administrator: { id: CARER, competence: "expired" } }),
      ["competence_expired"],
    ],
    [
      "by a member never signed off",
      synced,
      toGiven({ administrator: { id: CARER, competence: "not_held" } }),
      ["competence_not_held"],
    ],
    ["with no amount", synced, toGiven({ amount: null }), ["amount_required"]],
    [
      "an amount that is not the dose, unexplained",
      synced,
      toGiven({ amount: { quantity: 1, unitCode: UNIT.tablet.code } }),
      ["amount_differs_needs_reason"],
    ],
    [
      "given before its window opened",
      synced,
      toGiven({ at: new Date(at(2, 8).getTime() - (rates.doseEarlyMinutes + 1) * MINUTE) }),
      ["dose_not_due_yet"],
    ],
    [
      "from an entry held until it is checked",
      synced,
      toGiven({ entry: entry(), policy: "hold_until_checked" }),
      ["entry_not_usable"],
    ],
    [
      "over the 24-hour maximum",
      prnRecord,
      prnInput({
        alreadyRecorded: true,
        history: [given("a", at(2, 1), { quantity: 4 }), given("b", at(2, 7), { quantity: 4 })],
      }),
      ["prn_maximum_reached"],
    ],
    [
      "whose own record is in the history: left out, so neither counted twice nor too close to itself",
      prnRecord,
      prnInput({
        alreadyRecorded: true,
        history: [
          given("a", at(2, 1), { quantity: 4 }),
          given("b", at(2, 7), { quantity: 2 }),
          given("admin-p", at(2, 13)),
        ],
      }),
      [],
    ],
  ])(
    "hazard HZ-004 checks a record corrected to %s like a new record",
    (_name, original, corrected, expected) => {
      expect(
        correctionProblems(original, "Recorded as refused; the dose was given", corrected),
      ).toEqual(expected);
    },
  );

  it("returns the corrected record's flags and what was prescribed when it is taken", () => {
    expect(
      checkCorrection(synced, { reason: "Was given", record: toGiven({ entry: entry() }) }, rates),
    ).toMatchObject({ ok: true, flags: ["entry_not_yet_checked"], escalations: [] });
  });
});
