import { describe, expect, it } from "vitest";
import {
  type AdmissionDecisionInput,
  checkAdmissionDecision,
  PRE_ADMISSION_SECTIONS,
  type PreAdmissionAssessment,
  type PreAdmissionSectionKey,
  type PreAdmissionSectionState,
  preAdmissionCompleteness,
} from "./pre-admission";

const DONE_AT = new Date("2026-10-05T14:00:00Z");
const done: PreAdmissionSectionState = {
  status: "complete",
  completedBy: "nurse-1",
  completedAt: DONE_AT,
};

function completeSections(): Partial<Record<PreAdmissionSectionKey, PreAdmissionSectionState>> {
  return Object.fromEntries(
    PRE_ADMISSION_SECTIONS.filter((s) => s.required).map((s) => [s.key, done]),
  ) as Partial<Record<PreAdmissionSectionKey, PreAdmissionSectionState>>;
}

function assessment(overrides: Partial<PreAdmissionAssessment> = {}): PreAdmissionAssessment {
  return {
    sections: completeSections(),
    sources: ["person", "hospital"],
    personInvolvement: { involved: true },
    ...overrides,
  };
}

const manager = new Set(["people.admission.manage"]);

function decision(overrides: Partial<AdmissionDecisionInput> = {}): AdmissionDecisionInput {
  return {
    canMeetNeeds: "yes",
    reasons: "Nursing needs match the home's skills and a ground-floor room is free.",
    decidedBy: "manager-1",
    decidedAt: new Date("2026-10-06T09:00:00Z"),
    deciderPermissions: manager,
    plannedAdmissionOn: "2026-10-12",
    ...overrides,
  };
}

describe("pre-admission sections", () => {
  it("covers the master prompt 9.2 list and keys are unique", () => {
    const keys = PRE_ADMISSION_SECTIONS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of [
      "health_and_medical_history",
      "risks",
      "dependency",
      "equipment",
      "infection_status",
      "medicines",
      "capacity_and_legal_status",
      "hospital_passport",
    ]) {
      expect(keys).toContain(key);
    }
  });

  it("hazard HZ-007 never lets allergies be marked not applicable", () => {
    const allergies = PRE_ADMISSION_SECTIONS.find((s) => s.key === "allergies");
    expect(allergies).toMatchObject({ required: true, allowNotApplicable: false });
    const result = preAdmissionCompleteness(
      assessment({
        sections: {
          ...completeSections(),
          allergies: {
            status: "not_applicable",
            reason: "None",
            completedBy: "n",
            completedAt: DONE_AT,
          },
        },
      }),
    );
    expect(result.outstanding).toEqual([
      { key: "allergies", problem: "not_applicable_not_allowed" },
    ]);
  });

  it("hazard HZ-015 requires the resuscitation and advance care section", () => {
    const sections = completeSections();
    delete sections.resuscitation_and_advance_care;
    expect(preAdmissionCompleteness(assessment({ sections })).outstanding).toEqual([
      { key: "resuscitation_and_advance_care", problem: "not_started" },
    ]);
  });
});

describe("pre-admission completeness", () => {
  it.each<[string, Partial<PreAdmissionAssessment>, boolean, readonly string[]]>([
    ["every required section complete", {}, true, []],
    [
      "a section still in progress",
      { sections: { ...completeSections(), medicines: { status: "in_progress" } } },
      false,
      ["medicines:in_progress"],
    ],
    [
      "equipment not applicable with a reason",
      {
        sections: {
          ...completeSections(),
          equipment: {
            status: "not_applicable",
            reason: "Walks unaided",
            completedBy: "n",
            completedAt: DONE_AT,
          },
        },
      },
      true,
      [],
    ],
    [
      "equipment not applicable without a reason",
      {
        sections: {
          ...completeSections(),
          equipment: {
            status: "not_applicable",
            reason: " ",
            completedBy: "n",
            completedAt: DONE_AT,
          },
        },
      },
      false,
      ["equipment:not_applicable_reason_required"],
    ],
    [
      "optional sections left out or in progress",
      { sections: { ...completeSections(), hospital_passport: { status: "in_progress" } } },
      true,
      [],
    ],
  ])("%s", (_label, overrides, complete, outstanding) => {
    const result = preAdmissionCompleteness(assessment(overrides));
    expect(result.complete).toBe(complete);
    expect(result.outstanding.map((o) => `${o.key}:${o.problem}`)).toEqual(outstanding);
  });

  it("needs at least one information source", () => {
    const result = preAdmissionCompleteness(assessment({ sources: [] }));
    expect(result).toMatchObject({ complete: false, sourcesMissing: true });
  });

  it("needs the person's involvement or the reason they could not take part", () => {
    expect(
      preAdmissionCompleteness(assessment({ personInvolvement: { involved: false, reason: "" } })),
    ).toMatchObject({ complete: false, involvementMissing: true });
    expect(
      preAdmissionCompleteness(
        assessment({
          personInvolvement: {
            involved: false,
            reason: "Unconscious on the ward; daughter consulted",
          },
        }),
      ).complete,
    ).toBe(true);
  });

  it("reports the latest completion time", () => {
    const later = new Date("2026-10-05T16:30:00Z");
    const result = preAdmissionCompleteness(
      assessment({
        sections: {
          ...completeSections(),
          risks: { status: "complete", completedBy: "n", completedAt: later },
        },
      }),
    );
    expect(result.lastCompletedAt).toEqual(later);
    expect(preAdmissionCompleteness(assessment({ sections: {} })).lastCompletedAt).toBeNull();
  });
});

describe("decision to admit", () => {
  it("records a positive decision with reasons and who decided", () => {
    const result = checkAdmissionDecision(assessment(), decision({ conditions: ["ignored"] }));
    expect(result).toEqual({
      ok: true,
      decision: {
        canMeetNeeds: "yes",
        admit: true,
        reasons: "Nursing needs match the home's skills and a ground-floor room is free.",
        conditions: [],
        decidedBy: "manager-1",
        decidedAt: new Date("2026-10-06T09:00:00Z"),
        plannedAdmissionOn: "2026-10-12",
        trialEndsOn: null,
      },
    });
  });

  it("records conditions and a trial period", () => {
    const result = checkAdmissionDecision(
      assessment(),
      decision({
        canMeetNeeds: "yes_with_conditions",
        conditions: [" Pressure-relieving mattress delivered "],
        trialEndsOn: "2026-11-09",
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      decision: {
        admit: true,
        conditions: ["Pressure-relieving mattress delivered"],
        trialEndsOn: "2026-11-09",
      },
    });
  });

  it("records a decline as not admitting", () => {
    const result = checkAdmissionDecision(
      assessment(),
      decision({ canMeetNeeds: "no", reasons: "Needs one-to-one nursing the home cannot staff." }),
    );
    expect(result).toMatchObject({ ok: true, decision: { admit: false } });
  });

  it.each<
    [string, Partial<PreAdmissionAssessment>, Partial<AdmissionDecisionInput>, readonly string[]]
  >([
    ["an incomplete assessment", { sections: {} }, {}, ["assessment_incomplete"]],
    ["a one-word reason", {}, { reasons: "Fine" }, ["reasons_required"]],
    ["conditions missing", {}, { canMeetNeeds: "yes_with_conditions" }, ["conditions_required"]],
    [
      "a blank condition",
      {},
      { canMeetNeeds: "yes_with_conditions", conditions: ["  "] },
      ["conditions_blank"],
    ],
    [
      "someone without the permission",
      {},
      { deciderPermissions: new Set(["care.plan.write"]) },
      ["not_authorised"],
    ],
    [
      "a decision before the assessment finished",
      {},
      { decidedAt: new Date("2026-10-05T13:00:00Z") },
      ["decided_before_assessment"],
    ],
    ["an impossible date", {}, { plannedAdmissionOn: "2026-02-30" }, ["invalid_date"]],
    [
      "a trial ending before admission",
      {},
      { trialEndsOn: "2026-10-12" },
      ["trial_ends_before_admission"],
    ],
    [
      "several problems at once",
      { sources: [] },
      { reasons: "", deciderPermissions: new Set<string>() },
      ["assessment_incomplete", "reasons_required", "not_authorised"],
    ],
  ])("refuses %s", (_label, assessmentOverrides, decisionOverrides, problems) => {
    const result = checkAdmissionDecision(
      assessment(assessmentOverrides),
      decision(decisionOverrides),
    );
    expect(result).toMatchObject({ ok: false, problems });
  });
});
