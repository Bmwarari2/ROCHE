import { describe, expect, it } from "vitest";
import {
  BEST_INTERESTS_CHECKLIST,
  BEST_INTERESTS_ITEM_KEYS,
  type BestInterestsInput,
  type BestInterestsItemKey,
  type ChecklistAnswer,
  checkBestInterests,
  imcaPrompt,
} from "./best-interests";
import {
  type CapacityAssessmentInput,
  type CapacityAssessmentView,
  capacityFinding,
  checkCapacityAssessment,
  FUNCTIONAL_ELEMENTS,
} from "./capacity";

/**
 * Capacity (care.md rule 9) and best interests (rule 10), table-driven against the Mental Capacity
 * Act 2005. Hazard HZ-026. Invented people only.
 */

const NOW = new Date("2026-10-11T12:00:00Z");

function assessment(overrides: Partial<CapacityAssessmentInput> = {}): CapacityAssessmentInput {
  return {
    decision: "Whether to have bed rails on her bed at night",
    decisionKind: "bed_rails",
    assessedAt: new Date("2026-10-11T09:30:00Z"),
    assessorId: "staff-7",
    practicableSteps: [
      { step: "visual_aids", detail: "Showed photographs of the bed with and without rails" },
      { step: "best_time_or_place", detail: "Morning, in her own room, after breakfast" },
    ],
    stage1: { impairment: true, description: "Advanced dementia" },
    stage2: {
      understand: { able: true, evidence: "Explained the rails back in her own words" },
      retain: { able: false, evidence: "Could not recall the discussion five minutes later" },
      useOrWeigh: {
        able: false,
        evidence: "Could not weigh the risk of falling against the rails",
      },
      communicate: { able: true, evidence: "Spoke clearly" },
    },
    inabilityBecauseOfImpairment: true,
    outcome: "lacks_capacity",
    reviewOn: "2027-01-11",
    ...overrides,
  };
}

const issuesOf = (input: CapacityAssessmentInput) => {
  const result = checkCapacityAssessment(input, NOW);
  return result.ok ? [] : result.issues.map((i) => `${i.item}:${i.problem}`);
};

const allAble = {
  understand: { able: true },
  retain: { able: true },
  useOrWeigh: { able: true },
  communicate: { able: true },
};

describe("hazard HZ-026 capacity: lacks capacity only when stage 1 is met and a stage 2 element is not", () => {
  it("accepts a complete assessment that finds a lack of capacity, naming the elements", () => {
    const result = checkCapacityAssessment(assessment(), NOW);
    expect(result).toMatchObject({
      ok: true,
      outcome: "lacks_capacity",
      unableTo: ["retain", "useOrWeigh"],
    });
    expect(result.ok && result.reason).toMatch(/s\.2\(1\) and s\.3\(1\)/);
  });

  it.each<[string, Partial<CapacityAssessmentInput>, "has_capacity" | "lacks_capacity" | string[]]>(
    [
      [
        "stage 1 not met: has capacity",
        {
          stage1: { impairment: false },
          stage2: {},
          outcome: "has_capacity",
          practicableSteps: [],
        },
        "has_capacity",
      ],
      [
        "stage 1 not met but recorded as lacking capacity",
        { stage1: { impairment: false }, stage2: {}, outcome: "lacks_capacity" },
        ["outcome:not_allowed"],
      ],
      [
        "every stage 2 element met: has capacity",
        { stage2: allAble, outcome: "has_capacity" },
        "has_capacity",
      ],
      [
        "every stage 2 element met but recorded as lacking",
        { stage2: allAble, outcome: "lacks_capacity" },
        ["outcome:not_allowed"],
      ],
      [
        "unable, but not because of the impairment: has capacity (s.2(1))",
        { inabilityBecauseOfImpairment: false, outcome: "has_capacity" },
        "has_capacity",
      ],
      [
        "unable because of the impairment but recorded as having capacity",
        { outcome: "has_capacity" },
        ["outcome:not_allowed"],
      ],
      [
        "no practicable steps before finding a lack of capacity (s.1(3))",
        { practicableSteps: [] },
        ["practicableSteps:missing"],
      ],
      [
        "has capacity needs no steps recorded",
        { stage2: allAble, outcome: "has_capacity", practicableSteps: [] },
        "has_capacity",
      ],
    ],
  )("%s", (_name, overrides, expected) => {
    const input = assessment(overrides);
    if (Array.isArray(expected)) {
      expect(issuesOf(input)).toEqual(expected);
    } else {
      expect(checkCapacityAssessment(input, NOW)).toMatchObject({ ok: true, outcome: expected });
    }
  });

  it.each(FUNCTIONAL_ELEMENTS)("needs an answer for %s once stage 1 is met", (element) => {
    const stage2 = { ...assessment().stage2 };
    delete stage2[element];
    expect(issuesOf(assessment({ stage2 }))).toContain(`stage2.${element}:missing`);
  });

  it("is decision-specific and time-specific", () => {
    expect(issuesOf(assessment({ decision: "Everything" }))).toEqual(["decision:not_allowed"]);
    expect(issuesOf(assessment({ decision: "general." }))).toEqual(["decision:not_allowed"]);
    expect(issuesOf(assessment({ decision: "" }))).toEqual(["decision:missing"]);
    expect(issuesOf(assessment({ assessedAt: null }))).toEqual(["assessedAt:missing"]);
    expect(issuesOf(assessment({ assessedAt: new Date("2026-10-12T09:00:00Z") }))).toEqual([
      "assessedAt:out_of_range",
    ]);
  });

  it("lists every missing answer at once and counts them", () => {
    const result = checkCapacityAssessment(
      assessment({
        assessorId: null,
        stage1: { impairment: null },
        outcome: null,
        reviewOn: "2027-02-30",
        decisionKind: "holidays" as never,
        practicableSteps: [{ step: "magic" as never, detail: " " }],
      }),
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.item)).toEqual([
      "decisionKind",
      "assessorId",
      "reviewOn",
      "practicableSteps.0",
      "practicableSteps.0",
      "stage1.impairment",
      "outcome",
    ]);
    expect(result.message).toBe("Assessment incomplete: 4 answers missing.");
  });

  it("needs the impairment described, evidence for each inability and the causal link", () => {
    expect(
      issuesOf(
        assessment({
          stage1: { impairment: true, description: "" },
          stage2: { ...assessment().stage2, retain: { able: false, evidence: null } },
          inabilityBecauseOfImpairment: null,
        }),
      ),
    ).toEqual([
      "stage1.description:missing",
      "stage2.retain.evidence:missing",
      "inabilityBecauseOfImpairment:missing",
    ]);
  });

  it("says check the answers when nothing is missing but the outcome does not follow", () => {
    const result = checkCapacityAssessment(assessment({ outcome: "has_capacity" }), NOW);
    expect(!result.ok && result.message).toBe("Assessment not saved: check the answers.");
  });

  it("gives the reason for each way of having capacity", () => {
    const reason = (o: Partial<CapacityAssessmentInput>) => {
      const r = checkCapacityAssessment(assessment(o), NOW);
      return r.ok ? r.reason : "";
    };
    expect(reason({ stage1: { impairment: false }, stage2: {}, outcome: "has_capacity" })).toMatch(
      /stage 1 is not met/,
    );
    expect(reason({ stage2: allAble, outcome: "has_capacity" })).toMatch(/able to understand/);
    expect(reason({ inabilityBecauseOfImpairment: false, outcome: "has_capacity" })).toMatch(
      /not because of/,
    );
  });
});

describe("hazard HZ-026 capacity is assumed unless an assessment of that decision says otherwise", () => {
  const view = (o: Partial<CapacityAssessmentView>): CapacityAssessmentView => ({
    id: "mca-1",
    decisionKind: "bed_rails",
    assessedAt: new Date("2026-09-01T10:00:00Z"),
    outcome: "lacks_capacity",
    reviewOn: "2026-12-01",
    ...o,
  });

  it.each<[string, CapacityAssessmentView[], string, boolean | null]>([
    ["no assessment: capacity is assumed", [], "assumed", null],
    [
      "an assessment of another decision does not count",
      [view({ decisionKind: "photos" })],
      "assumed",
      null,
    ],
    [
      "an assessment after the time asked does not count",
      [view({ assessedAt: new Date("2026-10-20T10:00:00Z") })],
      "assumed",
      null,
    ],
    [
      "the latest assessment of the decision counts",
      [
        view({}),
        view({
          id: "mca-2",
          assessedAt: new Date("2026-10-01T10:00:00Z"),
          outcome: "has_capacity",
        }),
      ],
      "has_capacity",
      false,
    ],
    ["an overdue review is flagged", [view({ reviewOn: "2026-10-01" })], "lacks_capacity", true],
    ["no review date is never overdue", [view({ reviewOn: null })], "lacks_capacity", false],
  ])("%s", (_name, assessments, status, overdue) => {
    const finding = capacityFinding(assessments, "bed_rails", NOW, "2026-10-11");
    expect(finding.status).toBe(status);
    if (finding.status !== "assumed") expect(finding.reviewOverdue).toBe(overdue);
  });
});

function checklist(
  answer: (key: BestInterestsItemKey) => ChecklistAnswer | undefined = () => ({
    answer: "considered",
    note: "Discussed and recorded",
  }),
): Partial<Record<BestInterestsItemKey, ChecklistAnswer>> {
  const entries = BEST_INTERESTS_ITEM_KEYS.map((k) => [k, answer(k)] as const).filter(([, a]) => a);
  return Object.fromEntries(entries);
}

function bestInterests(overrides: Partial<BestInterestsInput> = {}): BestInterestsInput {
  return {
    capacityOutcome: "lacks_capacity",
    decision: "Bed rails at night with bumpers, reviewed monthly",
    checklist: checklist(),
    consultations: [
      {
        consultee: "family_or_friend",
        views: "Her son, Ben Example, supports rails",
        consultedAt: NOW,
      },
    ],
    noConsultationReason: null,
    seriousMedicalTreatment: false,
    accommodationChange: false,
    reviewOn: "2026-11-11",
    ...overrides,
  };
}

const biIssues = (input: BestInterestsInput) => {
  const r = checkBestInterests(input);
  return r.ok ? [] : r.issues.map((i) => `${i.item}:${i.problem}`);
};

describe("hazard HZ-026 best-interests checklist is complete only when every item is answered", () => {
  it("accepts a complete decision", () => {
    expect(checkBestInterests(bestInterests())).toEqual({ ok: true, imca: null });
  });

  it("covers section 4 and the less restrictive option, citing legislation.gov.uk", () => {
    expect(BEST_INTERESTS_CHECKLIST.map((i) => i.provision)).toEqual([
      "s.4(1)",
      "s.4(2)",
      "s.4(3)",
      "s.4(4)",
      "s.4(5)",
      "s.4(6)(a)",
      "s.4(6)(b)",
      "s.4(6)(c)",
      "s.4(7)",
      "s.1(6)",
    ]);
    for (const item of BEST_INTERESTS_CHECKLIST) {
      expect(item.source.url).toMatch(
        /^https:\/\/www\.legislation\.gov\.uk\/ukpga\/2005\/9\/section\//,
      );
    }
  });

  it.each(BEST_INTERESTS_ITEM_KEYS)("refuses a decision with %s unanswered", (key) => {
    const input = bestInterests({
      checklist: checklist((k) =>
        k === key ? undefined : { answer: "considered", note: "Recorded" },
      ),
    });
    expect(biIssues(input)).toEqual([`checklist.${key}:missing`]);
  });

  it.each<[string, ChecklistAnswer, string[]]>([
    [
      "not applicable with a reason counts",
      { answer: "not_applicable", reason: "Not life-sustaining treatment" },
      [],
    ],
    [
      "not applicable without a reason does not",
      { answer: "not_applicable", reason: " " },
      ["checklist.life_sustaining_treatment:missing"],
    ],
    [
      "considered with no note does not",
      { answer: "considered", note: "" },
      ["checklist.life_sustaining_treatment:missing"],
    ],
  ])("%s", (_name, answer, expected) => {
    const input = bestInterests({
      checklist: { ...checklist(), life_sustaining_treatment: answer },
    });
    expect(biIssues(input)).toEqual(expected);
  });

  it.each<[string, Partial<BestInterestsInput>, string[]]>([
    ["no consultation and no reason", { consultations: [] }, ["consultations:missing"]],
    [
      "no consultation, with the reason",
      { consultations: [], noConsultationReason: "No family; GP unavailable until Monday" },
      [],
    ],
    [
      "a consultation without the views",
      { consultations: [{ consultee: "lpa_donee", views: "", consultedAt: NOW }] },
      ["consultations.0:missing"],
    ],
    [
      "a consultee kind that is not listed",
      {
        consultations: [{ consultee: "neighbour" as never, views: "Supportive", consultedAt: NOW }],
      },
      ["consultations.0:not_allowed"],
    ],
    [
      "a person with capacity decides for themselves",
      { capacityOutcome: "has_capacity" },
      ["capacityOutcome:not_allowed"],
    ],
    ["no linked capacity assessment", { capacityOutcome: null }, ["capacityOutcome:missing"]],
    ["no decision", { decision: "" }, ["decision:missing"]],
    ["no review date", { reviewOn: null }, ["reviewOn:missing"]],
    ["an impossible review date", { reviewOn: "2026-13-01" }, ["reviewOn:not_allowed"]],
  ])("%s", (_name, overrides, expected) => {
    expect(biIssues(bestInterests(overrides))).toEqual(expected);
  });

  it("counts the missing items in the message", () => {
    const result = checkBestInterests(bestInterests({ checklist: {}, consultations: [] }));
    expect(!result.ok && result.message).toBe(
      "Best-interests checklist incomplete: 11 items missing.",
    );
    const invalid = checkBestInterests(bestInterests({ capacityOutcome: "has_capacity" }));
    expect(!invalid.ok && invalid.message).toBe(
      "Best-interests decision not saved: check the answers.",
    );
  });
});

describe("hazard HZ-026 IMCA prompt when nobody appropriate can be consulted (MCA s.37 to s.39)", () => {
  const paid = {
    consultee: "paid_carer_or_professional",
    views: "Agrees",
    consultedAt: NOW,
  } as const;
  it.each<[string, Partial<BestInterestsInput>, string | null]>([
    [
      "serious medical treatment, only paid staff consulted",
      { seriousMedicalTreatment: true, consultations: [paid] },
      "s.37",
    ],
    [
      "a change of accommodation, nobody consulted",
      { accommodationChange: true, consultations: [] },
      "s.38",
    ],
    [
      "both, nobody consulted",
      { seriousMedicalTreatment: true, accommodationChange: true, consultations: [] },
      "s.37",
    ],
    [
      "serious medical treatment, a deputy consulted",
      {
        seriousMedicalTreatment: true,
        consultations: [{ consultee: "deputy", views: "Agrees", consultedAt: NOW }],
      },
      null,
    ],
    [
      "a change of accommodation, an IMCA already involved",
      {
        accommodationChange: true,
        consultations: [{ consultee: "imca", views: "Report attached", consultedAt: NOW }],
      },
      null,
    ],
    ["neither serious treatment nor a move", { consultations: [] }, null],
  ])("%s", (_name, overrides, provision) => {
    const prompt = imcaPrompt(bestInterests(overrides));
    if (provision === null) expect(prompt).toBeNull();
    else {
      expect(prompt?.sources.map((s) => s.provision)).toContain(provision);
      expect(prompt?.message).toMatch(/independent mental capacity advocate must be instructed/);
    }
  });

  it("returns the prompt with the completeness check", () => {
    const result = checkBestInterests(
      bestInterests({
        accommodationChange: true,
        consultations: [],
        noConsultationReason: "No family",
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.imca?.message).toMatch(/change of accommodation/);
  });
});
