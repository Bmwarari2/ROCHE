import { describe, expect, it } from "vitest";
import { CHECKER, entry, PERSON, UNIT } from "../../test/medicines-fixtures";
import { CLINIC_RECORD, WARFARIN } from "../../test/medicines-variable";
import { tableMedicinesRates } from "../../test/rate-table";
import { fromUkWallClock } from "../shared/time";
import {
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

  it("refuses with no dosing record, or one nobody has checked", () => {
    expect(problems(input(base))).toEqual(["no_checked_dosing_record"]);
    expect(problems(input({ ...base, dosingRecords: [record.record] }))).toEqual([
      "no_checked_dosing_record",
    ]);
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
    });
    const other = input({
      ...base,
      dosingRecords: [checkedRecord.record],
      amount: { quantity: 2.5, unitCode: UNIT.mg.code },
    });
    expect(problems(other)).toEqual(["amount_differs_needs_reason"]);
  });
});

describe("late and early doses, with time-critical rules (ADR-0082)", () => {
  it.each([
    ["late", rates.doseLateMinutes + 1],
    ["early", -rates.doseEarlyMinutes - 1],
  ] as const)("asks why a dose is %s, and flags it", (timing, minutes) => {
    const when = new Date(at(2, 8).getTime() + minutes * MINUTE);
    expect(problems(input({ at: when }))).toEqual(["timing_reason_required"]);
    expect(
      checkAdministration(input({ at: when, timingReason: "Person asleep until 09:30" }), rates),
    ).toMatchObject({
      ok: true,
      flags: [timing],
    });
  });

  it("holds a time-critical entry to its narrower window", () => {
    const when = new Date(at(2, 8).getTime() + (rates.timeCriticalLateMinutes + 1) * MINUTE);
    const critical = checkedEntry(entry({ tags: ["time_critical"] }));
    expect(problems(input({ at: when }))).toEqual([]);
    expect(problems(input({ entry: critical, at: when }))).toEqual(["timing_reason_required"]);
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

  it("takes a correction of the latest record for the same person and dose, with a reason", () => {
    const correction = {
      reason: "Recorded as given; the person refused",
      personId: PERSON,
      entryId: "entry-1",
      dueAt: at(2, 8),
    };
    expect(checkCorrection(synced, correction)).toEqual([]);
    expect(checkCorrection({ ...synced, supersededById: "admin-2" }, correction)).toEqual([
      "already_corrected",
    ]);
    expect(checkCorrection(synced, { ...correction, reason: "" })).toEqual(["reason_required"]);
    expect(checkCorrection(synced, { ...correction, dueAt: at(2, 18) })).toEqual([
      "correction_moves_dose",
    ]);
    expect(checkCorrection(synced, { ...correction, personId: "person-ben-example" })).toEqual([
      "correction_moves_dose",
    ]);
  });
});
