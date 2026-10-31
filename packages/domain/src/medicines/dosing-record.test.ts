import { describe, expect, it } from "vitest";
import { CHECKER, entry, TRANSCRIBER } from "../../test/medicines-fixtures";
import { CLINIC_RECORD, WARFARIN } from "../../test/medicines-variable";
import {
  checkDosingRecord,
  checkDosingRecordDraft,
  type DosingRecord,
  type DosingRecordDraft,
  type DosingRecordProblem,
  recordDosingRecord,
  type VariableDose,
  variableDoseFor,
} from "./dosing-record";
import type { SecondCheckInput } from "./mar-entry";

const recordedAt = new Date("2026-11-01T15:00:00Z");
const check: SecondCheckInput = {
  by: CHECKER,
  at: new Date("2026-11-01T16:00:00Z"),
  competence: "current",
  comparedWithSource: true,
  outcome: "matches_source",
  difference: null,
};
function recorded(
  draft: DosingRecordDraft = CLINIC_RECORD,
  id = "dosing-1",
  at = recordedAt,
): DosingRecord {
  const result = recordDosingRecord(WARFARIN, draft, { id, by: TRANSCRIBER, at });
  if (!result.ok) throw new Error(result.issues.map((i) => i.message).join(" "));
  return result.record;
}
function checked(record: DosingRecord): DosingRecord {
  const result = checkDosingRecord(record, check);
  if (!result.ok) throw new Error("check refused");
  return result.record;
}
const versions = new Set(["entry-warf"]);

describe("hazard HZ-005 a variable dose is given only from a dosing record that has been second-checked", () => {
  const differs = (record: DosingRecord): DosingRecord => {
    const result = checkDosingRecord(record, {
      ...check,
      outcome: "differs_from_source",
      difference: "Clinic says 2 mg on Tuesday",
    });
    if (!result.ok) throw new Error("check refused");
    return result.record;
  };
  // The clinic's newer letter, a day later, for 03/11 only: 1 mg (the #162 probe).
  const newerDraft: DosingRecordDraft = {
    ...CLINIC_RECORD,
    doses: [{ date: "2026-11-03", time: "18:00", quantity: 1 }],
  };
  const newerAt = new Date("2026-11-02T15:00:00Z");
  const first = checked(recorded());

  it.each<[string, DosingRecord[], string, VariableDose]>([
    ["no record", [], "2026-11-02", { ok: false, problem: "no_dosing_record", recordId: null }],
    [
      "a record nobody has checked",
      [recorded()],
      "2026-11-02",
      { ok: false, problem: "dosing_record_not_checked", recordId: "dosing-1" },
    ],
    [
      "a record whose check found a difference",
      [differs(recorded())],
      "2026-11-02",
      { ok: false, problem: "dosing_record_differs", recordId: "dosing-1" },
    ],
    ["a checked record", [first], "2026-11-03", { ok: true, quantity: 2.5, recordId: "dosing-1" }],
    [
      "a checked record for a day it does not cover",
      [first],
      "2026-11-04",
      { ok: false, problem: "no_dosing_record", recordId: null },
    ],
    [
      "a newer checked record for the day",
      [first, checked(recorded(newerDraft, "dosing-2", newerAt))],
      "2026-11-03",
      { ok: true, quantity: 1, recordId: "dosing-2" },
    ],
    [
      "a newer record for the day nobody has checked: never the older dose",
      [first, recorded(newerDraft, "dosing-2", newerAt)],
      "2026-11-03",
      { ok: false, problem: "dosing_record_not_checked", recordId: "dosing-2" },
    ],
    [
      "a newer record for the day whose check found a difference: never the older dose",
      [differs(recorded(newerDraft, "dosing-2", newerAt)), first],
      "2026-11-03",
      { ok: false, problem: "dosing_record_differs", recordId: "dosing-2" },
    ],
    [
      "an older record for a day the newer one does not cover (H-1060)",
      [first, recorded(newerDraft, "dosing-2", newerAt)],
      "2026-11-02",
      { ok: true, quantity: 3, recordId: "dosing-1" },
    ],
    [
      "two records made at the same instant giving different doses: none, whatever their order",
      [checked(recorded(newerDraft, "dosing-3", recordedAt)), first],
      "2026-11-03",
      { ok: false, problem: "dosing_records_disagree", recordId: "dosing-1" },
    ],
    [
      "two records made at the same instant giving the same dose",
      [checked(recorded(CLINIC_RECORD, "dosing-3", recordedAt)), first],
      "2026-11-03",
      { ok: true, quantity: 2.5, recordId: "dosing-1" },
    ],
    [
      "two records made at the same instant, one not yet checked",
      [recorded(CLINIC_RECORD, "dosing-3", recordedAt), first],
      "2026-11-03",
      { ok: false, problem: "dosing_record_not_checked", recordId: "dosing-3" },
    ],
  ])(
    "hazard HZ-005 the newest record covering the day decides: %s",
    (_name, records, date, dose) => {
      expect(variableDoseFor(records, versions, date, "18:00")).toEqual(dose);
      expect(variableDoseFor([...records].reverse(), versions, date, "18:00")).toEqual(dose);
    },
  );

  it("reads only records for the entry's own versions", () => {
    expect(variableDoseFor([first], new Set(["entry-other"]), "2026-11-02", "18:00")).toEqual({
      ok: false,
      problem: "no_dosing_record",
      recordId: null,
    });
  });

  it.each<[string, Partial<DosingRecordDraft>, DosingRecordProblem[]]>([
    ["no doses", { doses: [] }, ["no_doses"]],
    ["no source", { source: { ...CLINIC_RECORD.source, reference: " " } }, ["source_required"]],
    ["another person's medicine", { personId: "person-other" }, ["wrong_person"]],
    [
      "a date that does not exist",
      { doses: [{ date: "2026-11-31", time: "18:00", quantity: 3 }] },
      ["bad_date"],
    ],
    [
      "a time the medicine is not given",
      { doses: [{ date: "2026-11-02", time: "08:00", quantity: 3 }] },
      ["time_not_prescribed"],
    ],
    [
      "one day and time twice",
      { doses: [CLINIC_RECORD.doses[0], CLINIC_RECORD.doses[0]] as DosingRecordDraft["doses"] },
      ["dose_given_twice"],
    ],
    [
      "a dose that is not a dose quantity",
      { doses: [{ date: "2026-11-02", time: "18:00", quantity: 0 }] },
      ["bad_quantity"],
    ],
  ])("refuses a dosing record with %s", (_name, overrides, problems) => {
    expect(
      checkDosingRecordDraft(WARFARIN, { ...CLINIC_RECORD, ...overrides }).map((i) => i.problem),
    ).toEqual(problems);
  });

  it("refuses a dosing record for a medicine whose dose is not variable", () => {
    const fixed = entry({}, "entry-warf");
    expect(
      checkDosingRecordDraft(fixed, { ...CLINIC_RECORD, doses: [] }).map((i) => i.problem),
    ).toContain("not_variable");
    expect(
      recordDosingRecord(fixed, CLINIC_RECORD, { id: "d", by: TRANSCRIBER, at: recordedAt }),
    ).toMatchObject({
      ok: false,
    });
  });
});

describe("hazard HZ-116 a dosing record is checked by a second, competent person who compared it with its source", () => {
  it.each<[string, Partial<SecondCheckInput>, DosingRecordProblem]>([
    ["the person who wrote it", { by: TRANSCRIBER }, "checker_is_recorder"],
    ["someone whose competence has expired", { competence: "expired" }, "checker_not_competent"],
    [
      "someone who did not compare it with the source",
      { comparedWithSource: false },
      "source_not_compared",
    ],
    [
      "a difference with nothing said",
      { outcome: "differs_from_source", difference: null },
      "difference_required",
    ],
  ])("refuses a check by %s", (_name, overrides, problem) => {
    expect(checkDosingRecord(recorded(), { ...check, ...overrides })).toMatchObject({
      ok: false,
      issues: [{ problem }],
    });
  });

  it("refuses a second check of a checked record", () => {
    expect(checkDosingRecord(checked(recorded()), check)).toMatchObject({
      ok: false,
      issues: [{ problem: "not_awaiting_check" }],
    });
  });
});
