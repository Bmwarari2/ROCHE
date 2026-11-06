import { describe, expect, it } from "vitest";
import { type CovertRecordInput, checkCovertRecord, covertDoseFlags, covertStatus } from "./covert";
import {
  checkHomelyDose,
  checkHomelyProtocol,
  type HomelyDoseInput,
  type HomelyProtocolInput,
  homelyProtocolStatus,
} from "./homely-remedies";
import {
  checkSelfAdminAssessment,
  type SelfAdminAssessmentInput,
  selfAdminDoseFlags,
  selfAdminStatus,
} from "./self-administration";

/** Figures as a tenant's rate table would give them; the tests never rely on a literal default. */
const RATES = { reviewMaxDays: 90, maxDaysCeiling: 3, protocolReviewMaxDays: 365, courseGap: 24 };
const PERSON = "p1";
const today = "2026-11-06";

describe("hazard HZ-026 a covert record stands on a capacity assessment and best-interests decision (slice 38)", () => {
  const CAP = {
    personId: PERSON,
    outcome: "lacks_capacity" as const,
    decisionKind: "covert_medicines",
    superseded: false,
  };
  const BI = {
    personId: PERSON,
    capacityAssessmentId: "ca1",
    decidedOn: "2026-11-01",
    superseded: false,
  };
  const good: CovertRecordInput = {
    personId: PERSON,
    capacity: {
      personId: PERSON,
      outcome: "lacks_capacity",
      decisionKind: "covert_medicines",
      superseded: false,
    },
    bestInterests: {
      personId: PERSON,
      capacityAssessmentId: "ca1",
      decidedOn: "2026-11-01",
      superseded: false,
    },
    capacityAssessmentId: "ca1",
    attendees: [
      { role: "prescriber", name: "Dr A Example" },
      { role: "pharmacist", name: "B Example" },
      { role: "family_or_friend", name: "C Example" },
    ],
    method: "Crushed and mixed in a spoon of yoghurt",
    pharmacistAdvice: "May be crushed; give straight away",
    startsOn: "2026-11-06",
    reviewOn: "2026-12-06",
  };
  const ctx = { today, reviewMaxDays: RATES.reviewMaxDays };

  it("accepts a complete record", () => {
    expect(checkCovertRecord(good, ctx)).toEqual([]);
  });

  it.each<[string, Partial<CovertRecordInput>, string[]]>([
    ["no capacity assessment", { capacity: null }, ["no_capacity_assessment"]],
    [
      "a person who has capacity",
      { capacity: { ...CAP, outcome: "has_capacity" } },
      ["capacity_not_lacking"],
    ],
    [
      "an assessment of another decision",
      { capacity: { ...CAP, decisionKind: "bed_rails" } },
      ["capacity_other_decision"],
    ],
    [
      "an assessment about someone else",
      { capacity: { ...CAP, personId: "p2" } },
      ["capacity_other_person"],
    ],
    ["a corrected assessment", { capacity: { ...CAP, superseded: true } }, ["capacity_superseded"]],
    ["no best-interests decision", { bestInterests: null }, ["no_best_interests_decision"]],
    [
      "a decision after another assessment",
      { bestInterests: { ...BI, capacityAssessmentId: "ca2" } },
      ["best_interests_other_assessment"],
    ],
    [
      "a corrected decision",
      { bestInterests: { ...BI, superseded: true } },
      ["best_interests_superseded"],
    ],
    [
      "no prescriber or pharmacist",
      { attendees: [{ role: "family_or_friend", name: "C Example" }] },
      ["prescriber_not_involved", "pharmacist_not_involved"],
    ],
    [
      "a pharmacist with no name",
      {
        attendees: [
          { role: "prescriber", name: "Dr A Example" },
          { role: "pharmacist", name: " " },
        ],
      },
      ["pharmacist_not_involved"],
    ],
    ["no method", { method: "  " }, ["method_missing"]],
    ["no pharmacist advice", { pharmacistAdvice: null }, ["pharmacist_advice_missing"]],
    ["a start before the decision", { startsOn: "2026-10-31" }, ["starts_before_decision"]],
    ["a review on the start", { reviewOn: "2026-11-06" }, ["review_not_after_start"]],
    ["a review past the rate table's days", { reviewOn: "2027-02-05" }, ["review_too_far"]],
    [
      "a review already passed",
      { startsOn: "2026-11-01", reviewOn: "2026-11-05" },
      ["review_in_past"],
    ],
  ])("refuses %s", (_name, change, problems) => {
    expect(checkCovertRecord({ ...good, ...change }, ctx)).toEqual(problems);
  });

  it("allows the review on the last day the rate table allows", () => {
    expect(checkCovertRecord({ ...good, reviewOn: "2027-02-04" }, ctx)).toEqual([]);
  });

  it.each<[string, { startsOn: string; reviewOn: string; endedOn: string | null }, string]>([
    [
      "before it starts",
      { startsOn: "2026-11-07", reviewOn: "2026-12-01", endedOn: null },
      "not_started",
    ],
    ["on its start", { startsOn: today, reviewOn: "2026-12-01", endedOn: null }, "current"],
    ["on its review date", { startsOn: "2026-10-01", reviewOn: today, endedOn: null }, "current"],
    [
      "after its review date",
      { startsOn: "2026-10-01", reviewOn: "2026-11-05", endedOn: null },
      "review_overdue",
    ],
    ["once ended", { startsOn: "2026-10-01", reviewOn: "2026-12-01", endedOn: today }, "ended"],
    [
      "ending later",
      { startsOn: "2026-10-01", reviewOn: "2026-12-01", endedOn: "2026-11-07" },
      "current",
    ],
  ])("is %s", (_name, record, status) => {
    expect(covertStatus(record, today)).toBe(status);
  });

  it.each<[string, Parameters<typeof covertDoseFlags>[0], ReturnType<typeof covertDoseFlags>]>([
    ["a current record", ["ended", "current"], null],
    [
      "only an overdue record",
      ["review_overdue"],
      { flag: "covert_review_overdue", urgent: false },
    ],
    ["no record", [], { flag: "covert_without_record", urgent: true }],
    [
      "only an ended record",
      ["ended", "not_started"],
      { flag: "covert_without_record", urgent: true },
    ],
  ])("marks a covert dose under %s, never refusing it", (_name, statuses, flags) => {
    expect(covertDoseFlags(statuses)).toEqual(flags);
  });
});

describe("hazard HZ-120 self-administration is assessed and reviewed (slice 38)", () => {
  const good: SelfAdminAssessmentInput = {
    personId: PERSON,
    choice: "wants_to",
    capacity: "assumed",
    capacityAssessment: null,
    dexterity: "able",
    storage: "lockable_storage",
    level: "self_administers",
    medicineIds: ["m1"],
    assessedOn: today,
    reviewOn: "2027-01-06",
  };
  const ctx = { today, reviewMaxDays: RATES.reviewMaxDays };

  it("accepts a complete assessment, and staff giving whatever was found", () => {
    expect(checkSelfAdminAssessment(good, ctx)).toEqual([]);
    expect(
      checkSelfAdminAssessment(
        {
          ...good,
          level: "staff_administer",
          choice: "does_not_want_to",
          dexterity: "unable",
          storage: "no_lockable_storage",
        },
        ctx,
      ),
    ).toEqual([]);
  });

  it.each<[string, Partial<SelfAdminAssessmentInput>, string[]]>([
    ["no medicines", { medicineIds: [] }, ["no_medicines"]],
    ["a person who does not want to", { choice: "does_not_want_to" }, ["not_their_choice"]],
    [
      "a person found to lack capacity",
      {
        capacity: "lacks_capacity",
        capacityAssessment: { personId: PERSON, outcome: "lacks_capacity", superseded: false },
      },
      ["lacks_capacity"],
    ],
    [
      "capacity assessed with no assessment linked",
      { capacity: "has_capacity" },
      ["capacity_needs_assessment"],
    ],
    [
      "an assessment saying something else",
      {
        capacity: "has_capacity",
        capacityAssessment: { personId: PERSON, outcome: "lacks_capacity", superseded: false },
      },
      ["capacity_assessment_mismatch"],
    ],
    [
      "a corrected assessment",
      {
        capacity: "has_capacity",
        capacityAssessment: { personId: PERSON, outcome: "has_capacity", superseded: true },
      },
      ["capacity_assessment_mismatch"],
    ],
    ["unable to handle them", { dexterity: "unable" }, ["unable_to_handle"]],
    ["no lockable storage", { storage: "no_lockable_storage" }, ["no_lockable_storage"]],
    [
      "a date in the future",
      { assessedOn: "2026-11-07", reviewOn: "2026-12-07" },
      ["assessed_in_future"],
    ],
    ["a review on the day", { reviewOn: today }, ["review_not_after_assessment"]],
    ["a review past the rate table's days", { reviewOn: "2027-02-05" }, ["review_too_far"]],
  ])("refuses %s", (_name, change, problems) => {
    expect(checkSelfAdminAssessment({ ...good, ...change }, ctx)).toEqual(problems);
  });

  const at = new Date("2026-11-01T10:00:00Z");
  const later = new Date("2026-11-01T11:00:00Z");
  it.each<[string, Parameters<typeof selfAdminStatus>[0], ReturnType<typeof selfAdminStatus>]>([
    ["no assessment", [], { status: "not_assessed", level: null }],
    [
      "an assessment of other medicines",
      [
        {
          assessedOn: "2026-11-01",
          recordedAt: at,
          reviewOn: "2026-12-01",
          level: "self_administers",
          medicineIds: ["m2"],
        },
      ],
      { status: "not_assessed", level: null },
    ],
    [
      "a current one",
      [
        {
          assessedOn: "2026-11-01",
          recordedAt: at,
          reviewOn: "2026-12-01",
          level: "self_administers",
          medicineIds: ["m1"],
        },
      ],
      { status: "current", level: "self_administers" },
    ],
    [
      "the latest of two, by date then by recording",
      [
        {
          assessedOn: "2026-11-01",
          recordedAt: later,
          reviewOn: "2026-12-01",
          level: "staff_administer",
          medicineIds: ["m1"],
        },
        {
          assessedOn: "2026-11-01",
          recordedAt: at,
          reviewOn: "2026-12-01",
          level: "self_administers",
          medicineIds: ["m1"],
        },
        {
          assessedOn: "2026-10-01",
          recordedAt: later,
          reviewOn: "2026-12-01",
          level: "self_administers",
          medicineIds: ["m1"],
        },
      ],
      { status: "current", level: "staff_administer" },
    ],
    [
      "an overdue one",
      [
        {
          assessedOn: "2026-08-01",
          recordedAt: at,
          reviewOn: "2026-11-05",
          level: "self_administers_with_support",
          medicineIds: ["m1"],
        },
      ],
      { status: "review_overdue", level: "self_administers_with_support" },
    ],
  ])("finds the status with %s", (_name, assessments, expected) => {
    expect(selfAdminStatus(assessments, "m1", today)).toEqual(expected);
  });

  it.each<
    [string, Parameters<typeof selfAdminDoseFlags>[0], ReturnType<typeof selfAdminDoseFlags>]
  >([
    ["current self-administering", { status: "current", level: "self_administers" }, null],
    ["with support", { status: "current", level: "self_administers_with_support" }, null],
    [
      "review overdue",
      { status: "review_overdue", level: "self_administers" },
      { flag: "self_admin_review_overdue", escalate: false },
    ],
    [
      "staff give it",
      { status: "current", level: "staff_administer" },
      { flag: "self_admin_not_assessed", escalate: true },
    ],
    [
      "never assessed",
      { status: "not_assessed", level: null },
      { flag: "self_admin_not_assessed", escalate: true },
    ],
  ])("marks a dose the person took with %s, never refusing it", (_name, state, flags) => {
    expect(selfAdminDoseFlags(state)).toEqual(flags);
  });
});

describe("hazard HZ-120 homely remedies only within the home's protocol (slice 38)", () => {
  const protocol: HomelyProtocolInput = {
    productName: "Paracetamol 500mg tablets",
    indication: "Mild pain or fever",
    doseQuantity: 2,
    unitName: "tablet",
    minIntervalHours: 4,
    maxDailyQuantity: 8,
    maxDays: 2,
    authorisedMemberIds: ["nurse"],
    approvedByName: "Dr A Example",
    approvedByRole: "gp",
    approvedOn: "2026-11-01",
    reviewOn: "2027-11-01",
  };
  const pctx = {
    today,
    maxDaysCeiling: RATES.maxDaysCeiling,
    reviewMaxDays: RATES.protocolReviewMaxDays,
  };

  it("accepts a complete protocol", () => {
    expect(checkHomelyProtocol(protocol, pctx)).toEqual([]);
  });

  it.each<[string, Partial<HomelyProtocolInput>, string[]]>([
    ["a dose of nothing", { doseQuantity: 0 }, ["dose_not_positive"]],
    ["a daily most below one dose", { maxDailyQuantity: 1 }, ["daily_below_dose"]],
    ["no gap", { minIntervalHours: 0 }, ["interval_not_positive"]],
    ["no days", { maxDays: 0 }, ["max_days_out_of_range"]],
    ["more days than the rate table allows", { maxDays: 4 }, ["max_days_out_of_range"]],
    ["no staff", { authorisedMemberIds: [] }, ["no_authorised_staff"]],
    [
      "an agreement in the future",
      { approvedOn: "2026-11-07", reviewOn: "2027-11-01" },
      ["approved_in_future"],
    ],
    ["a review on the agreement", { reviewOn: "2026-11-01" }, ["review_not_after_approval"]],
    ["a review past the rate table's days", { reviewOn: "2027-11-02" }, ["review_too_far"]],
  ])("refuses a protocol with %s", (_name, change, problems) => {
    expect(checkHomelyProtocol({ ...protocol, ...change }, pctx)).toEqual(problems);
  });

  const now = new Date("2026-11-06T12:00:00Z");
  const hoursBefore = (h: number) => new Date(now.getTime() - h * 3_600_000);
  const dose: HomelyDoseInput = {
    at: now,
    now,
    memberId: "nurse",
    quantity: 2,
    protocol: {
      doseQuantity: 2,
      minIntervalHours: 4,
      maxDailyQuantity: 8,
      maxDays: 2,
      authorisedMemberIds: ["nurse"],
      withdrawn: false,
      reviewOn: "2027-11-01",
      vmpId: "vmp-para",
    },
    onDate: today,
    earlier: [],
    prescribedVmpIds: [],
  };
  const dctx = { courseGapHours: RATES.courseGap };

  it("allows a first dose, a dose after the gap, and the fourth in 24 hours", () => {
    expect(checkHomelyDose(dose, dctx)).toEqual([]);
    expect(
      checkHomelyDose({ ...dose, earlier: [{ at: hoursBefore(4), quantity: 2 }] }, dctx),
    ).toEqual([]);
    const three = [6, 12, 18].map((h) => ({ at: hoursBefore(h), quantity: 2 }));
    expect(checkHomelyDose({ ...dose, earlier: three }, dctx)).toEqual([]);
  });

  it.each<[string, Partial<HomelyDoseInput>, string[]]>([
    [
      "a withdrawn protocol",
      { protocol: { ...dose.protocol, withdrawn: true } },
      ["protocol_withdrawn"],
    ],
    [
      "a protocol past review",
      { protocol: { ...dose.protocol, reviewOn: "2026-11-05" } },
      ["protocol_review_overdue"],
    ],
    ["someone not named", { memberId: "carer" }, ["not_authorised"]],
    ["another dose", { quantity: 1 }, ["dose_differs"]],
    ["a dose too soon", { earlier: [{ at: hoursBefore(3.9), quantity: 2 }] }, ["too_soon"]],
    [
      "a fifth dose in 24 hours",
      { earlier: [5, 10, 15, 20].map((h) => ({ at: hoursBefore(h), quantity: 2 })) },
      ["over_daily_maximum"],
    ],
    [
      "a course past the protocol's days",
      { earlier: [6, 20, 30, 44, 48].map((h) => ({ at: hoursBefore(h), quantity: 2 })) },
      ["refer_to_gp"],
    ],
    [
      "the same product prescribed",
      { prescribedVmpIds: ["vmp-para"] },
      ["prescribed_same_product"],
    ],
    ["a time in the future", { at: new Date(now.getTime() + 60_000) }, ["given_in_future"]],
  ])("refuses %s", (_name, change, problems) => {
    expect(checkHomelyDose({ ...dose, ...change }, dctx)).toEqual(problems);
  });

  it("starts a new course after a gap longer than the rate table's", () => {
    const earlier = [30, 48, 60].map((h) => ({ at: hoursBefore(h), quantity: 2 }));
    expect(checkHomelyDose({ ...dose, earlier }, dctx)).toEqual([]);
  });

  it.each([
    [{ withdrawn: false, reviewOn: today }, "in_use"],
    [{ withdrawn: false, reviewOn: "2026-11-05" }, "review_overdue"],
    [{ withdrawn: true, reviewOn: "2027-01-01" }, "withdrawn"],
  ] as const)("names a protocol's state %#", (p, state) => {
    expect(homelyProtocolStatus(p, today)).toBe(state);
  });
});
