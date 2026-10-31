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
  it("gives no dose from a record nobody has checked, or one whose check found a difference", () => {
    expect(variableDoseFor([recorded()], versions, "2026-11-02", "18:00")).toBeNull();
    const differs = checkDosingRecord(recorded(), {
      ...check,
      outcome: "differs_from_source",
      difference: "Clinic says 2 mg on Tuesday",
    });
    if (!differs.ok) throw new Error("check refused");
    expect(variableDoseFor([differs.record], versions, "2026-11-02", "18:00")).toBeNull();
  });

  it("gives the checked record's dose for the day and time, the latest record first", () => {
    const first = checked(recorded());
    expect(variableDoseFor([first], versions, "2026-11-03", "18:00")).toBe(2.5);
    expect(variableDoseFor([first], versions, "2026-11-04", "18:00")).toBeNull();
    const newer = checked(
      recorded(
        { ...CLINIC_RECORD, doses: [{ date: "2026-11-03", time: "18:00", quantity: 2 }] },
        "dosing-2",
        new Date("2026-11-02T15:00:00Z"),
      ),
    );
    expect(variableDoseFor([first, newer], versions, "2026-11-03", "18:00")).toBe(2);
    expect(variableDoseFor([first, newer], versions, "2026-11-02", "18:00")).toBe(3);
    expect(
      variableDoseFor([first, newer], new Set(["entry-other"]), "2026-11-02", "18:00"),
    ).toBeNull();
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
