import { describe, expect, it } from "vitest";
import {
  type AdvanceCareInput,
  type AdvanceCareRecordState,
  CPR_DECISION_SNOMED,
  checkAdvanceCareRecord,
  checkWithdrawal,
  resuscitationStatus,
} from "./advance-care";

/**
 * ReSPECT, DNACPR, ADRT and advance care plans (master prompt 10.1 end of life; register row
 * CARE-015; hazard HZ-015). Harbour shows the record; the signed form stays with the person.
 */

const TODAY = "2026-10-11";

const input = (overrides: Partial<AdvanceCareInput> = {}): AdvanceCareInput => ({
  kind: "dnacpr",
  cprDecision: null,
  clinicianName: "Dr Example",
  clinicianRole: "GP",
  completedOn: "2026-10-01",
  reviewDueOn: null,
  today: TODAY,
  ...overrides,
});

describe("recording an advance care record", () => {
  it.each<[string, Partial<AdvanceCareInput>, string | null, string | null]>([
    ["a DNACPR decision", {}, null, "do_not_attempt_cpr"],
    [
      "a DNACPR decision stated explicitly",
      { cprDecision: "do_not_attempt_cpr" },
      null,
      "do_not_attempt_cpr",
    ],
    ["a DNACPR that says attempt CPR", { cprDecision: "attempt_cpr" }, "cprDecision", null],
    [
      "a ReSPECT plan recommending CPR",
      { kind: "respect", cprDecision: "attempt_cpr" },
      null,
      "attempt_cpr",
    ],
    ["a ReSPECT plan with no CPR recommendation", { kind: "respect" }, "cprDecision", null],
    [
      "an ADRT with no clinician",
      { kind: "adrt", clinicianName: null, clinicianRole: null },
      null,
      null,
    ],
    [
      "an ADRT carrying a CPR decision",
      { kind: "adrt", cprDecision: "do_not_attempt_cpr" },
      "cprDecision",
      null,
    ],
    [
      "an advance care plan",
      { kind: "advance_care_plan", clinicianName: null, clinicianRole: null },
      null,
      null,
    ],
    ["a DNACPR with no clinician", { clinicianName: " " }, "clinicianName", null],
    [
      "a ReSPECT plan with no clinician role",
      { kind: "respect", cprDecision: "attempt_cpr", clinicianRole: null },
      "clinicianRole",
      null,
    ],
    ["a completion date in the future", { completedOn: "2026-10-12" }, "completedOn", null],
    ["a completion date that is not real", { completedOn: "2026-09-31" }, "completedOn", null],
    ["a review before completion", { reviewDueOn: "2026-09-30" }, "reviewDueOn", null],
    ["a review date after completion", { reviewDueOn: "2027-04-01" }, null, "do_not_attempt_cpr"],
  ])("%s", (_label, overrides, field, decision) => {
    const check = checkAdvanceCareRecord(input(overrides));
    expect(check.ok ? null : check.issues.map((i) => i.field)[0]).toBe(field);
    if (check.ok) expect(check.cprDecision).toBe(decision);
  });

  it("needs a reason to withdraw a record", () => {
    expect(checkWithdrawal("Cancelled by the GP after review with the family.").ok).toBe(true);
    expect(checkWithdrawal(" ").ok).toBe(false);
  });

  it("maps CPR decisions to the NHS EOL CPR status SNOMED CT concepts", () => {
    expect(CPR_DECISION_SNOMED).toEqual({
      attempt_cpr: { code: "450475007", display: "For cardiopulmonary resuscitation" },
      do_not_attempt_cpr: { code: "450476008", display: "Not for cardiopulmonary resuscitation" },
    });
  });
});

const record = (overrides: Partial<AdvanceCareRecordState> = {}): AdvanceCareRecordState => ({
  id: "r1",
  kind: "dnacpr",
  status: "active",
  cprDecision: "do_not_attempt_cpr",
  completedOn: "2026-09-01",
  clinicianName: "Dr Example",
  clinicianRole: "GP",
  reviewDueOn: null,
  ...overrides,
});

describe("hazard HZ-015 the current resuscitation status", () => {
  it("hazard HZ-015 a missing resuscitation record shows as not recorded", () => {
    expect(resuscitationStatus([], TODAY)).toEqual({
      status: "not_recorded",
      conflicting: false,
      recordId: null,
      kind: null,
      completedOn: null,
      clinicianName: null,
      clinicianRole: null,
      reviewDueOn: null,
      reviewOverdue: false,
    });
  });

  it.each<[string, AdvanceCareRecordState[], string, string | null]>([
    ["an active DNACPR", [record()], "do_not_attempt_cpr", "r1"],
    ["a withdrawn DNACPR", [record({ status: "withdrawn" })], "not_recorded", null],
    ["a superseded DNACPR", [record({ status: "superseded" })], "not_recorded", null],
    ["an ADRT only", [record({ kind: "adrt", cprDecision: null })], "not_recorded", null],
    [
      "a ReSPECT plan recommending CPR",
      [record({ id: "r2", kind: "respect", cprDecision: "attempt_cpr" })],
      "attempt_cpr",
      "r2",
    ],
    [
      "a later ReSPECT plan after an earlier DNACPR",
      [
        record(),
        record({
          id: "r2",
          kind: "respect",
          cprDecision: "do_not_attempt_cpr",
          completedOn: "2026-10-01",
        }),
      ],
      "do_not_attempt_cpr",
      "r2",
    ],
  ])("%s gives %s", (_label, records, status, recordId) => {
    const result = resuscitationStatus(records, TODAY);
    expect(result.status).toBe(status);
    expect(result.recordId).toBe(recordId);
    expect(result.conflicting).toBe(false);
  });

  it("shows the latest decision and flags records in force that disagree", () => {
    const result = resuscitationStatus(
      [
        record(),
        record({
          id: "r2",
          kind: "respect",
          cprDecision: "attempt_cpr",
          completedOn: "2026-10-05",
        }),
      ],
      TODAY,
    );
    expect(result).toMatchObject({ status: "attempt_cpr", recordId: "r2", conflicting: true });
  });

  it("keeps a decision in force after its review date passes, and says the review is overdue", () => {
    const result = resuscitationStatus([record({ reviewDueOn: "2026-10-10" })], TODAY);
    expect(result).toMatchObject({ status: "do_not_attempt_cpr", reviewOverdue: true });
    expect(resuscitationStatus([record({ reviewDueOn: TODAY })], TODAY).reviewOverdue).toBe(false);
  });
});
