import { describe, expect, it } from "vitest";
import {
  accessEndsAt,
  accessRemovalDue,
  CARE_CERTIFICATE_STANDARDS,
  careCertificateProgress,
  checkExitInterview,
  checkLeaving,
  checkProbationDecision,
  checkStandardChange,
  checkSupervisedEntry,
  DEFAULT_REFERENCE_KIND,
  INDUCTION_ITEMS,
  inductionState,
  leaverState,
  REFERENCE_DECLINED_REASONS,
  type StandardProgress,
  staffFileRetainUntil,
  staffFileReviewDue,
  TICKED_INDUCTION_ITEMS,
} from "./induction";

const WORKER = "u-worker";
const ASSESSOR = "u-assessor";
const progress = (overrides: Partial<StandardProgress> = {}): StandardProgress => ({
  standardId: "cc01",
  knowledgeAssessedOn: null,
  knowledgeAssessedBy: null,
  observedOn: null,
  observedBy: null,
  ...overrides,
});
const assessed = progress({ knowledgeAssessedOn: "2026-11-05", knowledgeAssessedBy: ASSESSOR });

describe("the Care Certificate (workforce.md rule 20)", () => {
  it("lists 16 standards by id and short title only", () => {
    expect(CARE_CERTIFICATE_STANDARDS).toHaveLength(16);
    expect(new Set(CARE_CERTIFICATE_STANDARDS.map((s) => s.id)).size).toBe(16);
    for (const s of CARE_CERTIFICATE_STANDARDS) expect(s.title.length).toBeLessThan(60);
  });

  const base = {
    current: undefined,
    step: "knowledge" as const,
    on: "2026-11-05",
    today: "2026-11-10",
    startsOn: "2026-11-02",
    workerId: WORKER,
    actorId: ASSESSOR,
    actorObserves: true,
  };
  const cases: readonly [
    string,
    Partial<Parameters<typeof checkStandardChange>[0]>,
    string | true,
  ][] = [
    ["assesses knowledge", {}, true],
    ["never by the worker", { actorId: WORKER }, "self_assessed"],
    ["never in the future", { on: "2026-11-11" }, "date_in_future"],
    ["never before the start", { on: "2026-11-01" }, "date_before_start"],
    ["never twice", { current: assessed }, "already_recorded"],
    ["observes once knowledge is assessed", { step: "observation", current: assessed }, true],
    ["observation needs knowledge first", { step: "observation" }, "knowledge_first"],
    [
      "observation only by an observer",
      { step: "observation", current: assessed, actorObserves: false },
      "not_an_observer",
    ],
    [
      "never observed before the knowledge assessment",
      { step: "observation", current: assessed, on: "2026-11-04" },
      "observed_before_knowledge",
    ],
    [
      "never observed twice",
      {
        step: "observation",
        current: { ...assessed, observedOn: "2026-11-06", observedBy: ASSESSOR },
      },
      "already_recorded",
    ],
  ];
  it.each(cases)("%s", (_name, overrides, expected) => {
    const check = checkStandardChange({ ...base, ...overrides });
    expect(check.ok ? true : check.problem).toBe(expected);
  });

  it("is complete once every standard is competent, on the last observation", () => {
    const all = CARE_CERTIFICATE_STANDARDS.map((s, i) =>
      progress({
        standardId: s.id,
        knowledgeAssessedOn: "2026-11-05",
        knowledgeAssessedBy: ASSESSOR,
        observedOn: `2026-12-${String(i + 1).padStart(2, "0")}`,
        observedBy: ASSESSOR,
      }),
    );
    expect(careCertificateProgress(all)).toMatchObject({
      competent: 16,
      complete: true,
      completedOn: "2026-12-16",
    });
    const partial = careCertificateProgress([assessed]);
    expect(partial).toMatchObject({ competent: 0, complete: false, completedOn: null });
    expect(partial.standards[0]?.status).toBe("knowledge_assessed");
    expect(partial.standards[1]?.status).toBe("not_started");
  });
});

describe("the induction checklist (rule 19)", () => {
  const input = (overrides: Partial<Parameters<typeof inductionState>[0]> = {}) =>
    inductionState({
      ticked: new Set(),
      staffFileComplete: false,
      policies: { required: 3, signed: 1 },
      careCertificate: { complete: false, alreadyHeld: false },
      probation: { endsOn: "2027-05-02", outcome: null },
      startsOn: "2026-11-02",
      today: "2026-10-30",
      ...overrides,
    });
  const status = (state: ReturnType<typeof input>, kind: string) =>
    state.find((s) => s.kind === kind)?.status;

  it("lists every item, ticked or worked out", () => {
    expect(input().map((s) => s.kind)).toEqual(INDUCTION_ITEMS.map((i) => i.kind));
    expect(TICKED_INDUCTION_ITEMS).toContain("contract_issued");
    expect(TICKED_INDUCTION_ITEMS).not.toContain("policy_read_and_sign");
  });

  it.each([
    ["outstanding before the start", {}, "contract_issued", "outstanding"],
    ["overdue from the start date", { today: "2026-11-02" }, "contract_issued", "overdue"],
    [
      "done when ticked",
      { ticked: new Set(["contract_issued" as const]) },
      "contract_issued",
      "done",
    ],
    [
      "checks done with the staff file",
      { staffFileComplete: true },
      "pre_employment_checks",
      "done",
    ],
    ["read-and-sign outstanding", {}, "policy_read_and_sign", "outstanding"],
    [
      "read-and-sign done",
      { policies: { required: 3, signed: 3 } },
      "policy_read_and_sign",
      "done",
    ],
    [
      "read-and-sign done with nothing to sign",
      { policies: { required: 0, signed: 0 } },
      "policy_read_and_sign",
      "done",
    ],
    [
      "Care Certificate not needed when already held",
      { careCertificate: { complete: false, alreadyHeld: true } },
      "care_certificate",
      "not_needed",
    ],
    [
      "Care Certificate done",
      { careCertificate: { complete: true, alreadyHeld: false } },
      "care_certificate",
      "done",
    ],
    ["probation overdue after its end", { today: "2027-05-03" }, "probation_decided", "overdue"],
    [
      "probation outstanding on its last day",
      { today: "2027-05-02" },
      "probation_decided",
      "outstanding",
    ],
    [
      "probation done when passed",
      { probation: { endsOn: "2027-05-02", outcome: "passed" as const }, today: "2027-06-01" },
      "probation_decided",
      "done",
    ],
    [
      "first-day items never overdue by themselves",
      { today: "2026-12-01" },
      "location_induction",
      "outstanding",
    ],
  ] as const)("%s", (_name, overrides, kind, expected) => {
    expect(status(input(overrides), kind)).toBe(expected);
  });
});

describe("probation, shadow shifts and reviews (rule 21)", () => {
  const base = {
    workerId: WORKER,
    actorId: ASSESSOR,
    endsOn: "2027-05-02",
    currentOutcome: null,
    outcome: "passed" as const,
    decidedOn: "2027-05-01",
    startsOn: "2026-11-02",
    newEndsOn: null,
  };
  const cases: readonly [
    string,
    Partial<Parameters<typeof checkProbationDecision>[0]>,
    string | true,
  ][] = [
    ["passes", {}, true],
    ["never the worker's own", { actorId: WORKER }, "self_reviewed"],
    ["needs a probation", { endsOn: null }, "no_probation"],
    ["never twice once passed", { currentOutcome: "passed" }, "already_decided"],
    ["never after not passing", { currentOutcome: "not_passed" }, "already_decided"],
    ["extends to a later date", { outcome: "extended", newEndsOn: "2027-08-02" }, true],
    ["decides again after an extension", { currentOutcome: "extended" }, true],
    [
      "an extension needs a later end",
      { outcome: "extended", newEndsOn: "2027-05-02" },
      "new_end_required",
    ],
    ["only an extension has a new end", { newEndsOn: "2027-08-02" }, "new_end_not_allowed"],
    ["never before the start", { decidedOn: "2026-11-01" }, "date_before_start"],
    ["records not passed", { outcome: "not_passed" }, true],
  ];
  it.each(cases)("%s", (_name, overrides, expected) => {
    const check = checkProbationDecision({ ...base, ...overrides });
    expect(check.ok ? true : check.problem).toBe(expected);
  });

  it.each([
    ["by someone else", ASSESSOR, "2026-11-03", true],
    ["never by the worker", WORKER, "2026-11-03", "self"],
    ["never in the future", ASSESSOR, "2026-11-11", "date_in_future"],
    ["never before the start", ASSESSOR, "2026-11-01", "date_before_start"],
  ] as const)("a shadow shift or review %s", (_name, byId, on, expected) => {
    const check = checkSupervisedEntry({
      workerId: WORKER,
      byId,
      on,
      today: "2026-11-10",
      startsOn: "2026-11-02",
    });
    expect(check.ok ? true : check.problem).toBe(expected);
  });
});

describe("leaving (rule 22)", () => {
  it.each([
    ["records a leaving", {}, true],
    ["never one's own", { actorId: WORKER }, "self"],
    ["never twice", { alreadyLeaving: true }, "already_recorded"],
    ["never before the start", { leavingOn: "2026-11-01" }, "before_start"],
    ["on the start date itself", { leavingOn: "2026-11-02" }, true],
  ] as const)("%s", (_name, overrides, expected) => {
    const check = checkLeaving({
      startsOn: "2026-11-02",
      leavingOn: "2027-03-31",
      alreadyLeaving: false,
      workerId: WORKER,
      actorId: ASSESSOR,
      ...overrides,
    });
    expect(check.ok ? true : check.problem).toBe(expected);
  });

  it.each([
    // name, leaving day, now (UTC), the last shift starting that day ends (UTC), due
    ["the leaving day itself", "2027-03-31", "2027-03-31T12:00:00Z", null, false],
    ["just before midnight (BST)", "2027-03-31", "2027-03-31T22:59:00Z", null, false],
    ["from the end of the leaving day (BST)", "2027-03-31", "2027-03-31T23:00:00Z", null, true],
    ["just before midnight (GMT)", "2027-01-31", "2027-01-31T23:59:00Z", null, false],
    ["from the end of a winter leaving day", "2027-01-31", "2027-02-01T00:00:00Z", null, true],
    [
      "H-873 not while a night shift that started that day runs",
      "2027-03-31",
      "2027-03-31T23:30:00Z",
      "2027-04-01T07:00:00Z",
      false,
    ],
    [
      "H-873 from the end of that night shift",
      "2027-03-31",
      "2027-04-01T07:00:00Z",
      "2027-04-01T07:00:00Z",
      true,
    ],
    [
      "H-873 a shift ending before midnight changes nothing",
      "2027-03-31",
      "2027-03-31T23:00:00Z",
      "2027-03-31T20:00:00Z",
      true,
    ],
  ])("access ends: %s", (_name, leavingOn, now, shiftEnd, due) => {
    expect(accessRemovalDue(leavingOn, new Date(now), shiftEnd ? new Date(shiftEnd) : null)).toBe(
      due,
    );
  });

  it("works out when access ends", () => {
    expect(accessEndsAt("2027-03-31", null).toISOString()).toBe("2027-03-31T23:00:00.000Z");
    expect(accessEndsAt("2027-03-31", new Date("2027-04-01T07:00:00Z")).toISOString()).toBe(
      "2027-04-01T07:00:00.000Z",
    );
  });

  it.each([
    // left on, keep until, today, due
    [
      "H-874 a file with a keep-until date is never listed",
      "2027-03-31",
      "2070-01-01",
      "2040-01-01",
      false,
    ],
    ["H-874 not before the after-leaving period", "2027-03-31", null, "2033-03-30", false],
    ["H-874 listed once the period has passed", "2027-03-31", null, "2033-03-31", true],
  ])("%s", (_name, leftOn, retainUntil, today, due) => {
    expect(
      staffFileReviewDue({
        leftOn,
        retainUntil,
        afterLeaving: { period: 6, unit: "years" },
        today,
      }),
    ).toBe(due);
  });

  it("H-876 defaults to a conduct reference and never declines for want of consent", () => {
    expect(DEFAULT_REFERENCE_KIND).toBe("conduct");
    expect(REFERENCE_DECLINED_REASONS).not.toContain("no_consent_to_share");
    expect(REFERENCE_DECLINED_REASONS).toContain("requester_not_verified");
  });

  it.each([
    ["offers", "not_offered", "offered", null, true],
    ["holds after offering", "offered", "held", "2027-03-30", true],
    ["is declined", "offered", "declined", null, true],
    ["held needs its date", "offered", "held", null, "held_on_required"],
    ["only held has a date", "offered", "declined", "2027-03-30", "held_on_not_allowed"],
    ["never after it was held", "held", "offered", null, "not_allowed"],
    ["never after it was declined", "declined", "held", "2027-03-30", "not_allowed"],
  ] as const)("the exit interview %s", (_name, from, to, heldOn, expected) => {
    const check = checkExitInterview(from, to, heldOn);
    expect(check.ok ? true : check.problem).toBe(expected);
  });

  it("works out the leaving checklist, overdue after the leaving date", () => {
    const state = leaverState({
      ticked: new Set(["property_returned"]),
      accessRemoved: false,
      exitInterview: "declined",
      leavingOn: "2027-03-31",
      today: "2027-04-01",
    });
    expect(Object.fromEntries(state.map((s) => [s.kind, s.status]))).toEqual({
      property_returned: "done",
      final_pay_notified: "overdue",
      access_removed: "overdue",
      exit_interview: "done",
    });
  });
});

describe("staffFileRetainUntil (rule 23; retention.md)", () => {
  const afterLeaving = { period: 6, unit: "years" as const };
  it.each([
    ["six years after leaving", "staff_file.after_leaving", "1990-05-01", "2033-03-31"],
    ["to the 75th birthday", "staff_file.to_75th_birthday", "1990-05-01", "2065-05-01"],
    [
      "leaving when past the birthday already",
      "staff_file.to_75th_birthday",
      "1950-01-01",
      "2027-03-31",
    ],
    ["kept, undecided, with no date of birth", "staff_file.to_75th_birthday", null, null],
    ["after leaving needs no date of birth", "staff_file.after_leaving", null, "2033-03-31"],
  ] as const)("%s", (_name, choice, dateOfBirth, expected) => {
    expect(
      staffFileRetainUntil({
        leftOn: "2027-03-31",
        dateOfBirth,
        choice,
        afterLeaving,
        birthdayAge: 75,
      }),
    ).toBe(expected);
  });
});
