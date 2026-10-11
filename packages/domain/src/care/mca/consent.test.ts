import { describe, expect, it } from "vitest";
import {
  CONSENT_DECISION_KINDS,
  CONSENT_DECISIONS,
  type ConsentDecisionKind,
  type ConsentGiver,
  type ConsentProblem,
  type ConsentRecordView,
  checkConsentRecord,
  consentStatus,
  type RepresentativeAuthority,
} from "./consent";

/**
 * Consent per decision (CARE-021). Hazard HZ-026: restrictive or covert care given under consent or
 * authority that is not valid. Invented people only; references are opaque ids.
 */

const AT = new Date("2026-10-11T10:00:00Z");
const EARLIER = new Date("2026-09-01T10:00:00Z");

function record(overrides: Partial<ConsentRecordView> = {}): ConsentRecordView {
  return {
    id: "consent-1",
    decision: "care_plan",
    outcome: "given",
    givenBy: { kind: "person" },
    capacity: { status: "assumed" },
    givenAt: EARLIER,
    expiresAt: null,
    withdrawnAt: null,
    evidence: "Discussed with Ada Example at her care plan review",
    restraintConditions: null,
    bestInterestsDecisionId: null,
    ...overrides,
  };
}

const rep = (authority: RepresentativeAuthority): ConsentGiver => ({
  kind: "representative",
  authority,
});
const lacks = { status: "lacks_capacity", assessmentId: "mca-1" } as const;
const hasCapacity = { status: "has_capacity", assessmentId: "mca-2" } as const;
const welfareLpa: RepresentativeAuthority = {
  kind: "lpa_health_welfare",
  registered: true,
  opgReference: "OPG-EXAMPLE-1",
};

const problems = (r: ConsentRecordView): ConsentProblem[] =>
  checkConsentRecord(r, AT).map((i) => i.problem);

describe("hazard HZ-026 consent authority by representative type", () => {
  it.each<[string, Partial<ConsentRecordView>, ConsentProblem[]]>([
    ["the person, capacity assumed", {}, []],
    ["the person, assessed as having capacity", { capacity: hasCapacity }, []],
    ["the person, assessed as lacking capacity", { capacity: lacks }, ["person_lacks_capacity"]],
    ["a registered health and welfare attorney", { givenBy: rep(welfareLpa), capacity: lacks }, []],
    [
      "an unregistered health and welfare attorney",
      { givenBy: rep({ kind: "lpa_health_welfare", registered: false }), capacity: lacks },
      ["lpa_not_registered"],
    ],
    [
      "a health and welfare attorney while capacity is assumed",
      { givenBy: rep(welfareLpa) },
      ["representative_needs_lack_of_capacity"],
    ],
    [
      "a health and welfare attorney whose instrument excludes the decision",
      {
        givenBy: rep({ ...welfareLpa, excludedDecisions: ["care_plan"] }),
        capacity: lacks,
      },
      ["lpa_excludes_decision"],
    ],
    [
      "a property and financial affairs attorney",
      { givenBy: rep({ kind: "lpa_property_financial", registered: true }), capacity: lacks },
      ["lpa_wrong_kind"],
    ],
    [
      "a personal welfare deputy whose order covers the decision",
      {
        givenBy: rep({ kind: "deputy", scope: "personal_welfare", decisions: ["care_plan"] }),
        capacity: lacks,
      },
      [],
    ],
    [
      "a personal welfare deputy whose order does not cover the decision",
      {
        givenBy: rep({ kind: "deputy", scope: "personal_welfare", decisions: ["photos"] }),
        capacity: lacks,
      },
      ["deputy_order_does_not_cover"],
    ],
    [
      "a property and affairs deputy",
      {
        givenBy: rep({ kind: "deputy", scope: "property_and_affairs", decisions: ["care_plan"] }),
        capacity: lacks,
      },
      ["deputy_order_does_not_cover"],
    ],
    [
      "a deputy whose order has ended",
      {
        givenBy: rep({
          kind: "deputy",
          scope: "personal_welfare",
          decisions: ["care_plan"],
          orderEndsAt: new Date("2026-10-01T00:00:00Z"),
        }),
        capacity: lacks,
      },
      ["deputy_order_ended"],
    ],
    [
      "an appointee",
      { givenBy: rep({ kind: "appointee" }), capacity: lacks },
      ["representative_has_no_authority"],
    ],
    [
      "an IMCA",
      { givenBy: rep({ kind: "imca" }), capacity: lacks },
      ["representative_has_no_authority"],
    ],
    [
      "an advocate",
      { givenBy: rep({ kind: "advocate" }), capacity: lacks },
      ["representative_has_no_authority"],
    ],
    [
      "a family member or next of kin",
      { givenBy: rep({ kind: "family_or_friend" }), capacity: lacks },
      ["representative_has_no_authority"],
    ],
  ])("%s", (_name, overrides, expected) => {
    expect(problems(record(overrides))).toEqual(expected);
  });

  it.each(["marketing", "ai_processing"] as const)(
    "only the person can consent to %s",
    (decision) => {
      expect(problems(record({ decision, givenBy: rep(welfareLpa), capacity: lacks }))).toEqual([
        "representative_not_permitted",
      ]);
      expect(problems(record({ decision }))).toEqual([]);
    },
  );

  it("needs restraint conditions before an attorney agrees to bed rails (MCA s.11(1) to (5))", () => {
    const bedRails = record({ decision: "bed_rails", givenBy: rep(welfareLpa), capacity: lacks });
    expect(problems(bedRails)).toEqual(["restraint_conditions_missing"]);
    expect(
      problems({
        ...bedRails,
        restraintConditions: { necessaryToPreventHarm: true, proportionate: false },
      }),
    ).toEqual(["restraint_conditions_missing"]);
    expect(
      problems({
        ...bedRails,
        restraintConditions: { necessaryToPreventHarm: true, proportionate: true },
      }),
    ).toEqual([]);
  });

  it("lets a deputy agree to bed rails only with express authority from the court (s.20(8))", () => {
    const base = record({
      decision: "bed_rails",
      capacity: lacks,
      restraintConditions: { necessaryToPreventHarm: true, proportionate: true },
    });
    const deputy = (restraintExpresslyAuthorised: boolean) =>
      rep({
        kind: "deputy",
        scope: "personal_welfare",
        decisions: ["bed_rails"],
        restraintExpresslyAuthorised,
      });
    expect(problems({ ...base, givenBy: deputy(false) })).toEqual(["restraint_not_authorised"]);
    expect(problems({ ...base, givenBy: deputy(true) })).toEqual([]);
  });

  it("refuses covert medicines for a person with capacity and needs a best-interests decision (NICE SC1 1.15)", () => {
    expect(problems(record({ decision: "covert_medicines" }))).toEqual([
      "covert_needs_lack_of_capacity",
    ]);
    const byAttorney = record({
      decision: "covert_medicines",
      givenBy: rep(welfareLpa),
      capacity: lacks,
    });
    expect(problems(byAttorney)).toEqual(["best_interests_decision_missing"]);
    expect(problems({ ...byAttorney, bestInterestsDecisionId: "bi-1" })).toEqual([]);
  });

  it("needs evidence of how the decision was made", () => {
    expect(problems(record({ evidence: " " }))).toEqual(["evidence_missing"]);
    expect(problems(record({ evidence: null }))).toEqual(["evidence_missing"]);
  });

  it("cites the Act for every legal problem", () => {
    const issues = checkConsentRecord(
      record({ givenBy: rep({ kind: "family_or_friend" }), capacity: lacks }),
      AT,
    );
    expect(issues[0]?.source?.url).toMatch(/^https:\/\/www\.legislation\.gov\.uk\//);
    expect(issues[0]?.message).toMatch(/no legal authority/);
  });
});

describe("hazard HZ-026 whether a valid consent exists at a time", () => {
  it.each<[string, readonly ConsentRecordView[], Date, string, ConsentProblem[]]>([
    ["no record", [], AT, "none", ["no_record"]],
    [
      "a consent given later",
      [record({ givenAt: new Date("2026-11-01T09:00:00Z") })],
      AT,
      "none",
      ["not_yet_given"],
    ],
    ["a valid consent", [record()], AT, "valid", []],
    [
      "an expired consent",
      [record({ expiresAt: new Date("2026-10-01T00:00:00Z") })],
      AT,
      "none",
      ["expired"],
    ],
    [
      "consent expiring after the time asked",
      [record({ expiresAt: new Date("2026-12-01T00:00:00Z") })],
      AT,
      "valid",
      [],
    ],
    [
      "a withdrawn consent",
      [record({ withdrawnAt: new Date("2026-10-05T12:00:00Z") })],
      AT,
      "none",
      ["withdrawn"],
    ],
    [
      "withdrawn after the time asked",
      [record({ withdrawnAt: new Date("2026-10-20T12:00:00Z") })],
      AT,
      "valid",
      [],
    ],
    [
      "a later refusal replaces an earlier consent",
      [
        record(),
        record({ id: "consent-2", outcome: "refused", givenAt: new Date("2026-10-01T09:00:00Z") }),
      ],
      AT,
      "refused",
      [],
    ],
    [
      "a later consent replaces an earlier refusal",
      [
        record({ outcome: "refused" }),
        record({ id: "consent-2", givenAt: new Date("2026-10-01T09:00:00Z") }),
      ],
      AT,
      "valid",
      [],
    ],
    [
      "another decision's consent does not count",
      [record({ decision: "photos" })],
      AT,
      "none",
      ["no_record"],
    ],
  ])("%s", (_name, records, at, status, expectedProblems) => {
    const result = consentStatus(records, "care_plan", at);
    expect(result.status).toBe(status);
    if (result.status === "none") {
      expect(result.issues.map((i) => i.problem)).toEqual(expectedProblems);
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it("stops relying on a representative once the person has capacity for the decision", () => {
    const byAttorney = record({ givenBy: rep(welfareLpa), capacity: lacks });
    expect(consentStatus([byAttorney], "care_plan", AT, "lacks_capacity").status).toBe("valid");
    const now = consentStatus([byAttorney], "care_plan", AT, "has_capacity");
    expect(now.status === "none" && now.issues.map((i) => i.problem)).toEqual([
      "person_has_capacity_now",
    ]);
  });

  it("says who refused", () => {
    const refused = consentStatus(
      [record({ outcome: "refused", givenBy: rep(welfareLpa), capacity: lacks })],
      "care_plan",
      AT,
    );
    expect(refused).toMatchObject({
      status: "refused",
      message: "Their representative refused consent for this decision.",
    });
    expect(consentStatus([record({ outcome: "refused" })], "care_plan", AT)).toMatchObject({
      message: "The person refused consent for this decision.",
    });
  });
});

describe("consent decision catalogue", () => {
  it("lists the master prompt decisions with a label and a source each", () => {
    const required: ConsentDecisionKind[] = [
      "care_plan",
      "photos",
      "sharing",
      "ai_processing",
      "bed_rails",
      "covert_medicines",
    ];
    for (const kind of required) expect(CONSENT_DECISION_KINDS).toContain(kind);
    for (const kind of CONSENT_DECISION_KINDS) {
      const rule = CONSENT_DECISIONS[kind];
      expect(rule.label).not.toBe("");
      expect(rule.sources.length).toBeGreaterThan(0);
      // Every decision a representative may make is a personal welfare matter (MCA s.9(1)(a)).
      if (rule.representativeMayConsent) expect(rule.personalWelfare).toBe(true);
      else expect(rule.representativeNote).not.toBeNull();
    }
  });
});
