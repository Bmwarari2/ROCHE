import { describe, expect, it } from "vitest";
import { CHECKER, entry, PERSON, UNIT } from "../../test/medicines-fixtures";
import { CLINIC_RECORD, WARFARIN } from "../../test/medicines-variable";
import { tableMedicinesRates } from "../../test/rate-table";
import {
  addUkMonths,
  formatUkTime,
  fromUkWallClock,
  toUkWallClock,
  ukStartOfDay,
} from "../shared/time";
import {
  type AdministrationFlag,
  type AdministrationInput,
  type AdministrationProblem,
  checkAdministration,
  checkAmendment,
  checkCorrection,
  checkRoundClose,
  countReportedFlags,
  GIVEN_BEFORE_RECORDED_REASON_MIN_LENGTH,
  marRowLocked,
  OUTCOME_REASONS,
  OUTCOME_WORDS,
  REASON_WORDS,
  REPORTED_FLAGS,
  type RecordedAdministration,
  type RoundDose,
} from "./administration";
import { medicinesCompetenceAt } from "./competence";
import { checkDosingRecord, recordDosingRecord } from "./dosing-record";
import type { GivenDose } from "./intervals";
import { type MarEntry, marEntryDoses, recordSecondCheck } from "./mar-entry";

const rates = tableMedicinesRates();
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
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
    // The same competence when the record is made, unless a test says otherwise.
    competenceAtRecording: overrides.administrator?.competence ?? "current",
    competenceOverride: null,
    policy: "give_with_notice",
    alreadyRecorded: false,
    givenBeforeRecorded: null,
    // The server's time of recording: a minute after the dose, unless a test says otherwise.
    recordedAt: new Date((overrides.at ?? at(2, 8, 5)).getTime() + MINUTE),
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

describe("hazard HZ-004 a scheduled dose is recorded no earlier than its own window, on time inside it and late after it", () => {
  const minutes = (n: number) => new Date(at(2, 8).getTime() + n * MINUTE);
  const critical = checkedEntry(entry({ tags: ["time_critical"] }));
  const morningDone = { recordedDueTimes: [at(2, 8)], history: [] };
  it.each<[string, Partial<AdministrationInput>, AdministrationProblem[] | AdministrationFlag[]]>([
    [
      "a minute before its window opens",
      { at: minutes(-rates.doseEarlyMinutes - 1) },
      ["dose_not_due_yet"],
    ],
    ["as its window opens: on time", { at: minutes(-rates.doseEarlyMinutes) }, []],
    ["a minute before its due time: on time", { at: minutes(-1) }, []],
    ["at its due time", { at: at(2, 8) }, []],
    [
      "at the end of its window, recorded then",
      { at: minutes(rates.doseLateMinutes), recordedAt: minutes(rates.doseLateMinutes) },
      [],
    ],
    [
      "at the end of its window, recorded a minute later: late, as lateness is judged when recorded",
      { at: minutes(rates.doseLateMinutes), recordedAt: minutes(rates.doseLateMinutes + 1) },
      ["timing_reason_required"],
    ],
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
      "tomorrow's morning dose at today's round (the #162 probe), this evening's outstanding",
      { dueAt: at(3, 8), at: at(2, 8, 6), timingReason: "Going out", ...morningDone },
      ["dose_not_due_yet", "earlier_dose_outstanding"],
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
    [
      "inside its window, before its due time: on time, unflagged",
      { at: minutes(-rates.doseEarlyMinutes) },
      [],
    ],
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

describe("hazard HZ-004 a dose asks why when time-critical and early, or, late or not, when closer to the last dose than the schedule allows", () => {
  // 08:00 and 18:00: ten hours apart. The window's early side is the table's figure.
  const evening = (minutesEarly: number) => new Date(at(2, 18).getTime() - minutesEarly * MINUTE);
  const morningAt = (when: Date) => [given("m", when, { entryId: "entry-1" })];
  const critical = checkedEntry(entry({ tags: ["time_critical"] }));
  const gapLimit = 10 * 60 - rates.doseEarlyMinutes;
  const lateMorning = new Date(at(2, 8).getTime() + rates.doseLateMinutes * MINUTE);
  it.each<[string, Partial<AdministrationInput>, AdministrationProblem[]]>([
    [
      "early, the morning dose given on time: on time, no reason",
      { at: evening(rates.doseEarlyMinutes), history: morningAt(at(2, 8)) },
      [],
    ],
    [
      "early, the morning dose given late in its window: too close",
      { at: evening(rates.doseEarlyMinutes), history: morningAt(lateMorning) },
      ["timing_reason_required"],
    ],
    [
      "a gap a minute short of the schedule less the window",
      {
        at: evening(1),
        history: morningAt(new Date(evening(1).getTime() - (gapLimit - 1) * MINUTE)),
      },
      ["timing_reason_required"],
    ],
    [
      "a gap of exactly the schedule less the window",
      { at: evening(1), history: morningAt(new Date(evening(1).getTime() - gapLimit * MINUTE)) },
      [],
    ],
    [
      "at its due time, the morning dose given well after its window: too close, though on time",
      {
        at: at(2, 18),
        history: morningAt(new Date(at(2, 18).getTime() - (gapLimit - 1) * MINUTE)),
      },
      ["timing_reason_required"],
    ],
    [
      "late, the morning dose given late too: asked once, for both",
      {
        at: new Date(at(2, 18).getTime() + (rates.doseLateMinutes + 1) * MINUTE),
        history: morningAt(new Date(at(2, 18).getTime() - (gapLimit - 1) * MINUTE)),
      },
      ["timing_reason_required"],
    ],
    ["no earlier dose recorded", { at: evening(rates.doseEarlyMinutes) }, []],
    [
      "the latest of several earlier doses decides (yesterday's on time, this morning's late)",
      {
        at: evening(rates.doseEarlyMinutes),
        history: [
          given("y", new Date(at(2, 8).getTime() - 14 * 60 * MINUTE), { entryId: "entry-1" }),
          given("m", lateMorning, { entryId: "entry-1" }),
        ],
      },
      ["timing_reason_required"],
    ],
    [
      "a time-critical entry a minute before its due time",
      { entry: critical, at: evening(1), history: morningAt(at(2, 8)) },
      ["timing_reason_required"],
    ],
  ])("%s", (_name, overrides, expected) => {
    expect(
      problems(input({ dueAt: at(2, 18), recordedDueTimes: [at(2, 8)], ...overrides })),
    ).toEqual(expected);
  });

  // Four times a day: the 08:00 dose given late at 10:30, then the 12:00 dose at 12:00 (the
  // re-check's case: nothing was asked before).
  const QDS = checkedEntry(
    entry(
      {
        directions: {
          kind: "regular",
          schedule: {
            pattern: { kind: "every_day" },
            times: ["08:00", "12:00", "16:00", "20:00"].map((time) => ({
              time,
              dose: { kind: "amount" as const, quantity: 2, unit: UNIT.tablet },
            })),
          },
        },
      },
      "entry-q",
    ),
  );
  const noon = {
    entry: QDS,
    versionIds: new Set(["entry-q"]),
    dueAt: at(2, 12),
    at: at(2, 12),
    recordedDueTimes: [at(2, 8)],
    history: [given("q", at(2, 10, 30), { entryId: "entry-q" })],
  };
  it.each<[string, Partial<AdministrationInput>, AdministrationFlag[] | AdministrationProblem[]]>([
    ["with no reason", {}, ["timing_reason_required"]],
    [
      "with a reason, flagged",
      { timingReason: "Morning dose was given late at 10:30" },
      ["close_to_last_dose"],
    ],
  ])(
    "hazard HZ-004 the 12:00 dose at 12:00 after the 08:00 dose at 10:30, %s",
    (_name, overrides, expected) => {
      const result = checkAdministration(input({ ...noon, ...overrides }), rates);
      expect(result.ok ? result.flags : result.issues.map((i) => i.problem)).toEqual(expected);
    },
  );

  it("says why it asks, naming the last dose, and flags every reason it was asked for", () => {
    const close = {
      dueAt: at(2, 18),
      recordedDueTimes: [at(2, 8)],
      at: evening(rates.doseEarlyMinutes),
      history: morningAt(lateMorning),
    };
    const asked = checkAdministration(input(close), rates);
    expect(asked.ok ? "" : asked.issues[0]?.message).toBe(
      `This dose is closer to the last dose, given at ${formatUkTime(lateMorning)}, than the schedule allows. Say why.`,
    );
    expect(
      checkAdministration(input({ ...close, timingReason: "Going out with family" }), rates),
    ).toMatchObject({ ok: true, flags: ["close_to_last_dose"] });
    const lateAndClose = checkAdministration(
      input({
        ...close,
        at: new Date(at(2, 18).getTime() + (rates.doseLateMinutes + 1) * MINUTE),
        history: morningAt(new Date(at(2, 18).getTime() - 60 * MINUTE)),
        timingReason: "Both doses late after a hospital visit",
      }),
      rates,
    );
    expect(lateAndClose).toMatchObject({ ok: true, flags: ["late", "close_to_last_dose"] });
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
  // The day before's dose has its outcome (23 hours before on the day the clocks go forward).
  const record = (e: MarEntry, due: Date, minutes: number, timingReason: string | null = null) =>
    input({
      entry: e,
      versionIds: new Set([e.id]),
      dueAt: due,
      at: new Date(due.getTime() + minutes * MINUTE),
      recordedAt: new Date(due.getTime() + minutes * MINUTE),
      timingReason,
      recordedDueTimes: marEntryDoses(e, { from: new Date(due.getTime() - 2 * DAY), to: due }).map(
        (d) => d.dueAt,
      ),
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

describe("hazard HZ-004 a later dose is not given while an earlier dose of the medicine in the 24 hours before it has no outcome", () => {
  const evening = { dueAt: at(2, 18), at: at(2, 18) };
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
      "the morning dose, with yesterday evening's outstanding (the 24 hours before it)",
      { dueAt: at(3, 8), at: at(3, 8), recordedDueTimes: [at(2, 8)] },
      ["earlier_dose_outstanding"],
    ],
    [
      "the morning dose, with yesterday morning's outstanding (24 hours before, not inside them)",
      { dueAt: at(3, 8), at: at(3, 8), recordedDueTimes: [at(2, 18)] },
      [],
    ],
  ])("%s", (_name, overrides, expected) => {
    expect(problems(input(overrides))).toEqual(expected);
  });

  it("says which dose to record first", () => {
    const result = checkAdministration(input(evening), rates);
    expect(result.ok ? "" : result.issues[0]?.message).toBe(
      "The dose at 08:00 on 02/11/2026 has no outcome. Record what happened to it before giving this one.",
    );
    const both = checkAdministration(input({ ...evening, entry: four }), rates);
    expect(both.ok ? "" : both.issues[0]?.message).toBe(
      "The doses at 08:00 and 12:00 on 02/11/2026 have no outcome. Record what happened to them before giving this one.",
    );
  });

  it("names doses on two days by their dates", () => {
    const result = checkAdministration(
      input({ entry: four, dueAt: at(3, 12), at: at(3, 12) }),
      rates,
    );
    expect(result.ok ? "" : result.issues[0]?.message).toBe(
      "The doses at 18:00 on 02/11/2026 and 08:00 on 03/11/2026 have no outcome. Record what happened to them before giving this one.",
    );
  });

  it("records a dose the person already took, flagged and sent to the nurse in charge to review", () => {
    expect(
      checkAdministration(input({ ...evening, outcome: "given_by_family" }), rates),
    ).toMatchObject({
      ok: true,
      flags: ["earlier_dose_outstanding"],
      escalations: [
        {
          severity: "urgent",
          reason: "review",
          message:
            "Recorded for the nurse in charge to review under your organisation's policy: an earlier dose had no outcome.",
        },
      ],
    });
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

  it.each<[string, Partial<AdministrationInput>, AdministrationFlag[], string]>([
    [
      "in another unit",
      { outcome: "given_by_family", amount: { quantity: 10, unitCode: UNIT.ml.code } },
      ["amount_in_other_unit"],
      "the amount is in another unit, so it is not in the 24-hour total",
    ],
    [
      "from an entry held until it is checked",
      {
        outcome: "self_administered",
        entry: { ...PRN, secondCheck: null },
        policy: "hold_until_checked",
        amount: two,
      },
      ["entry_not_usable", "entry_not_yet_checked"],
      "the entry may not be given from at that time",
    ],
  ])(
    "hazard HZ-004 records a dose already taken %s, flagged and escalated urgently for review",
    (_name, overrides, flags, words) => {
      expect(checkAdministration(prnInput(overrides), rates)).toMatchObject({
        ok: true,
        flags,
        escalations: [
          {
            severity: "urgent",
            reason: "review",
            message: `Recorded for the nurse in charge to review under your organisation's policy: ${words}.`,
          },
        ],
      });
    },
  );

  it("needs the amount of a variable dose the person took with no checked dose to compare it with", () => {
    const warfarin = checkedEntry(WARFARIN);
    expect(
      problems(
        input({
          entry: warfarin,
          versionIds: new Set(["entry-warf"]),
          dueAt: at(2, 18),
          at: at(2, 18),
          outcome: "self_administered",
          amount: null,
        }),
      ),
    ).toEqual(["amount_required"]);
  });

  it("records a variable dose the person took with no checked dosing record, flagged for review", () => {
    const warfarin = checkedEntry(WARFARIN);
    expect(
      checkAdministration(
        input({
          entry: warfarin,
          versionIds: new Set(["entry-warf"]),
          dueAt: at(2, 18),
          at: at(2, 18),
          outcome: "self_administered",
          amount: { quantity: 3, unitCode: UNIT.mg.code },
        }),
        rates,
      ),
    ).toMatchObject({ ok: true, flags: ["no_usable_dosing_record"], prescribed: null });
  });

  it("asks what happened, not whether it was an error, when the amount taken is not the dose", () => {
    const result = checkAdministration(
      prnInput({ outcome: "given_by_family", amount: { quantity: 3, unitCode: UNIT.tablet.code } }),
      rates,
    );
    expect(result.ok ? "" : result.issues[0]?.message).toBe(
      "The amount taken is not the prescribed dose. Say what happened; the nurse in charge reviews it.",
    );
  });

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
    at: at(2, 8, 5),
    // Recorded as refused; corrections below say what really happened.
    outcome: "refused",
    amount: null,
    administeredBy: CARER,
    recordedBy: CARER,
    serverReceivedAt: null,
    supersededById: null,
  };
  const synced = { ...record, serverReceivedAt: at(2, 8, 7) };
  const TWO = { quantity: 2, unitCode: UNIT.tablet.code };
  const givenSynced: RecordedAdministration = { ...synced, outcome: "given", amount: TWO };
  const NURSE: Parameters<typeof checkCorrection>[1]["correctedBy"] = {
    id: "member-nurse",
    competence: "current",
    override: null,
  };

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
  const correct = (
    original: RecordedAdministration,
    corrected: AdministrationInput,
    correctedBy: Parameters<typeof checkCorrection>[1]["correctedBy"] = NURSE,
    reason = "Recorded as refused; the dose was given",
  ) => checkCorrection(original, { reason, record: corrected, correctedBy }, rates);
  const correctionProblems = (...args: Parameters<typeof correct>) => {
    const result = correct(...args);
    return result.ok ? [] : result.issues.map((i) => i.problem);
  };

  const prnRecord: RecordedAdministration = {
    ...synced,
    id: "admin-p",
    entryId: "entry-prn",
    dueAt: null,
    at: at(2, 13),
  };
  it.each<
    [string, RecordedAdministration, AdministrationInput, Partial<typeof NURSE>, string, string[]]
  >([
    [
      "the latest record, for the same person and dose, with a reason",
      givenSynced,
      refusal,
      {},
      "Recorded as given; the person refused",
      [],
    ],
    [
      "a record already corrected",
      { ...givenSynced, supersededById: "admin-2" },
      refusal,
      {},
      "Recorded as given; the person refused",
      ["already_corrected"],
    ],
    ["with no reason", givenSynced, refusal, {}, " ", ["correction_reason_required"]],
    [
      'with a reason too short to say what happened ("typo")',
      givenSynced,
      refusal,
      {},
      "typo",
      ["correction_reason_required"],
    ],
    [
      "that moves the record to another dose",
      givenSynced,
      { ...refusal, dueAt: at(2, 18), at: at(2, 18), recordedAt: at(2, 18, 1) },
      {},
      "Recorded against the wrong dose",
      ["correction_moves_dose"],
    ],
    [
      "that moves the record to another person",
      givenSynced,
      { ...refusal, personId: "person-ben-example" },
      {},
      "Recorded against the wrong person",
      ["correction_moves_dose", "wrong_person"],
    ],
    [
      "of a when-required dose to another time that day",
      prnRecord,
      prnInput({ at: at(2, 12), alreadyRecorded: true }),
      {},
      "Given at 12:00, not 13:00",
      [],
    ],
    [
      "that moves a when-required dose to another day",
      prnRecord,
      prnInput({ at: at(3, 12), alreadyRecorded: true }),
      {},
      "Recorded on the wrong day by mistake",
      ["correction_moves_dose"],
    ],
    [
      "recorded by someone whose competence has expired",
      givenSynced,
      refusal,
      { competence: "expired" },
      "Recorded as given; the person refused",
      ["competence_expired"],
    ],
    [
      "recorded by someone never signed off",
      givenSynced,
      refusal,
      { competence: "not_held" },
      "Recorded as given; the person refused",
      ["competence_not_held"],
    ],
    [
      "of a time later than now, beyond the clock's tolerance",
      givenSynced,
      {
        ...refusal,
        at: new Date(at(2, 8, 30).getTime() + (rates.clockDriftMinutes + 1) * MINUTE),
        recordedAt: at(2, 8, 30),
      },
      {},
      "Recorded as given; the person refused",
      ["recorded_in_future"],
    ],
  ])(
    "hazard HZ-004 takes or refuses a correction %s",
    (_name, original, corrected, by, reason, expected) => {
      expect(correctionProblems(original, corrected, { ...NURSE, ...by }, reason)).toEqual(
        expected,
      );
    },
  );

  // "Refused" corrected to "given": every rule a dose given then meets, but as a record of what
  // happened: what would refuse a dose about to be given flags it for review, and over the
  // maximum escalates it urgently, so a dose given is never left off the record (#162 reviews).
  const toGiven = (overrides: Partial<AdministrationInput>) =>
    input({ alreadyRecorded: true, ...overrides });
  const fullPrn = [given("a", at(2, 1), { quantity: 4 }), given("b", at(2, 7), { quantity: 4 })];
  // The author corrects their own record, unless a row says otherwise.
  const AUTHOR = { id: CARER, competence: "current" as const, override: null };
  const REASON = "Recorded as refused; the dose was given";
  type Row = {
    original?: RecordedAdministration;
    reason?: string;
    by?: Parameters<typeof checkCorrection>[1]["correctedBy"];
    problems?: AdministrationProblem[];
    flags?: AdministrationFlag[];
    escalated?: string[];
  };
  it.each<[string, AdministrationInput, Row]>([
    [
      "a dose given then",
      toGiven({}),
      { flags: ["given_before_recorded", "corrected"], escalated: ["warning:review"] },
    ],
    ["with no amount", toGiven({ amount: null }), { problems: ["amount_required"] }],
    [
      "an amount that is not the dose, unexplained",
      toGiven({ amount: { quantity: 1, unitCode: UNIT.tablet.code } }),
      { problems: ["amount_differs_needs_reason"] },
    ],
    [
      'with a short reason (the re-check\'s probe: "wrong button")',
      toGiven({}),
      { reason: "wrong button", problems: ["given_before_recorded_reason_required"] },
    ],
    [
      "given after the correction is recorded (the re-check's probe)",
      toGiven({ at: at(2, 8, 50), recordedAt: at(2, 8, 7) }),
      { problems: ["given_after_recorded"] },
    ],
    [
      "by a corrector never signed off",
      toGiven({}),
      { by: { ...AUTHOR, competence: "not_held" }, problems: ["competence_not_held"] },
    ],
    [
      "by a corrector whose competence has expired, with no override",
      toGiven({}),
      { by: { ...AUTHOR, competence: "expired" }, problems: ["competence_expired"] },
    ],
    [
      "given before its window opened, with no reason",
      toGiven({ at: new Date(at(2, 8).getTime() - (rates.doseEarlyMinutes + 1) * MINUTE) }),
      { problems: ["timing_reason_required"] },
    ],
    [
      "given before its window opened, saying what happened",
      toGiven({
        at: new Date(at(2, 8).getTime() - (rates.doseEarlyMinutes + 1) * MINUTE),
        timingReason: "Given early in error",
      }),
      {
        flags: ["given_before_recorded", "before_window", "corrected"],
        escalated: ["urgent:review"],
      },
    ],
    [
      "given by a member whose competence had expired then",
      toGiven({ administrator: { id: CARER, competence: "expired" } }),
      {
        flags: ["given_before_recorded", "competence_not_current", "corrected"],
        escalated: ["urgent:review"],
      },
    ],
    [
      "given by a member never signed off (the re-check: urgent, never only a warning)",
      toGiven({ administrator: { id: CARER, competence: "not_held" } }),
      {
        flags: ["given_before_recorded", "competence_not_current", "corrected"],
        escalated: ["urgent:review"],
      },
    ],
    [
      "given from an entry held until it is checked (the re-check's probe: urgent)",
      toGiven({ entry: entry(), policy: "hold_until_checked" }),
      {
        flags: ["given_before_recorded", "entry_not_usable", "entry_not_yet_checked", "corrected"],
        escalated: ["urgent:review"],
      },
    ],
    [
      "given over the 24-hour maximum",
      prnInput({ alreadyRecorded: true, history: fullPrn }),
      {
        original: prnRecord,
        flags: ["given_before_recorded", "over_maximum", "corrected", "breach_created"],
        escalated: ["urgent:over_maximum", "urgent:review"],
      },
    ],
    [
      "whose own record is in the history: left out, so neither counted twice nor too close to itself",
      prnInput({
        alreadyRecorded: true,
        history: [
          given("a", at(2, 1), { quantity: 4 }),
          given("b", at(2, 7), { quantity: 2 }),
          given("admin-p", at(2, 13)),
        ],
      }),
      {
        original: { ...prnRecord, outcome: "given", amount: TWO },
        flags: ["given_before_recorded", "corrected"],
        escalated: ["warning:review"],
      },
    ],
    [
      "by a manager, not the member who gave it",
      toGiven({}),
      {
        by: NURSE,
        flags: ["given_before_recorded", "given_by_someone_else", "corrected"],
        escalated: ["warning:review"],
      },
    ],
    [
      "taken by the person themselves (any outcome recording that a dose happened)",
      toGiven({ outcome: "self_administered" }),
      { flags: ["given_before_recorded", "corrected"], escalated: ["warning:review"] },
    ],
  ])(
    "hazard HZ-004 hazard HZ-119 records a dose corrected to %s by the rules for a dose recorded after it was given",
    (_name, corrected, row) => {
      const result = correct(
        row.original ?? synced,
        corrected,
        row.by ?? AUTHOR,
        row.reason ?? REASON,
      );
      if (row.problems) {
        expect(result.ok ? [] : result.issues.map((i) => i.problem)).toEqual(row.problems);
        return;
      }
      expect(result).toMatchObject({ ok: true, flags: row.flags });
      expect(result.ok ? result.escalations.map((e) => `${e.severity}:${e.reason}`) : null).toEqual(
        row.escalated,
      );
    },
  );

  it("counts a correction to a dose outcome with every dose recorded after it was given", () => {
    const corrected = correct(synced, toGiven({}), AUTHOR, REASON);
    const counts = countReportedFlags([
      { recordedBy: CARER, flags: corrected.ok ? corrected.flags : [] },
    ]);
    expect(counts.get(CARER)).toEqual({
      competence_override: 0,
      given_before_recorded: 1,
      corrected: 1,
      dose_removed: 0,
      dose_moved: 0,
    });
  });

  it.each<[string, AdministrationInput]>([
    ["a refusal", refusal],
    ["a dose given", toGiven({})],
  ])(
    "flags a correction to %s recorded under an override of the corrector's expired competence",
    (_name, corrected) => {
      const override = {
        memberId: CARER,
        approvedBy: "member-manager",
        reason: "Check booked",
        from: at(2, 8),
        until: at(2, 10),
      };
      const result = correct(
        synced,
        corrected,
        { ...AUTHOR, competence: "expired", override },
        REASON,
      );
      expect(result.ok ? result.flags : []).toContain("competence_override");
    },
  );
});

describe("hazard HZ-004 a dose staff record after giving it is recorded, flagged and escalated, never lost", () => {
  const REASON = "Given before the round opened on the tablet";
  const route = (
    recordedBy: Partial<NonNullable<AdministrationInput["givenBeforeRecorded"]>["recordedBy"]> = {},
    reason = REASON,
  ) => ({
    givenBeforeRecorded: {
      reason,
      recordedBy: { id: CARER, competence: "current" as const, override: null, ...recordedBy },
    },
  });
  const fullPrn = [given("a", at(2, 1), { quantity: 4 }), given("b", at(2, 7), { quantity: 4 })];
  const prnOver = {
    entry: PRN,
    dueAt: null,
    versionIds: new Set(["entry-prn"]),
    at: at(2, 13),
    recordedAt: at(2, 13, 20),
    history: fullPrn,
  };
  const result = (overrides: Partial<AdministrationInput>) =>
    checkAdministration(input(overrides), rates);
  const escalated = (r: ReturnType<typeof result>) =>
    r.ok ? r.escalations.map((e) => `${e.severity}:${e.reason}`) : null;

  it.each<[string, Partial<AdministrationInput>, AdministrationProblem[]]>([
    [
      "over the 24-hour maximum, on the round",
      { ...prnOver, recordedAt: at(2, 13, 1) },
      ["prn_maximum_reached"],
    ],
    [
      "with a reason of a full stop (the #162 probe)",
      route({}, "."),
      ["given_before_recorded_reason_required"],
    ],
    [
      "with a reason one character short",
      route({}, "x".repeat(GIVEN_BEFORE_RECORDED_REASON_MIN_LENGTH - 1)),
      ["given_before_recorded_reason_required"],
    ],
    [
      "given at the moment it is recorded",
      { ...route(), recordedAt: at(2, 8, 5) },
      ["given_after_recorded"],
    ],
    [
      "given after it is recorded (the dose not yet given)",
      { ...route(), recordedAt: at(2, 8) },
      ["given_after_recorded"],
    ],
    [
      "recorded by a member never signed off (the #162 probe)",
      {
        ...route({ competence: "not_held" }),
        administrator: { id: CARER, competence: "not_held" },
      },
      ["competence_not_held"],
    ],
    [
      "recorded by a member whose competence has expired, with no override",
      route({ competence: "expired" }),
      ["competence_expired"],
    ],
  ])(
    "hazard HZ-004 hazard HZ-119 refuses a dose recorded after giving it %s",
    (_name, overrides, expected) => {
      expect(problems(input(overrides))).toEqual(expected);
    },
  );

  const W = checkedEntry(WARFARIN);
  const warfarin = {
    entry: W,
    versionIds: new Set(["entry-warf"]),
    dueAt: at(2, 18),
    at: at(2, 18, 5),
    recordedAt: at(2, 18, 30),
    amount: { quantity: 9, unitCode: UNIT.mg.code },
  };
  it.each<[string, Partial<AdministrationInput>, AdministrationFlag[], string[]]>([
    [
      "with nothing else broken: counted, and sent for review",
      route(),
      ["given_before_recorded"],
      ["warning:review"],
    ],
    [
      "with a reason of exactly the shortest length",
      route({}, "x".repeat(GIVEN_BEFORE_RECORDED_REASON_MIN_LENGTH)),
      ["given_before_recorded"],
      ["warning:review"],
    ],
    [
      "by another member, named as the giver",
      { ...route({ id: "member-nurse" }) },
      ["given_before_recorded", "given_by_someone_else"],
      ["warning:review"],
    ],
    [
      "by another member whose competence had lapsed when they gave it",
      { ...route({ id: "member-nurse" }), administrator: { id: CARER, competence: "expired" } },
      ["given_before_recorded", "given_by_someone_else", "competence_not_current"],
      ["urgent:review"],
    ],
    [
      "over the 24-hour maximum",
      { ...route(), ...prnOver },
      ["given_before_recorded", "over_maximum"],
      ["urgent:over_maximum", "urgent:review"],
    ],
    [
      "this evening's dose given at the morning round",
      {
        ...route(),
        dueAt: at(2, 18),
        at: at(2, 8, 6),
        recordedAt: at(2, 8, 30),
        timingReason: "Given in error with the morning dose",
        recordedDueTimes: [at(2, 8)],
      },
      ["given_before_recorded", "before_window"],
      ["urgent:review"],
    ],
    [
      "from an entry held until it is checked",
      { ...route(), entry: entry(), policy: "hold_until_checked" },
      ["given_before_recorded", "entry_not_usable", "entry_not_yet_checked"],
      ["urgent:review"],
    ],
    [
      "a variable dose with no dosing record at all (the #162 probe, 9 mg)",
      { ...route(), ...warfarin },
      ["given_before_recorded", "no_usable_dosing_record"],
      ["urgent:no_prescribed_dose", "urgent:review"],
    ],
  ])(
    "hazard HZ-004 hazard HZ-005 records a dose given %s",
    (_name, overrides, flags, escalations) => {
      const r = result(overrides);
      expect(r).toMatchObject({ ok: true, flags });
      expect(escalated(r)).toEqual(escalations);
    },
  );

  it("names the amount when there is no checked dose to compare it with", () => {
    const r = result({ ...route(), ...warfarin, amount: { quantity: 50, unitCode: UNIT.mg.code } });
    expect(r.ok ? r.escalations[0]?.message : "").toBe(
      "A dose was given with no checked dose to compare it with: 50 mg recorded. Tell the nurse in charge now, who follows your organisation's policy and contacts the prescriber.",
    );
  });

  it.each<[string, string, AdministrationProblem[] | AdministrationFlag[]]>([
    ["with a reason of a full stop", ".", ["given_before_recorded_reason_required"]],
    [
      "saying what happened",
      "She refused at 08:30; recorded after the visit",
      ["given_before_recorded"],
    ],
  ])(
    "hazard HZ-004 applies the route to a refusal recorded after the event too, %s",
    (_name, reason, expected) => {
      const r = result({
        ...route({}, reason),
        outcome: "refused",
        amount: null,
        reason: { code: "declined", note: null },
      });
      expect(r.ok ? r.flags : r.issues.map((i) => i.problem)).toEqual(expected);
    },
  );

  it("counts every use of the route, and every override, per member for the override report", () => {
    const counts = countReportedFlags([
      { recordedBy: "a", flags: ["given_before_recorded", "over_maximum"] },
      { recordedBy: "a", flags: ["given_before_recorded"] },
      { recordedBy: "a", flags: ["competence_override"] },
      { recordedBy: "b", flags: ["early"] },
    ]);
    const none = { corrected: 0, dose_removed: 0, dose_moved: 0 };
    expect(Object.fromEntries(counts)).toEqual({
      a: { competence_override: 1, given_before_recorded: 2, ...none },
      b: { competence_override: 0, given_before_recorded: 0, ...none },
    });
    expect(REPORTED_FLAGS).toEqual([
      "competence_override",
      "given_before_recorded",
      "corrected",
      "dose_removed",
      "dose_moved",
    ]);
  });
});

describe("hazard HZ-004 hazard HZ-119 every correction is a reviewable event, and none frees a dose past a limit unseen", () => {
  const FOUR = { quantity: 4, unitCode: UNIT.tablet.code };
  const TWO = { quantity: 2, unitCode: UNIT.tablet.code };
  const WHY = "Recorded wrongly at the bedside; corrected after checking";
  const AUTHOR = { id: CARER, competence: "current" as const, override: null };
  const stored = (overrides: Partial<RecordedAdministration>): RecordedAdministration => ({
    id: "b",
    personId: PERSON,
    entryId: "entry-prn",
    dueAt: null,
    at: at(2, 7),
    outcome: "given",
    amount: FOUR,
    administeredBy: CARER,
    recordedBy: CARER,
    serverReceivedAt: at(2, 7, 1),
    supersededById: null,
    ...overrides,
  });
  const night = given("a", at(2, 1), { quantity: 4 });
  const prnFix = (overrides: Partial<AdministrationInput>) =>
    prnInput({
      at: at(2, 7),
      recordedAt: at(2, 12, 55),
      alreadyRecorded: true,
      history: [night, given("b", at(2, 7), { quantity: 4 })],
      ...overrides,
    });
  const refusedNow = {
    outcome: "refused" as const,
    reason: { code: "declined", note: null },
    amount: null,
  };
  type Row = {
    original: RecordedAdministration;
    corrected: AdministrationInput;
    reason?: string;
    problems?: string[];
    flags?: AdministrationFlag[];
    kinds?: string[];
    escalated?: string[];
  };
  it.each<[string, Row]>([
    [
      "'given 4' corrected to refused with the reason 'typo' (the re-check's probe)",
      {
        original: stored({}),
        corrected: prnFix(refusedNow),
        reason: "typo",
        problems: ["correction_reason_required"],
      },
    ],
    [
      "'given 4' corrected to refused: the dose removed frees room under the maximum, so urgent",
      {
        original: stored({}),
        corrected: prnFix(refusedNow),
        flags: ["corrected", "dose_removed"],
        kinds: ["outcome", "amount"],
        escalated: ["urgent:dose_removed"],
      },
    ],
    [
      "'given 4' corrected to 'given 2': a lower amount is a dose removed",
      {
        original: stored({}),
        corrected: prnFix({ amount: TWO }),
        flags: ["given_before_recorded", "corrected", "dose_removed"],
        kinds: ["amount"],
        escalated: ["urgent:dose_removed", "urgent:review"],
      },
    ],
    [
      "'given 4' at 07:00 moved to 05:00: a dose moved frees room too",
      {
        original: stored({}),
        corrected: prnFix({
          at: at(2, 5),
          amount: FOUR,
          amountDifferenceReason: "Four tablets given in error",
        }),
        flags: ["given_before_recorded", "amount_differs", "corrected", "dose_moved"],
        kinds: ["time"],
        escalated: ["urgent:dose_moved", "urgent:review"],
      },
    ],
    [
      "'taken by the person, 4 tablets' corrected to 10 ml: another unit is not counted, so removed",
      {
        original: stored({ outcome: "self_administered" }),
        corrected: prnFix({
          outcome: "self_administered",
          amount: { quantity: 10, unitCode: UNIT.ml.code },
        }),
        flags: ["given_before_recorded", "amount_in_other_unit", "corrected", "dose_removed"],
        kinds: ["amount"],
        escalated: ["urgent:dose_removed", "urgent:review"],
      },
    ],
    [
      "a dose whose 24 hours were over the maximum corrected away: the breach it hides is flagged",
      {
        original: stored({}),
        corrected: prnFix({
          ...refusedNow,
          history: [night, given("b", at(2, 7), { quantity: 4 }), given("c", at(2, 13))],
        }),
        flags: ["corrected", "dose_removed", "breach_hidden"],
        kinds: ["outcome", "amount"],
        escalated: ["urgent:dose_removed", "urgent:review"],
      },
    ],
    [
      "a dose inside the minimum interval moved out of it: the breach it hides is flagged",
      {
        original: stored({ at: at(2, 9), amount: TWO }),
        corrected: prnFix({
          at: at(2, 7),
          amount: TWO,
          history: [given("b", at(2, 9)), given("d", at(2, 11))],
        }),
        flags: ["given_before_recorded", "corrected", "dose_moved", "breach_hidden"],
        kinds: ["time"],
        escalated: ["urgent:dose_moved", "urgent:review"],
      },
    ],
    [
      "refused corrected to given over the maximum: the breach it creates is flagged",
      {
        original: stored({ outcome: "refused", amount: null, at: at(2, 13) }),
        corrected: prnFix({
          at: at(2, 13),
          recordedAt: at(2, 13, 30),
          amount: TWO,
          history: [night, given("e", at(2, 7), { quantity: 4 })],
        }),
        flags: ["given_before_recorded", "over_maximum", "corrected", "breach_created"],
        kinds: ["outcome", "amount"],
        escalated: ["urgent:over_maximum", "urgent:review"],
      },
    ],
    [
      "a routine amount correction on a regular medicine: a warning, for the CSO to confirm (H-1067)",
      {
        original: stored({
          entryId: "entry-1",
          dueAt: at(2, 8),
          at: at(2, 8, 5),
          amount: { quantity: 3, unitCode: UNIT.tablet.code },
        }),
        corrected: input({ alreadyRecorded: true, recordedAt: at(2, 9) }),
        flags: ["given_before_recorded", "corrected", "dose_removed"],
        kinds: ["amount"],
        escalated: ["warning:dose_removed", "warning:review"],
      },
    ],
    [
      "a dose moved closer to the last one than the schedule allows: the gap it creates is flagged",
      {
        original: stored({ entryId: "entry-1", dueAt: at(2, 18), at: at(2, 18, 5), amount: TWO }),
        corrected: input({
          alreadyRecorded: true,
          dueAt: at(2, 18),
          at: at(2, 17),
          recordedAt: at(2, 19),
          recordedDueTimes: [at(2, 8)],
          timingReason: "Given early before going out",
          history: [given("m", at(2, 9), { entryId: "entry-1" })],
        }),
        flags: [
          "given_before_recorded",
          "close_to_last_dose",
          "corrected",
          "dose_moved",
          "breach_created",
        ],
        kinds: ["time"],
        escalated: ["warning:dose_moved", "urgent:review"],
      },
    ],
    [
      "only the member named as giver",
      {
        original: stored({
          entryId: "entry-1",
          dueAt: at(2, 8),
          at: at(2, 8, 5),
          amount: TWO,
          administeredBy: "member-agency",
        }),
        corrected: input({ alreadyRecorded: true, recordedAt: at(2, 9) }),
        flags: ["given_before_recorded", "corrected"],
        kinds: ["giver"],
        escalated: ["warning:review"],
      },
    ],
    [
      "only the coded reason of a refusal",
      {
        original: stored({
          entryId: "entry-1",
          dueAt: at(2, 8),
          at: at(2, 8, 5),
          outcome: "refused",
          amount: null,
        }),
        corrected: input({
          alreadyRecorded: true,
          recordedAt: at(2, 9),
          outcome: "refused",
          amount: null,
          reason: { code: "other", note: "Said she would take it later" },
        }),
        flags: ["corrected"],
        kinds: ["detail"],
        escalated: [],
      },
    ],
  ])("%s", (_name, row) => {
    const result = checkCorrection(
      row.original,
      { reason: row.reason ?? WHY, record: row.corrected, correctedBy: AUTHOR },
      rates,
    );
    if (row.problems) {
      expect(result.ok ? [] : result.issues.map((i) => i.problem)).toEqual(row.problems);
      return;
    }
    expect(result).toMatchObject({ ok: true, flags: row.flags, corrected: row.kinds });
    expect(result.ok ? result.escalations.map((e) => `${e.severity}:${e.reason}`) : null).toEqual(
      row.escalated,
    );
  });

  it("says what a hidden breach was, and counts corrections and doses removed for the report", () => {
    const result = checkCorrection(
      stored({}),
      {
        reason: WHY,
        record: prnFix({
          ...refusedNow,
          history: [night, given("b", at(2, 7), { quantity: 4 }), given("c", at(2, 13))],
        }),
        correctedBy: AUTHOR,
      },
      rates,
    );
    expect(result.ok ? result.escalations.map((e) => e.message) : []).toEqual([
      'A dose recorded as taken has been corrected to "Refused". That frees room under its 24-hour maximum or minimum interval for another dose. Tell the nurse in charge, who reviews it under your organisation\'s policy.',
      "Recorded for the nurse in charge to review under your organisation's policy: the correction takes away a breach of the 24-hour maximum that the original record showed.",
    ]);
    const counts = countReportedFlags([
      { recordedBy: CARER, flags: result.ok ? result.flags : [] },
    ]);
    expect(counts.get(CARER)).toMatchObject({ corrected: 1, dose_removed: 1, dose_moved: 0 });
  });
});

describe("hazard HZ-004 a dose given now cannot be dated back on the round past an interval", () => {
  // 2 tablets at 08:00; at 11:00 a dose given inside the 4-hour interval, recorded as if at 04:00.
  const earlier = [given("d1", at(2, 8))];
  const backdated = { history: earlier, at: at(2, 4), recordedAt: at(2, 11) };
  const delay = rates.recordDelayToleranceMinutes;
  const minutesBefore = (minutes: number) => new Date(at(2, 11).getTime() - minutes * MINUTE);
  it.each<[string, Partial<AdministrationInput>, AdministrationProblem[] | AdministrationFlag[]]>([
    ["dated back on the round (the hunt for other paths)", backdated, ["recorded_after_delay"]],
    [
      "recorded the table's record delay after it was given: an ordinary record",
      { history: [], at: minutesBefore(delay), recordedAt: at(2, 11) },
      [],
    ],
    [
      "recorded a minute beyond that delay",
      { history: [], at: minutesBefore(delay + 1), recordedAt: at(2, 11) },
      ["recorded_after_delay"],
    ],
    [
      "by the route for a dose given before it was recorded, which flags and escalates it",
      {
        ...backdated,
        givenBeforeRecorded: {
          reason: "Given at 04:00 during the night, recorded now",
          recordedBy: { id: CARER, competence: "current", override: null },
        },
      },
      ["given_before_recorded"],
    ],
  ])("hazard HZ-004 a when-required dose %s", (_name, overrides, expected) => {
    const result = checkAdministration(prnInput(overrides), rates);
    expect(result.ok ? result.flags : result.issues.map((i) => i.problem)).toEqual(expected);
  });

  it.each<[string, Partial<AdministrationInput>, AdministrationProblem[] | AdministrationFlag[]]>([
    [
      "taken by the person seven hours before it is recorded, on the round",
      { outcome: "self_administered" },
      ["recorded_after_delay"],
    ],
    [
      "taken by the person seven hours before, recorded after the event",
      {
        outcome: "self_administered",
        givenBeforeRecorded: {
          reason: "She took it at 04:00 and told me this morning",
          recordedBy: { id: CARER, competence: "current", override: null },
        },
      },
      ["given_before_recorded"],
    ],
  ])("hazard HZ-004 a dose %s", (_name, overrides, expected) => {
    const result = checkAdministration(
      prnInput({
        ...backdated,
        history: [],
        amount: { quantity: 2, unitCode: UNIT.tablet.code },
        ...overrides,
      }),
      rates,
    );
    expect(result.ok ? result.flags : result.issues.map((i) => i.problem)).toEqual(expected);
  });
});

describe("hazard HZ-004 hazard HZ-119 a dose recorded within the record delay is still judged at its own time", () => {
  // Every record below is made the table's record delay after the dose, an ordinary record; each
  // rule is judged at the dose's time, so the delay never clears a limit.
  const delay = rates.recordDelayToleranceMinutes;
  const delayed = (when: Date) => new Date(when.getTime() + delay * MINUTE);
  const prnAt = (when: Date, overrides: Partial<AdministrationInput> = {}) =>
    prnInput({ at: when, recordedAt: delayed(when), ...overrides });
  // A sign-off the table's months before 03/11/2026, so competence lapses at 00:00 that day.
  const lapse = ukStartOfDay("2026-11-03");
  const signedOffAt = toUkWallClock(addUkMonths(lapse, -rates.competenceRefreshMonths));
  const signedOff = `${signedOffAt.year}-${String(signedOffAt.month).padStart(2, "0")}-${String(signedOffAt.day).padStart(2, "0")}`;
  const competenceAt = (when: Date) => ({
    id: CARER,
    competence: medicinesCompetenceAt(signedOff, when, rates).state,
  });
  const stopped = entry({ stopsAt: at(2, 12) });
  it.each<[string, AdministrationInput, AdministrationProblem[]]>([
    [
      "interval: given inside it, recorded once it has passed",
      prnAt(new Date(at(2, 8).getTime() + (240 - delay / 2) * MINUTE), {
        history: [given("d1", at(2, 8))],
      }),
      ["interval_override_required"],
    ],
    [
      "maximum: given over it, recorded after the first dose has left the 24 hours",
      prnAt(new Date(at(2, 1).getTime() + 24 * 60 * MINUTE - MINUTE), {
        history: [given("a", at(2, 1), { quantity: 4 }), given("b", at(2, 7), { quantity: 4 })],
      }),
      ["prn_maximum_reached"],
    ],
    [
      "window: given before it opens, recorded once it has opened",
      input({
        at: new Date(at(2, 8).getTime() - (rates.doseEarlyMinutes + 1) * MINUTE),
        recordedAt: delayed(new Date(at(2, 8).getTime() - (rates.doseEarlyMinutes + 1) * MINUTE)),
      }),
      ["dose_not_due_yet"],
    ],
    [
      "competence: given after it lapsed at 00:00, recorded later",
      prnAt(new Date(lapse.getTime() + 5 * MINUTE), {
        administrator: competenceAt(new Date(lapse.getTime() + 5 * MINUTE)),
      }),
      ["competence_expired"],
    ],
    [
      "competence: given before it lapsed, recorded after 00:00",
      prnAt(new Date(lapse.getTime() - MINUTE), {
        administrator: competenceAt(new Date(lapse.getTime() - MINUTE)),
      }),
      [],
    ],
    [
      "entry in force: given after it stopped, recorded later",
      input({
        entry: stopped,
        dueAt: at(2, 8),
        at: at(2, 12, 5),
        recordedAt: delayed(at(2, 12, 5)),
        timingReason: "Given late",
      }),
      ["entry_not_usable"],
    ],
  ])("%s", (_name, record, expected) => {
    expect(problems(record)).toEqual(expected);
  });
});

describe("hazard HZ-004 a dose recorded at a time later than now is refused, so it cannot step past an interval", () => {
  it.each<[string, number, AdministrationProblem[]]>([
    ["at the clock's tolerance", rates.clockDriftMinutes, []],
    ["a minute beyond it", rates.clockDriftMinutes + 1, ["recorded_in_future"]],
  ])("a dose recorded %s after now", (_name, minutes, expected) => {
    const now = at(2, 8, 5);
    expect(
      problems(input({ at: new Date(now.getTime() + minutes * MINUTE), recordedAt: now })),
    ).toEqual(expected);
  });
});

describe("hazard HZ-004 a dose entered later than others is checked against the doses after it too (the scheduled gap, both ways)", () => {
  // Four times a day: the 08:00 dose back-entered at 11:30, the 12:00 dose already given at 12:05.
  const QDS = checkedEntry(
    entry(
      {
        directions: {
          kind: "regular",
          schedule: {
            pattern: { kind: "every_day" },
            times: ["08:00", "12:00", "16:00", "20:00"].map((time) => ({
              time,
              dose: { kind: "amount" as const, quantity: 2, unit: UNIT.tablet },
            })),
          },
        },
      },
      "entry-q",
    ),
  );
  const back = {
    entry: QDS,
    versionIds: new Set(["entry-q"]),
    dueAt: at(2, 8),
    at: at(2, 11, 30),
    recordedAt: at(2, 13),
    givenBeforeRecorded: {
      reason: "Given late after a hospital visit",
      recordedBy: { id: CARER, competence: "current" as const, override: null },
    },
  };
  const next = [given("n", at(2, 12, 5), { entryId: "entry-q" })];
  it.each<[string, Partial<AdministrationInput>, AdministrationProblem[] | AdministrationFlag[]]>([
    ["with no reason (the re-check's probe)", { history: next }, ["timing_reason_required"]],
    [
      "with a reason: late, and close to the next dose",
      { history: next, timingReason: "Given late after a hospital visit" },
      ["given_before_recorded", "late", "close_to_next_dose"],
    ],
    [
      "with two later doses: the nearest decides",
      {
        history: [given("m", at(2, 16), { entryId: "entry-q" }), ...next],
        timingReason: "Given late after a hospital visit",
      },
      ["given_before_recorded", "late", "close_to_next_dose"],
    ],
    [
      "with the next dose given on time at 16:00 instead",
      {
        dueAt: at(2, 12),
        at: at(2, 12),
        history: [given("n", at(2, 16), { entryId: "entry-q" })],
        recordedDueTimes: [at(2, 8)],
      },
      ["given_before_recorded"],
    ],
  ])("hazard HZ-004 a back-entered dose %s", (_name, overrides, expected) => {
    const result = checkAdministration(input({ ...back, ...overrides }), rates);
    expect(result.ok ? result.flags : result.issues.map((i) => i.problem)).toEqual(expected);
  });

  it("names the next dose when it asks why", () => {
    const result = checkAdministration(input({ ...back, history: next }), rates);
    expect(result.ok ? "" : result.issues[0]?.message).toBe(
      "This dose is late and closer to the next dose, given at 12:05, than the schedule allows. Say why.",
    );
  });
});

describe("hazard HZ-004 hazard HZ-119 an ordinary round record passes every rule at the time given and the time recorded, or goes by the flagged route", () => {
  const stopped = checkedEntry(
    entry(
      {
        directions: {
          kind: "when_required",
          dose: { kind: "range", from: 1, to: 2, unit: UNIT.tablet },
          maxQuantityPer24Hours: 8,
        },
        minimumIntervalMinutes: 240,
        stopsAt: at(2, 10),
      },
      "entry-st",
    ),
  );
  const onStopped = { entry: stopped, dueAt: null, versionIds: new Set(["entry-st"]) };
  const override = {
    memberId: CARER,
    approvedBy: "member-manager",
    reason: "Assessment booked for tomorrow",
    from: at(2, 6),
    until: at(2, 12),
  };
  const yesterday = (hour: number, minute = 0) => fromUkWallClock(2026, 11, 1, hour, minute);
  const route = {
    givenBeforeRecorded: {
      reason: "Recorded after the visit, at the time it happened",
      recordedBy: { id: CARER, competence: "current" as const, override: null },
    },
  };
  it.each<[string, AdministrationInput, AdministrationProblem[] | AdministrationFlag[]]>([
    [
      "Y1b: given after the entry stopped at 10:00, dated back to 09:55 and recorded 10:21",
      prnInput({ ...onStopped, at: at(2, 9, 55), recordedAt: at(2, 10, 21) }),
      ["differs_at_recording_time"],
    ],
    [
      "Y1b, recorded instead after the event: judged at 09:55, flagged and escalated",
      prnInput({ ...onStopped, ...route, at: at(2, 9, 55), recordedAt: at(2, 10, 21) }),
      ["given_before_recorded"],
    ],
    [
      "Y2: the 08:00 dose given 09:25, dated 08:58, recorded 09:26: late, as recorded",
      input({ at: at(2, 8, 58), recordedAt: at(2, 9, 26) }),
      ["timing_reason_required"],
    ],
    [
      "Y2, with the reason: flagged late",
      input({ at: at(2, 8, 58), recordedAt: at(2, 9, 26), timingReason: "Round ran late today" }),
      ["late"],
    ],
    [
      "Y3b: inside the interval at 11:56, dated forward to 12:00",
      prnInput({ at: at(2, 12), recordedAt: at(2, 11, 56), history: [given("l", at(2, 8))] }),
      ["differs_at_recording_time"],
    ],
    [
      "Y4b: over the maximum at 13:12, dated forward to 13:16",
      prnInput({
        at: at(2, 13, 16),
        recordedAt: at(2, 13, 12),
        history: [
          given("y", yesterday(13, 15), { quantity: 4 }),
          given("t", at(2, 7), { quantity: 4 }),
        ],
      }),
      ["differs_at_recording_time"],
    ],
    [
      "Y5: recorded 06:56, before the 08:00 dose's window, dated forward to 07:00",
      input({ at: at(2, 7), recordedAt: at(2, 6, 56) }),
      ["differs_at_recording_time"],
    ],
    [
      "Y7: a refusal dated back three hours",
      input({
        outcome: "refused",
        reason: { code: "declined", note: null },
        amount: null,
        at: at(2, 8, 30),
        recordedAt: at(2, 11, 30),
      }),
      ["recorded_after_delay"],
    ],
    [
      "Y7, recorded instead after the event",
      input({
        ...route,
        outcome: "refused",
        reason: { code: "declined", note: null },
        amount: null,
        at: at(2, 8, 30),
        recordedAt: at(2, 11, 30),
      }),
      ["given_before_recorded"],
    ],
    [
      "Y8b: after the competence override ended at 12:00, dated back to 11:50",
      prnInput({
        administrator: { id: CARER, competence: "expired" },
        competenceOverride: override,
        at: at(2, 11, 50),
        recordedAt: at(2, 12, 16),
      }),
      ["differs_at_recording_time"],
    ],
    [
      "competence lapsing at 00:00 between the time given and the time recorded",
      prnInput({
        at: fromUkWallClock(2026, 11, 2, 23, 55),
        recordedAt: fromUkWallClock(2026, 11, 3, 0, 10),
        competenceAtRecording: "expired",
      }),
      ["differs_at_recording_time"],
    ],
    [
      "taken by the person before the entry stopped, recorded on the round after it",
      prnInput({
        ...onStopped,
        outcome: "self_administered",
        at: at(2, 9, 55),
        recordedAt: at(2, 10, 21),
      }),
      ["differs_at_recording_time"],
    ],
    [
      "an honest record within the delay, passing at both times",
      input({ at: at(2, 8, 5), recordedAt: at(2, 8, 30) }),
      [],
    ],
    [
      "an honest when-required record within the delay, passing at both times",
      prnInput({ at: at(2, 13), recordedAt: at(2, 13, 25), history: [given("l", at(2, 8))] }),
      [],
    ],
  ])("%s", (_name, record, expected) => {
    const result = checkAdministration(record, rates);
    expect(result.ok ? result.flags : result.issues.map((i) => i.problem)).toEqual(expected);
  });

  it("says what fails at the time of recording, and sends it by the flagged route", () => {
    const result = checkAdministration(
      prnInput({ at: at(2, 12), recordedAt: at(2, 11, 56), history: [given("l", at(2, 8))] }),
      rates,
    );
    expect(result.ok ? "" : result.issues[0]?.message).toBe(
      "At 11:56, when it is recorded, this would not pass: A dose was taken within the prescribed minimum interval. Do not give it unless the prescriber agrees; if you must, say why. Record it as made after the event, and say why, so the nurse in charge reviews it.",
    );
  });
});
