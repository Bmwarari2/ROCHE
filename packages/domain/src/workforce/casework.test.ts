import { describe, expect, it } from "vitest";
import { isSiloPermission, PERMISSIONS, SILO_PERMISSIONS } from "../platform/permissions";
import { BUILTIN_ROLES } from "../platform/roles";
import {
  ALL_CASE_OUTCOMES,
  CASE_OUTCOMES,
  type CaseFacts,
  type CaseMove,
  type CaseMoveProblem,
  type CaseStage,
  caseRetentionClass,
  caseTimeline,
  checkCaseMove,
  checkHearingChange,
  checkHearingInvitation,
  checkMemberAppointment,
  checkMemberRemoval,
  checkReferralDecision,
  checkSuspension,
  referralDecisionsDue,
  suspensionReviewOverdue,
  warningCounts,
} from "./casework";

const facts = (overrides: Partial<CaseFacts> = {}): CaseFacts => ({
  type: "disciplinary",
  stage: "hearing",
  hearingsHeld: 1,
  hearingsNotAttended: 0,
  appealHearingsHeld: 0,
  suspended: false,
  outcome: null,
  dbsReferral: null,
  regulatorReferral: null,
  subjectRegistered: false,
  linkedToSafeguarding: false,
  removesFromRegulatedActivity: false,
  ...overrides,
});

const decide = (overrides: Partial<Extract<CaseMove, { to: "outcome" }>> = {}): CaseMove => ({
  to: "outcome",
  outcome: "first_written_warning",
  decidedOn: "2026-11-02",
  warningExpiresOn: "2027-05-02",
  appealRightGiven: true,
  noHearingReason: null,
  ...overrides,
});

describe("checkCaseMove (workforce.md rule 15)", () => {
  const cases: readonly [string, CaseFacts, CaseMove, CaseMoveProblem | CaseStage][] = [
    [
      "starts an investigation with an investigator",
      facts({ stage: "open" }),
      { to: "investigation", investigatorNamed: true },
      "investigation",
    ],
    [
      "refuses an investigation with nobody to carry it out",
      facts({ stage: "open" }),
      { to: "investigation", investigatorNamed: false },
      "investigator_required",
    ],
    [
      "refuses a second investigation",
      facts({ stage: "hearing" }),
      { to: "investigation", investigatorNamed: true },
      "not_allowed_from_stage",
    ],
    [
      "moves to a hearing after investigation",
      facts({ stage: "investigation" }),
      { to: "hearing" },
      "hearing",
    ],
    [
      "moves straight to a hearing when no investigation is needed",
      facts({ stage: "open" }),
      { to: "hearing" },
      "hearing",
    ],
    ["decides a warning after a hearing", facts(), decide(), "outcome"],
    [
      "refuses a decision with no hearing held",
      facts({ hearingsHeld: 0 }),
      decide(),
      "hearing_required",
    ],
    [
      "refuses a decision without a hearing after one missed meeting",
      facts({ hearingsHeld: 0, hearingsNotAttended: 1 }),
      decide({ noHearingReason: "employee_repeatedly_did_not_attend" }),
      "hearing_required",
    ],
    [
      "decides without a hearing after repeated non-attendance",
      facts({ hearingsHeld: 0, hearingsNotAttended: 2 }),
      decide({ noHearingReason: "employee_repeatedly_did_not_attend" }),
      "outcome",
    ],
    [
      "refuses an outcome of another case type",
      facts({ type: "grievance" }),
      decide({ outcome: "dismissal", warningExpiresOn: null }),
      "outcome_not_for_case_type",
    ],
    [
      "H-802 decides an action short of dismissal that removes the member from regulated activity",
      facts(),
      decide({
        outcome: "action_short_of_dismissal",
        warningExpiresOn: null,
        removesFromRegulatedActivity: true,
      }),
      "outcome",
    ],
    [
      "H-802 refuses the removal flag with any other outcome",
      facts(),
      decide({ removesFromRegulatedActivity: true }),
      "removal_only_with_action_short_of_dismissal",
    ],
    [
      "refuses a warning without the date it stops counting",
      facts(),
      decide({ warningExpiresOn: null }),
      "warning_expiry_required",
    ],
    [
      "refuses a warning that expires on the day it is given",
      facts(),
      decide({ warningExpiresOn: "2026-11-02" }),
      "warning_expiry_required",
    ],
    [
      "refuses an expiry date on an outcome that is not a warning",
      facts({ type: "grievance" }),
      decide({ outcome: "upheld" }),
      "warning_expiry_not_allowed",
    ],
    [
      "refuses an outcome without the right of appeal",
      facts(),
      decide({ appealRightGiven: false }),
      "appeal_right_required",
    ],
    [
      "refuses an outcome before the hearing stage",
      facts({ stage: "open" }),
      decide(),
      "not_allowed_from_stage",
    ],
    ["lodges an appeal after the outcome", facts({ stage: "outcome" }), { to: "appeal" }, "appeal"],
    [
      "refuses an appeal before the outcome",
      facts({ stage: "hearing" }),
      { to: "appeal" },
      "not_allowed_from_stage",
    ],
    [
      "closes when the outcome is accepted",
      facts({ stage: "outcome", outcome: "first_written_warning" }),
      { to: "closed", reason: "outcome_accepted" },
      "closed",
    ],
    [
      "closes with the appeal decided",
      facts({ stage: "appeal", outcome: "first_written_warning", appealHearingsHeld: 1 }),
      { to: "closed", reason: "appeal_decided", appealOutcome: "not_upheld" },
      "closed",
    ],
    [
      "refuses an appeal decision with no appeal hearing",
      facts({ stage: "appeal", outcome: "first_written_warning" }),
      { to: "closed", reason: "appeal_decided", appealOutcome: "not_upheld" },
      "appeal_hearing_required",
    ],
    [
      "refuses an appeal decision with no appeal outcome",
      facts({ stage: "appeal", outcome: "first_written_warning", appealHearingsHeld: 1 }),
      { to: "closed", reason: "appeal_decided", appealOutcome: null },
      "appeal_outcome_required",
    ],
    [
      "closes with no case to answer after investigation",
      facts({ stage: "investigation" }),
      { to: "closed", reason: "no_case_to_answer" },
      "closed",
    ],
    [
      "refuses no case to answer before any investigation",
      facts({ stage: "open" }),
      { to: "closed", reason: "no_case_to_answer" },
      "reason_not_for_stage",
    ],
    [
      "resolves informally while open",
      facts({ type: "grievance", stage: "open" }),
      { to: "closed", reason: "resolved_informally" },
      "closed",
    ],
    [
      "refuses to close while suspended",
      facts({ stage: "investigation", suspended: true }),
      { to: "closed", reason: "no_case_to_answer" },
      "suspension_in_force",
    ],
    [
      "refuses to close a dismissal without a DBS referral decision",
      facts({ stage: "outcome", outcome: "dismissal" }),
      { to: "closed", reason: "outcome_accepted" },
      "referral_decision_required",
    ],
    [
      "closes a dismissal once the DBS decision is recorded",
      facts({ stage: "outcome", outcome: "dismissal", dbsReferral: "referred" }),
      { to: "closed", reason: "outcome_accepted" },
      "closed",
    ],
    [
      "refuses to close when someone leaves mid-case without a DBS decision",
      facts({ stage: "investigation" }),
      { to: "closed", reason: "left_employment" },
      "referral_decision_required",
    ],
    [
      "refuses to close a registered nurse's final warning without a regulator decision",
      facts({ stage: "outcome", outcome: "final_written_warning", subjectRegistered: true }),
      { to: "closed", reason: "outcome_accepted" },
      "referral_decision_required",
    ],
    ["never reopens a closed case", facts({ stage: "closed" }), { to: "hearing" }, "closed"],
  ];
  it.each(cases)("%s", (_name, f, move, expected) => {
    const check = checkCaseMove(f, move);
    if (check.ok) expect(check.to).toBe(expected);
    else expect(check.problem).toBe(expected);
  });

  it("lists every outcome once", () => {
    expect(new Set(ALL_CASE_OUTCOMES).size).toBe(ALL_CASE_OUTCOMES.length);
    expect(CASE_OUTCOMES.probation).toContain("not_passed");
  });
});

describe("referralDecisionsDue (rule 17)", () => {
  const base = {
    type: "disciplinary" as const,
    outcome: null,
    subjectRegistered: false,
    linkedToSafeguarding: false,
    removesFromRegulatedActivity: false,
  };
  const cases: readonly [
    string,
    Parameters<typeof referralDecisionsDue>[0],
    Parameters<typeof referralDecisionsDue>[1],
    { dbs: boolean; regulator: boolean },
  ][] = [
    [
      "a warning needs neither",
      { ...base, outcome: "first_written_warning" },
      "outcome_accepted",
      { dbs: false, regulator: false },
    ],
    [
      "a dismissal needs the DBS decision",
      { ...base, outcome: "dismissal" },
      "outcome_accepted",
      { dbs: true, regulator: false },
    ],
    [
      "a registered professional's dismissal needs both",
      { ...base, outcome: "dismissal", subjectRegistered: true },
      "outcome_accepted",
      { dbs: true, regulator: true },
    ],
    [
      "a registered professional's final warning needs the regulator decision",
      { ...base, outcome: "final_written_warning", subjectRegistered: true },
      "outcome_accepted",
      { dbs: false, regulator: true },
    ],
    [
      "leaving during a disciplinary needs the DBS decision",
      base,
      "left_employment",
      { dbs: true, regulator: false },
    ],
    [
      "leaving during a grievance needs neither",
      { ...base, type: "grievance" },
      "left_employment",
      { dbs: false, regulator: false },
    ],
    [
      "an ill-health dismissal needs neither",
      { ...base, type: "sickness_absence", outcome: "dismissal" },
      "outcome_accepted",
      { dbs: false, regulator: false },
    ],
    [
      "H-802 a disciplinary redeployment needs the DBS decision",
      { ...base, outcome: "redeployment" },
      "outcome_accepted",
      { dbs: true, regulator: false },
    ],
    [
      "H-802 a capability redeployment needs the DBS decision",
      { ...base, type: "capability", outcome: "redeployment" },
      "outcome_accepted",
      { dbs: true, regulator: false },
    ],
    [
      "H-802 an ill-health redeployment needs neither",
      { ...base, type: "sickness_absence", outcome: "redeployment" },
      "outcome_accepted",
      { dbs: false, regulator: false },
    ],
    [
      "H-802 action short of dismissal out of regulated activity needs the DBS decision",
      { ...base, outcome: "action_short_of_dismissal", removesFromRegulatedActivity: true },
      "outcome_accepted",
      { dbs: true, regulator: false },
    ],
    [
      "H-802 action short of dismissal that keeps regulated activity needs neither",
      { ...base, outcome: "action_short_of_dismissal" },
      "outcome_accepted",
      { dbs: false, regulator: false },
    ],
    [
      "a failed probation needs the DBS decision",
      { ...base, type: "probation", outcome: "not_passed" },
      "outcome_accepted",
      { dbs: true, regulator: false },
    ],
    [
      "a case linked to safeguarding always needs both for a registered professional",
      {
        ...base,
        type: "grievance",
        outcome: "not_upheld",
        linkedToSafeguarding: true,
        subjectRegistered: true,
      },
      "outcome_accepted",
      { dbs: true, regulator: true },
    ],
  ];
  it.each(cases)("%s", (_name, f, reason, expected) => {
    expect(referralDecisionsDue(f, reason)).toEqual(expected);
  });

  it("records a referral with its date, or not required with a reason", () => {
    expect(
      checkReferralDecision({ decision: "referred", referredOn: "2026-11-05", reason: null }).ok,
    ).toBe(true);
    expect(checkReferralDecision({ decision: "referred", referredOn: null, reason: null })).toEqual(
      {
        ok: false,
        problem: "referred_on_required",
      },
    );
    expect(
      checkReferralDecision({
        decision: "referred",
        referredOn: "2026-11-05",
        reason: "harm_test_not_met",
      }),
    ).toEqual({ ok: false, problem: "reason_not_allowed" });
    expect(
      checkReferralDecision({ decision: "not_required", referredOn: null, reason: null }),
    ).toEqual({
      ok: false,
      problem: "reason_required",
    });
    expect(
      checkReferralDecision({
        decision: "not_required",
        referredOn: "2026-11-05",
        reason: "harm_test_not_met",
      }),
    ).toEqual({ ok: false, problem: "reason_not_allowed" });
    expect(
      checkReferralDecision({
        decision: "not_required",
        referredOn: null,
        reason: "harm_test_not_met",
      }).ok,
    ).toBe(true);
  });
});

describe("checkMemberAppointment (rule 16)", () => {
  const subject = "u-subject";
  const cases: readonly [string, Parameters<typeof checkMemberAppointment>[0], string | true][] = [
    [
      "names an investigator",
      {
        tenantUserId: "u1",
        role: "investigator",
        subjectTenantUserId: subject,
        active: [],
        exception: null,
      },
      true,
    ],
    [
      "never names the member of staff the case is about",
      {
        tenantUserId: subject,
        role: "note_taker",
        subjectTenantUserId: subject,
        active: [],
        exception: null,
      },
      "subject_cannot_be_member",
    ],
    [
      "refuses the same role twice",
      {
        tenantUserId: "u1",
        role: "investigator",
        subjectTenantUserId: subject,
        active: [{ tenantUserId: "u1", role: "investigator" }],
        exception: null,
      },
      "already_in_role",
    ],
    [
      "refuses the investigator as hearing chair",
      {
        tenantUserId: "u1",
        role: "hearing_chair",
        subjectTenantUserId: subject,
        active: [{ tenantUserId: "u1", role: "investigator" }],
        exception: null,
      },
      "chair_was_investigator",
    ],
    [
      "allows it where no other manager is available",
      {
        tenantUserId: "u1",
        role: "hearing_chair",
        subjectTenantUserId: subject,
        active: [{ tenantUserId: "u1", role: "investigator" }],
        exception: "no_other_manager_available",
      },
      true,
    ],
    [
      "refuses the hearing chair as investigator",
      {
        tenantUserId: "u1",
        role: "investigator",
        subjectTenantUserId: subject,
        active: [{ tenantUserId: "u1", role: "hearing_chair" }],
        exception: null,
      },
      "investigator_is_chair",
    ],
    [
      "refuses the hearing chair as appeal chair",
      {
        tenantUserId: "u1",
        role: "appeal_chair",
        subjectTenantUserId: subject,
        active: [{ tenantUserId: "u1", role: "hearing_chair" }],
        exception: null,
      },
      "appeal_chair_involved",
    ],
    [
      "refuses the appeal chair as investigator",
      {
        tenantUserId: "u1",
        role: "investigator",
        subjectTenantUserId: subject,
        active: [{ tenantUserId: "u1", role: "appeal_chair" }],
        exception: null,
      },
      "involved_in_appeal",
    ],
    [
      "lets the case manager also take notes",
      {
        tenantUserId: "u1",
        role: "note_taker",
        subjectTenantUserId: subject,
        active: [{ tenantUserId: "u1", role: "case_manager" }],
        exception: null,
      },
      true,
    ],
  ];
  it("counts a part someone was removed from", () => {
    const removed = [{ tenantUserId: "u1", role: "investigator" as const }];
    const input = {
      tenantUserId: "u1",
      role: "hearing_chair" as const,
      subjectTenantUserId: subject,
      active: [],
    };
    expect(checkMemberAppointment({ ...input, removed, exception: null })).toEqual({
      ok: false,
      problem: "chair_was_investigator",
    });
    expect(
      checkMemberAppointment({ ...input, removed, exception: "no_other_manager_available" }).ok,
    ).toBe(true);
  });

  it.each(cases)("%s", (_name, input, expected) => {
    const check = checkMemberAppointment(input);
    expect(check.ok ? true : check.problem).toBe(expected);
  });

  it("keeps the last case manager", () => {
    const manager = { tenantUserId: "u1", role: "case_manager" as const };
    expect(checkMemberRemoval(manager, [manager])).toEqual({
      ok: false,
      problem: "last_case_manager",
    });
    expect(
      checkMemberRemoval(manager, [manager, { tenantUserId: "u2", role: "case_manager" }]).ok,
    ).toBe(true);
    expect(checkMemberRemoval({ tenantUserId: "u3", role: "note_taker" }, [manager]).ok).toBe(true);
  });
});

describe("checkHearingInvitation (rule 18)", () => {
  const invite = (overrides: Partial<Parameters<typeof checkHearingInvitation>[0]> = {}) =>
    checkHearingInvitation({
      type: "disciplinary",
      stage: "hearing",
      kind: "hearing",
      invitedOn: "2026-11-02",
      scheduledOn: "2026-11-09",
      issueSetOut: true,
      evidenceShared: true,
      companionRightGiven: true,
      ...overrides,
    });
  const cases: readonly [string, Parameters<typeof invite>[0], string | true][] = [
    ["invites with the issue, evidence and right to be accompanied", {}, true],
    ["refuses without the issue in writing", { issueSetOut: false }, "issue_not_set_out"],
    [
      "refuses a disciplinary hearing without the evidence",
      { evidenceShared: false },
      "evidence_not_shared",
    ],
    [
      "a grievance hearing needs no evidence pack",
      { type: "grievance", evidenceShared: false },
      true,
    ],
    [
      "refuses without the right to be accompanied",
      { companionRightGiven: false },
      "companion_right_not_given",
    ],
    ["refuses a hearing on the day of the invitation", { scheduledOn: "2026-11-02" }, "no_notice"],
    [
      "refuses an appeal hearing before an appeal",
      { kind: "appeal_hearing" },
      "not_allowed_from_stage",
    ],
    [
      "an investigation meeting needs only notice",
      {
        stage: "investigation",
        kind: "investigation_meeting",
        issueSetOut: false,
        evidenceShared: false,
        companionRightGiven: false,
      },
      true,
    ],
  ];
  it.each(cases)("%s", (_name, overrides, expected) => {
    const check = invite(overrides);
    expect(check.ok ? true : check.problem).toBe(expected);
  });

  it("moves a hearing on only from scheduled or postponed", () => {
    expect(checkHearingChange("scheduled", "held")).toBe(true);
    expect(checkHearingChange("postponed", "not_attended")).toBe(true);
    expect(checkHearingChange("scheduled", "scheduled")).toBe(false);
    expect(checkHearingChange("held", "cancelled")).toBe(false);
    expect(checkHearingChange("cancelled", "held")).toBe(false);
  });
});

describe("checkSuspension (rule 18)", () => {
  const open = {
    type: "disciplinary" as const,
    stage: "investigation" as const,
    suspendedOn: null,
  };
  const suspended = { ...open, suspendedOn: "2026-11-01" };
  const cases: readonly [
    string,
    Parameters<typeof checkSuspension>[0],
    Parameters<typeof checkSuspension>[1],
    string | true,
  ][] = [
    [
      "suspends with a review date",
      open,
      { kind: "start", on: "2026-11-01", reviewOn: "2026-11-08" },
      true,
    ],
    [
      "refuses a suspension with no later review",
      open,
      { kind: "start", on: "2026-11-01", reviewOn: "2026-11-01" },
      "review_date_required",
    ],
    [
      "refuses suspension in a grievance",
      { ...open, type: "grievance" },
      { kind: "start", on: "2026-11-01", reviewOn: "2026-11-08" },
      "not_for_case_type",
    ],
    [
      "refuses a second suspension",
      suspended,
      { kind: "start", on: "2026-11-02", reviewOn: "2026-11-09" },
      "already_suspended",
    ],
    [
      "reviews it with the next date",
      suspended,
      { kind: "review", on: "2026-11-08", reviewOn: "2026-11-15" },
      true,
    ],
    [
      "refuses a review when not suspended",
      open,
      { kind: "review", on: "2026-11-08", reviewOn: "2026-11-15" },
      "not_suspended",
    ],
    ["ends it", suspended, { kind: "end", on: "2026-11-10" }, true],
    [
      "refuses an end before it began",
      suspended,
      { kind: "end", on: "2026-10-30" },
      "ends_before_start",
    ],
    [
      "refuses any change once closed",
      { ...suspended, stage: "closed" },
      { kind: "end", on: "2026-11-10" },
      "closed",
    ],
  ];
  it.each(cases)("%s", (_name, input, change, expected) => {
    const check = checkSuspension(input, change);
    expect(check.ok ? true : check.problem).toBe(expected);
  });

  it("shows an overdue review from the day after", () => {
    expect(suspensionReviewOverdue("2026-11-08", "2026-11-08")).toBe(false);
    expect(suspensionReviewOverdue("2026-11-08", "2026-11-09")).toBe(true);
    expect(suspensionReviewOverdue(null, "2026-11-09")).toBe(false);
  });
});

describe("warnings and the timeline", () => {
  const warning = {
    outcome: "first_written_warning",
    decidedOn: "2026-11-02",
    expiresOn: "2027-05-02",
    appealOutcome: null,
  };
  it.each([
    ["counts on the day it is given", warning, "2026-11-02", true],
    ["counts the day before it expires", warning, "2027-05-01", true],
    ["stops on the day it expires", warning, "2027-05-02", false],
    ["never before it was given", warning, "2026-11-01", false],
    [
      "not once an appeal overturned it",
      { ...warning, appealOutcome: "upheld" as const },
      "2026-12-01",
      false,
    ],
    [
      "still counts after an appeal that varied something else",
      { ...warning, appealOutcome: "partly_upheld" as const },
      "2026-12-01",
      true,
    ],
    ["a dismissal is not a warning", { ...warning, outcome: "dismissal" }, "2026-12-01", false],
  ] as const)("%s", (_name, w, on, expected) => {
    expect(warningCounts(w, on)).toBe(expected);
  });

  it("gives the days between steps, across a clock change, and the days at the stage", () => {
    const timeline = caseTimeline(
      [
        { stage: "investigation", on: "2026-10-20" },
        { stage: "open", on: "2026-10-19" },
        { stage: "hearing", on: "2026-11-02" },
      ],
      "2026-11-09",
    );
    expect(timeline.steps.map((s) => s.daysSincePrevious)).toEqual([null, 1, 13]);
    expect(timeline.daysAtStage).toBe(7);
    expect(
      caseTimeline([{ stage: "closed", on: "2026-11-02" }], "2026-11-09").daysAtStage,
    ).toBeNull();
    expect(caseTimeline([], "2026-11-09")).toEqual({ steps: [], daysAtStage: null });
  });
});

describe("the casework silo (ADR-0089; workforce.md section 3)", () => {
  it("is held only by the caseworker role, which carries nothing else", () => {
    const holders = BUILTIN_ROLES.filter((r) =>
      r.permissions.some((p) => isSiloPermission(p) && p === "workforce.casework.manage"),
    );
    expect(holders.map((r) => r.key)).toEqual(["employee_relations_lead"]);
    expect(holders[0]?.permissions).toEqual(["workforce.casework.manage"]);
    expect(SILO_PERMISSIONS).toContain("workforce.casework.manage");
    expect(PERMISSIONS["workforce.casework.manage"]).toMatchObject({ sensitive: true });
  });
});

describe("caseRetentionClass (H-806)", () => {
  const base = {
    type: "disciplinary" as const,
    outcome: null,
    closingReason: "outcome_accepted" as const,
    linkedToSafeguarding: false,
    dbsReferral: null,
    regulatorReferral: null,
  };
  it.each<[string, Partial<Parameters<typeof caseRetentionClass>[0]>, string]>([
    ["a grievance", { type: "grievance", outcome: "upheld" }, "casework_no_sanction"],
    ["no case to answer", { closingReason: "no_case_to_answer" }, "casework_no_sanction"],
    ["a withdrawn case", { closingReason: "withdrawn" }, "casework_no_sanction"],
    ["a warning", { outcome: "first_written_warning" }, "staff_file"],
    ["a final warning", { outcome: "final_written_warning" }, "staff_file"],
    ["a dismissal", { outcome: "dismissal" }, "staff_file"],
    ["action short of dismissal", { outcome: "action_short_of_dismissal" }, "staff_file"],
    ["a redeployment", { outcome: "redeployment" }, "staff_file"],
    ["a failed probation", { type: "probation", outcome: "not_passed" }, "staff_file"],
    ["no action after a hearing", { outcome: "no_action" }, "staff_file"],
    [
      "a grievance linked to safeguarding",
      { type: "grievance", linkedToSafeguarding: true },
      "staff_file",
    ],
    [
      "a withdrawn case referred to the DBS",
      { closingReason: "withdrawn", dbsReferral: "referred" },
      "staff_file",
    ],
    [
      "a grievance referred to the regulator",
      { type: "grievance", regulatorReferral: "referred" },
      "staff_file",
    ],
    [
      "a withdrawn case whose referral was not required",
      { closingReason: "withdrawn", dbsReferral: "not_required" },
      "casework_no_sanction",
    ],
  ])("%s", (_name, overrides, expected) => {
    expect(caseRetentionClass({ ...base, ...overrides })).toBe(expected);
  });
});
