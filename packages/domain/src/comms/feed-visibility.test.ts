import { describe, expect, it } from "vitest";
import type { CapacityAssessmentView } from "../care/mca/capacity";
import type { ConsentRecordView } from "../care/mca/consent";
import type { PersonStatus } from "../people/lifecycle";
import type {
  CapacityForSharing,
  SharingAuthority,
  SharingDecision,
  SharingSection,
} from "../people/sharing";
import {
  buildFamilyFeed,
  checkFeedItemVisibility,
  FEED_CARE_PLAN_DOMAINS,
  FEED_ITEM_KINDS,
  FEED_ITEM_SECTIONS,
  FEED_NOT_FULL_RECORD_STATEMENT,
  FEED_PAUSED_STATEMENT,
  FEED_WITHDRAWN_NOTICE,
  type FeedItem,
  type FeedItemKind,
  type FeedPhotoBasis,
  type FeedViewerContext,
  type FeedViewRecord,
  feedExposure,
  feedPhotoBasis,
  type PhotoBestInterestsView,
} from "./feed-visibility";

/**
 * Hazard HZ-022: a person's information shown to a family member without a sharing decision.
 * Invented people: Ada Example (the person), Ben Example (son, contact-ben), Cara Example
 * (granddaughter, contact-cara).
 */

const ADA = "person-ada";
const BEN = "contact-ben";
const NOW = new Date("2026-10-11T10:00:00Z");
const FROM = new Date("2026-10-01T00:00:00Z");
const TO = new Date("2027-04-01T00:00:00Z");
const PHOTO_OK: FeedPhotoBasis = { ok: true, basis: "consent", consentRecordId: "consent-1" };

function decision(overrides: Partial<SharingDecision> = {}): SharingDecision {
  return {
    id: "d1",
    personId: ADA,
    recipient: { kind: "family", contactId: BEN },
    sections: ["daily_updates", "photos", "activities_and_visits"],
    basis: "consent",
    consentGivenBy: "person",
    capacity: "presumed",
    validFrom: FROM,
    validTo: TO,
    withdrawnAt: null,
    suspendedAt: null,
    ...overrides,
  };
}

function item(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: "item-1",
    personId: ADA,
    kind: "activity",
    carePlanDomain: null,
    occurredAt: new Date("2026-10-10T14:00:00Z"),
    composedAt: new Date("2026-10-10T14:05:00Z"),
    text: "Ada joined the garden club and took part all the way through.",
    photoDocumentId: null,
    supersedesItemId: null,
    withdrawnAt: null,
    withdrawnReason: null,
    ...overrides,
  };
}

function viewer(overrides: Partial<FeedViewerContext> = {}): FeedViewerContext {
  return {
    person: { id: ADA, status: "active" },
    contactId: BEN,
    decisions: [decision()],
    capacityForSharingNow: "presumed",
    photoBasis: PHOTO_OK,
    now: NOW,
    ...overrides,
  };
}

describe("feed items map to the sections of the sharing rules", () => {
  it("gives every kind one section", () => {
    for (const kind of FEED_ITEM_KINDS) expect(FEED_ITEM_SECTIONS[kind]).toBeTruthy();
    expect(FEED_ITEM_SECTIONS).toEqual({
      activity: "activities_and_visits",
      visit: "activities_and_visits",
      appointment: "appointments",
      shared_note: "daily_updates",
      photo: "photos",
      care_plan_update: "care_plan",
      finance_statement: "finance",
    });
  });
});

describe("hazard HZ-022 the family feed shows an item only under a sharing decision in force", () => {
  it("shows a covered item and names the decision that allowed it", () => {
    expect(checkFeedItemVisibility(item(), viewer())).toEqual({
      visible: true,
      display: "item",
      section: "activities_and_visits",
      decisionId: "d1",
      expiresAt: TO,
    });
  });

  it.each<[string, Partial<FeedItem>, Partial<FeedViewerContext>, string]>([
    ["hazard HZ-022 no decision at all", {}, { decisions: [] }, "no_decision"],
    [
      "hazard HZ-022 a decision for another family member",
      {},
      { decisions: [decision({ recipient: { kind: "family", contactId: "contact-cara" } })] },
      "no_decision",
    ],
    [
      "hazard HZ-022 a professional's decision with the same id",
      {},
      {
        decisions: [
          decision({
            recipient: { kind: "professional", tenantUserId: BEN },
            basis: "direct_care",
            sections: ["daily_updates"],
            consentGivenBy: null,
          }),
        ],
      },
      "no_decision",
    ],
    [
      "hazard HZ-022 a section the decision does not name",
      { kind: "appointment" },
      {},
      "section_not_covered",
    ],
    [
      "hazard HZ-022 a care plan domain the decision does not name",
      { kind: "care_plan_update", carePlanDomain: "mobility" },
      {
        decisions: [
          decision({ sections: ["care_plan"], carePlanDomains: ["nutrition_and_hydration"] }),
        ],
      },
      "section_not_covered",
    ],
    [
      "hazard HZ-022 an expired decision",
      {},
      { decisions: [decision({ validTo: new Date("2026-10-11T09:00:00Z") })] },
      "expired",
    ],
    [
      "hazard HZ-022 withdrawn consent",
      {},
      { decisions: [decision({ withdrawnAt: new Date("2026-10-11T09:00:00Z") })] },
      "withdrawn",
    ],
    [
      "hazard HZ-022 sharing suspended during a safeguarding enquiry",
      {},
      { decisions: [decision({ suspendedAt: new Date("2026-10-11T09:00:00Z") })] },
      "suspended",
    ],
    ["hazard HZ-022 an item about another person", { personId: "person-dev" }, {}, "wrong_person"],
    [
      "hazard HZ-022 an item from before the decision started",
      { occurredAt: new Date("2026-09-30T12:00:00Z") },
      {},
      "before_decision_start",
    ],
    [
      "hazard HZ-022 a decision that has not started yet",
      { occurredAt: new Date("2026-10-11T09:00:00Z") },
      {
        decisions: [decision({ validFrom: new Date("2026-10-11T08:00:00Z") })],
        now: new Date("2026-10-11T07:00:00Z"),
      },
      "not_yet_valid",
    ],
    [
      "hazard HZ-022 a withdrawn item the viewer never saw",
      { withdrawnAt: new Date("2026-10-10T15:00:00Z"), withdrawnReason: "published_in_error" },
      {},
      "item_withdrawn",
    ],
    [
      "hazard HZ-022 a photo without consent or a best-interests decision",
      { kind: "photo", photoDocumentId: "doc-photo" },
      {
        photoBasis: {
          ok: false,
          problem: "consent_needed",
          message: "Ask the person whether photos can be shared with their family, and record it.",
        },
      },
      "photo_basis_missing",
    ],
    [
      "hazard HZ-022 a photo when nobody has checked the basis",
      { kind: "photo", photoDocumentId: "doc-photo" },
      { photoBasis: null },
      "photo_basis_missing",
    ],
  ])("hides the item for %s", (_label, itemOverrides, context, reason) => {
    expect(checkFeedItemVisibility(item(itemOverrides), viewer(context))).toEqual({
      visible: false,
      reason,
    });
  });

  it.each<[PersonStatus, boolean]>([
    ["active", true],
    ["on_leave", true],
    ["in_hospital", true],
    ["discharged", false],
    ["deceased", false],
    ["archived", false],
    ["not_admitted", false],
    ["enquiry", false],
    ["pre_admission", false],
  ])(
    "hazard HZ-022 follows the lifecycle: a person who is %s has an open feed: %s",
    (status, open) => {
      const result = checkFeedItemVisibility(item(), viewer({ person: { id: ADA, status } }));
      expect(result.visible).toBe(open);
      if (!result.visible) expect(result.reason).toBe("person_record_closed");
    },
  );

  it("shows items from before the decision once its start is set earlier", () => {
    const old = item({ occurredAt: new Date("2026-09-15T12:00:00Z") });
    const earlier = decision({ validFrom: new Date("2026-09-01T00:00:00Z") });
    expect(checkFeedItemVisibility(old, viewer({ decisions: [earlier] })).visible).toBe(true);
  });

  it("uses a decision in force when an older one was withdrawn", () => {
    const withdrawn = decision({ id: "old", withdrawnAt: new Date("2026-10-05T00:00:00Z") });
    const current = decision({ id: "new" });
    expect(
      checkFeedItemVisibility(item(), viewer({ decisions: [withdrawn, current] })),
    ).toMatchObject({
      visible: true,
      decisionId: "new",
    });
  });

  it("hides items from a gap between a withdrawal and a later decision", () => {
    // Consent withdrawn on 2 October, given again from 8 October: 5 October's update stays closed.
    const first = decision({ id: "first", withdrawnAt: new Date("2026-10-02T00:00:00Z") });
    const again = decision({ id: "again", validFrom: new Date("2026-10-08T00:00:00Z") });
    const inGap = item({ occurredAt: new Date("2026-10-05T12:00:00Z") });
    expect(checkFeedItemVisibility(inGap, viewer({ decisions: [first, again] }))).toEqual({
      visible: false,
      reason: "before_decision_start",
    });
  });

  it("hazard HZ-061 tells a viewer who saw an update that it was taken down, without its content", () => {
    const taken = item({
      withdrawnAt: new Date("2026-10-10T15:00:00Z"),
      withdrawnReason: "source_corrected",
    });
    expect(checkFeedItemVisibility(taken, viewer(), true)).toMatchObject({
      visible: true,
      display: "withdrawn_notice",
    });
  });

  it("hazard HZ-022 keeps a withdrawn update closed once the decision itself is withdrawn", () => {
    const taken = item({ withdrawnAt: new Date("2026-10-10T15:00:00Z") });
    const closed = decision({ withdrawnAt: new Date("2026-10-11T09:00:00Z") });
    expect(checkFeedItemVisibility(taken, viewer({ decisions: [closed] }), true)).toEqual({
      visible: false,
      reason: "withdrawn",
    });
  });
});

describe("hazard HZ-022 attorneys and deputies see what their authority covers", () => {
  const authority = (
    role: SharingAuthority["role"],
    validUntil: string | null = null,
    orderSections: readonly SharingSection[] | null = null,
  ): SharingAuthority => ({
    role,
    contactId: BEN,
    reference: "OPG-EXAMPLE-1",
    evidenceDocumentId: "doc-authority",
    validUntil,
    orderSections,
  });
  const byAuthority = (
    role: SharingAuthority["role"],
    sections: SharingSection[],
    overrides: Partial<SharingDecision> = {},
  ) =>
    decision({
      basis: "legal_authority",
      consentGivenBy: null,
      capacity: "assessed_lacks_capacity",
      authority: authority(role, null, role.startsWith("deputy_") ? sections : null),
      sections,
      ...overrides,
    });
  const kinds: readonly FeedItemKind[] = [
    "shared_note",
    "activity",
    "care_plan_update",
    "finance_statement",
  ];
  const visibleKinds = (
    decisions: SharingDecision[],
    capacityForSharingNow: CapacityForSharing = "assessed_lacks_capacity",
  ) =>
    kinds.filter(
      (kind) =>
        checkFeedItemVisibility(
          item({ kind, carePlanDomain: kind === "care_plan_update" ? "mobility" : null }),
          viewer({ decisions, capacityForSharingNow }),
        ).visible,
    );
  const care: SharingSection[] = ["daily_updates", "activities_and_visits", "care_plan"];

  it.each<[string, SharingDecision[], CapacityForSharing, readonly FeedItemKind[]]>([
    [
      "a health and welfare attorney sees care sections, not finance",
      [byAuthority("lpa_health_welfare", care)],
      "assessed_lacks_capacity",
      ["shared_note", "activity", "care_plan_update"],
    ],
    [
      "a property and financial affairs attorney sees finance only",
      [byAuthority("lpa_property_finance", ["finance"], { capacity: "presumed" })],
      "presumed",
      ["finance_statement"],
    ],
    [
      "a personal welfare deputy sees the care sections the order covers",
      [byAuthority("deputy_personal_welfare", care)],
      "assessed_lacks_capacity",
      ["shared_note", "activity", "care_plan_update"],
    ],
    [
      "a personal welfare deputy whose order leaves out the care plan",
      [
        byAuthority("deputy_personal_welfare", ["daily_updates", "activities_and_visits"], {
          authority: authority("deputy_personal_welfare", null, [
            "daily_updates",
            "activities_and_visits",
          ]),
        }),
      ],
      "assessed_lacks_capacity",
      ["shared_note", "activity"],
    ],
    [
      "a deputy's decision naming a section outside the order is never honoured",
      [
        byAuthority("deputy_personal_welfare", care, {
          authority: authority("deputy_personal_welfare", null, ["daily_updates"]),
        }),
      ],
      "assessed_lacks_capacity",
      [],
    ],
    [
      "a property and affairs deputy sees finance only",
      [byAuthority("deputy_property_affairs", ["finance"])],
      "assessed_lacks_capacity",
      ["finance_statement"],
    ],
    [
      "an appointee never sees a finance statement",
      [byAuthority("appointee", ["finance"], { capacity: "presumed" })],
      "presumed",
      [],
    ],
    [
      "a finance attorney's decision that names updates is never honoured",
      [byAuthority("lpa_property_finance", ["finance", "daily_updates"], { capacity: "presumed" })],
      "presumed",
      [],
    ],
    [
      "a welfare attorney's decision that names finance is never honoured",
      [byAuthority("lpa_health_welfare", ["daily_updates", "finance"])],
      "assessed_lacks_capacity",
      [],
    ],
    [
      "a welfare attorney recorded while the person had capacity sees nothing",
      [byAuthority("lpa_health_welfare", ["daily_updates"], { capacity: "presumed" })],
      "assessed_lacks_capacity",
      [],
    ],
    [
      "a welfare attorney once the person has regained capacity sees nothing",
      [byAuthority("lpa_health_welfare", care)],
      "assessed_has_capacity",
      [],
    ],
    [
      "a welfare deputy when no current finding is given sees nothing (capacity presumed)",
      [byAuthority("deputy_personal_welfare", care)],
      "presumed",
      [],
    ],
    [
      "a deputy whose order has ended sees nothing",
      [
        byAuthority("deputy_personal_welfare", ["daily_updates"], {
          authority: authority("deputy_personal_welfare", "2026-10-01", ["daily_updates"]),
        }),
      ],
      "assessed_lacks_capacity",
      [],
    ],
    [
      "a finance attorney also sees updates the person chose to share",
      [
        byAuthority("lpa_property_finance", ["finance"], { id: "finance", capacity: "presumed" }),
        decision({ id: "consent", sections: ["daily_updates"] }),
      ],
      "presumed",
      ["shared_note", "finance_statement"],
    ],
  ])("%s", (_label, decisions, capacity, expected) => {
    expect(visibleKinds(decisions, capacity)).toEqual(expected);
  });

  it("reports why a lapsed authority, or regained capacity, closes the feed", () => {
    const lapsed = byAuthority("lpa_health_welfare", ["daily_updates"], {
      authority: authority("lpa_health_welfare", "2026-10-01"),
    });
    expect(
      checkFeedItemVisibility(
        item({ kind: "shared_note" }),
        viewer({ decisions: [lapsed], capacityForSharingNow: "assessed_lacks_capacity" }),
      ),
    ).toEqual({ visible: false, reason: "authority_lapsed" });
    const welfare = byAuthority("lpa_health_welfare", ["daily_updates"]);
    expect(
      checkFeedItemVisibility(
        item({ kind: "shared_note" }),
        viewer({ decisions: [welfare], capacityForSharingNow: "assessed_has_capacity" }),
      ),
    ).toEqual({ visible: false, reason: "capacity_regained" });
  });
});

describe("hazard HZ-022 suspensions and data that should never exist stay closed", () => {
  const enquiry = { from: new Date("2026-10-05T00:00:00Z"), to: new Date("2026-10-08T00:00:00Z") };

  it("hides an update from a safeguarding suspension even after the suspension is lifted", () => {
    const d = decision({ suspensions: [enquiry] });
    const during = item({ occurredAt: new Date("2026-10-06T12:00:00Z") });
    const after = item({ id: "after", occurredAt: new Date("2026-10-09T12:00:00Z") });
    expect(checkFeedItemVisibility(during, viewer({ decisions: [d] }))).toEqual({
      visible: false,
      reason: "suspended_when_it_happened",
    });
    expect(checkFeedItemVisibility(after, viewer({ decisions: [d] })).visible).toBe(true);
  });

  it("hides everything while a suspension is open", () => {
    const d = decision({ suspensions: [{ from: enquiry.from, to: null }] });
    expect(checkFeedItemVisibility(item(), viewer({ decisions: [d] }))).toEqual({
      visible: false,
      reason: "suspended",
    });
  });

  it.each<[string, Partial<FeedItem>, Partial<FeedViewerContext>, string]>([
    [
      "a care plan update with no section, under a domain-limited decision",
      { kind: "care_plan_update", carePlanDomain: null },
      { decisions: [decision({ sections: ["care_plan"], carePlanDomains: ["mobility"] })] },
      "care_plan_domain_missing",
    ],
    [
      "a care plan update for a section never announced in the feed",
      { kind: "care_plan_update", carePlanDomain: "end_of_life" },
      { decisions: [decision({ sections: ["care_plan"] })] },
      "care_plan_domain_not_for_feed",
    ],
    [
      "a photo attached to an activity without a photos decision",
      { photoDocumentId: "doc-photo" },
      { decisions: [decision({ sections: ["activities_and_visits"] })] },
      "photo_not_shared",
    ],
    [
      "a photo attached to an activity without a photo basis",
      { photoDocumentId: "doc-photo" },
      {
        photoBasis: { ok: false, problem: "consent_refused", message: "Refused." },
      },
      "photo_basis_missing",
    ],
  ])("hides %s", (_label, itemOverrides, context, reason) => {
    expect(checkFeedItemVisibility(item(itemOverrides), viewer(context))).toEqual({
      visible: false,
      reason,
    });
  });

  it("shows a photo attached to an activity when photos are shared and the basis holds", () => {
    expect(checkFeedItemVisibility(item({ photoDocumentId: "doc-photo" }), viewer()).visible).toBe(
      true,
    );
  });
});

describe("photos need their own lawful basis", () => {
  const AT = NOW;
  const consent = (overrides: Partial<ConsentRecordView> = {}): ConsentRecordView => ({
    id: "consent-1",
    decision: "photos",
    outcome: "given",
    givenBy: { kind: "person" },
    capacity: { status: "assumed" },
    givenAt: new Date("2026-09-01T10:00:00Z"),
    expiresAt: null,
    withdrawnAt: null,
    evidence: "Asked at the admission meeting.",
    ...overrides,
  });
  const lacks = (overrides: Partial<CapacityAssessmentView> = {}): CapacityAssessmentView => ({
    id: "mca-photos",
    decisionKind: "photos",
    assessedAt: new Date("2026-09-10T10:00:00Z"),
    outcome: "lacks_capacity",
    reviewOn: "2027-03-01",
    ...overrides,
  });
  const bestInterests = (
    overrides: Partial<PhotoBestInterestsView> = {},
  ): PhotoBestInterestsView => ({
    id: "bi-photos",
    capacityAssessmentId: "mca-photos",
    decidedAt: new Date("2026-09-12T10:00:00Z"),
    sharePhotos: true,
    reviewOn: "2027-03-01",
    ...overrides,
  });
  const attorney: ConsentRecordView["givenBy"] = {
    kind: "representative",
    authority: { kind: "lpa_health_welfare", registered: true, opgReference: "OPG-EXAMPLE-1" },
  };

  it.each<[string, Parameters<typeof feedPhotoBasis>[0], FeedPhotoBasis["ok"], string]>([
    [
      "the person's own consent",
      { consents: [consent()], capacityAssessments: [], bestInterestsDecisions: [], at: AT },
      true,
      "consent",
    ],
    [
      "an attorney's consent when the person lacks capacity to decide",
      {
        consents: [
          consent({
            givenBy: attorney,
            capacity: { status: "lacks_capacity", assessmentId: "mca-photos" },
          }),
        ],
        capacityAssessments: [lacks()],
        bestInterestsDecisions: [],
        at: AT,
      },
      true,
      "consent",
    ],
    [
      "a best-interests decision that follows the assessment",
      {
        consents: [],
        capacityAssessments: [lacks()],
        bestInterestsDecisions: [bestInterests()],
        at: AT,
      },
      true,
      "best_interests",
    ],
    [
      "no consent recorded",
      { consents: [], capacityAssessments: [], bestInterestsDecisions: [], at: AT },
      false,
      "consent_needed",
    ],
    [
      "a refusal",
      {
        consents: [consent({ outcome: "refused" })],
        capacityAssessments: [],
        bestInterestsDecisions: [],
        at: AT,
      },
      false,
      "consent_refused",
    ],
    [
      "a refusal by an attorney, whatever a best-interests decision says",
      {
        consents: [
          consent({
            outcome: "refused",
            givenBy: attorney,
            capacity: { status: "lacks_capacity", assessmentId: "mca-photos" },
          }),
        ],
        capacityAssessments: [lacks()],
        bestInterestsDecisions: [bestInterests()],
        at: AT,
      },
      false,
      "consent_refused",
    ],
    [
      "expired consent",
      {
        consents: [consent({ expiresAt: new Date("2026-10-01T00:00:00Z") })],
        capacityAssessments: [],
        bestInterestsDecisions: [],
        at: AT,
      },
      false,
      "consent_not_valid",
    ],
    [
      "withdrawn consent",
      {
        consents: [consent({ withdrawnAt: new Date("2026-10-01T00:00:00Z") })],
        capacityAssessments: [],
        bestInterestsDecisions: [],
        at: AT,
      },
      false,
      "consent_not_valid",
    ],
    [
      "a lack of capacity with no best-interests decision",
      { consents: [], capacityAssessments: [lacks()], bestInterestsDecisions: [], at: AT },
      false,
      "best_interests_needed",
    ],
    [
      "a best-interests decision about an older assessment",
      {
        consents: [],
        capacityAssessments: [
          lacks({ id: "mca-old", assessedAt: new Date("2026-06-01T10:00:00Z") }),
          lacks(),
        ],
        bestInterestsDecisions: [bestInterests({ capacityAssessmentId: "mca-old" })],
        at: AT,
      },
      false,
      "best_interests_needed",
    ],
    [
      "a best-interests decision not to share",
      {
        consents: [],
        capacityAssessments: [lacks()],
        bestInterestsDecisions: [bestInterests({ sharePhotos: false })],
        at: AT,
      },
      false,
      "best_interests_against_sharing",
    ],
    [
      "a best-interests decision past its review",
      {
        consents: [],
        capacityAssessments: [lacks()],
        bestInterestsDecisions: [bestInterests({ reviewOn: "2026-10-01" })],
        at: AT,
      },
      false,
      "best_interests_review_overdue",
    ],
    [
      "a capacity assessment past its review",
      {
        consents: [],
        capacityAssessments: [lacks({ reviewOn: "2026-10-01" })],
        bestInterestsDecisions: [bestInterests()],
        at: AT,
      },
      false,
      "capacity_review_overdue",
    ],
    [
      "the person's own consent while assessed as lacking capacity",
      {
        consents: [consent({ capacity: { status: "lacks_capacity", assessmentId: "mca-photos" } })],
        capacityAssessments: [lacks()],
        bestInterestsDecisions: [],
        at: AT,
      },
      false,
      "best_interests_needed",
    ],
    [
      "an assessment that found capacity, with no consent",
      {
        consents: [],
        capacityAssessments: [lacks({ outcome: "has_capacity" })],
        bestInterestsDecisions: [bestInterests()],
        at: AT,
      },
      false,
      "consent_needed",
    ],
  ])("hazard HZ-022 photos with %s", (_label, input, ok, outcome) => {
    const result = feedPhotoBasis(input);
    expect(result.ok).toBe(ok);
    if (result.ok) expect(result.basis).toBe(outcome);
    else expect(result.problem).toBe(outcome);
  });

  it("hazard HZ-022 follows the latest best-interests decision about the same assessment", () => {
    const result = feedPhotoBasis({
      consents: [],
      capacityAssessments: [lacks()],
      bestInterestsDecisions: [
        bestInterests({
          id: "bi-later",
          decidedAt: new Date("2026-10-01T10:00:00Z"),
          sharePhotos: false,
        }),
        bestInterests(),
      ],
      at: AT,
    });
    expect(result).toMatchObject({ ok: false, problem: "best_interests_against_sharing" });
  });

  it("explains each missing basis in words staff can act on", () => {
    const result = feedPhotoBasis({
      consents: [],
      capacityAssessments: [lacks()],
      bestInterestsDecisions: [],
      at: AT,
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.message).toContain("best-interests decision");
  });
});

describe("the feed a family member sees (HZ-022, HZ-061)", () => {
  const items: FeedItem[] = [
    item({
      id: "older",
      occurredAt: new Date("2026-10-09T10:00:00Z"),
      composedAt: new Date("2026-10-09T10:05:00Z"),
    }),
    item({
      id: "late-night",
      kind: "shared_note",
      text: "Ada watched a film with friends.",
      // 23:30 on 10 October in London (BST), written at 00:30 on 11 October.
      occurredAt: new Date("2026-10-10T22:30:00Z"),
      composedAt: new Date("2026-10-10T23:30:00Z"),
    }),
    item({ id: "hidden", kind: "appointment", occurredAt: new Date("2026-10-11T09:00:00Z") }),
    item({
      id: "taken-down",
      occurredAt: new Date("2026-10-10T12:00:00Z"),
      text: "Wrong update.",
      composedAt: new Date("2026-10-10T12:05:00Z"),
      withdrawnAt: new Date("2026-10-10T13:00:00Z"),
      withdrawnReason: "published_in_error",
    }),
    item({
      id: "corrected",
      occurredAt: new Date("2026-10-10T12:00:00Z"),
      composedAt: new Date("2026-10-10T13:05:00Z"),
      supersedesItemId: "taken-down",
    }),
  ];

  it("hazard HZ-061 lists open items newest first with when they happened and when they were added", () => {
    const feed = buildFamilyFeed(items, viewer(), new Set(["taken-down"]));
    expect(feed.state).toBe("showing");
    expect(feed.statement).toBe(FEED_NOT_FULL_RECORD_STATEMENT);
    expect(feed.entries.map((e) => e.itemId)).toEqual([
      "late-night",
      "corrected",
      "taken-down",
      "older",
    ]);
    expect(feed.lastUpdateAt).toEqual(new Date("2026-10-10T22:30:00Z"));
    const [late, corrected, notice] = feed.entries;
    expect(late).toMatchObject({
      happened: "10/10/2026 23:30",
      addedLater: "11/10/2026 00:30",
      decisionId: "d1",
    });
    expect(corrected).toMatchObject({ corrects: "taken-down", addedLater: null });
    expect(notice).toMatchObject({
      display: "withdrawn_notice",
      text: FEED_WITHDRAWN_NOTICE,
      corrects: null,
    });
  });

  it.each<PersonStatus>(["deceased", "discharged", "archived"])(
    "hazard HZ-061 pauses the feed with a neutral statement when the person is %s, never an empty feed",
    (status) => {
      const feed = buildFamilyFeed(items, viewer({ person: { id: ADA, status } }), new Set());
      expect(feed).toEqual({
        state: "paused",
        statement: FEED_PAUSED_STATEMENT,
        lastUpdateAt: null,
        entries: [],
      });
    },
  );

  it("hazard HZ-022 does not pause the feed for someone who never had a decision", () => {
    const feed = buildFamilyFeed(
      items,
      viewer({ person: { id: ADA, status: "deceased" }, decisions: [] }),
    );
    expect(feed).toMatchObject({ state: "showing", entries: [] });
  });

  it("keeps the paused statement plain and free of clinical words", () => {
    expect(FEED_PAUSED_STATEMENT).toBe("Updates are paused. The home will be in touch.");
  });

  it("decides for every care plan section whether its updates may be announced", () => {
    expect(FEED_CARE_PLAN_DOMAINS.end_of_life).toBe("never_in_feed");
    expect(FEED_CARE_PLAN_DOMAINS.medicines).toBe("never_in_feed");
    expect(FEED_CARE_PLAN_DOMAINS.mobility).toBe("may_appear");
  });

  it("leaves out a withdrawn update the viewer never saw", () => {
    const feed = buildFamilyFeed(items, viewer());
    expect(feed.entries.map((e) => e.itemId)).not.toContain("taken-down");
  });

  it("hazard HZ-022 is empty with no decision, and says there is no update yet", () => {
    const feed = buildFamilyFeed(items, viewer({ decisions: [] }));
    expect(feed).toEqual({
      state: "showing",
      statement: FEED_NOT_FULL_RECORD_STATEMENT,
      lastUpdateAt: null,
      entries: [],
    });
  });

  it("hazard HZ-061 does not count a withdrawn notice as the last update", () => {
    const onlyNotice = buildFamilyFeed([items[3] as FeedItem], viewer(), new Set(["taken-down"]));
    expect(onlyNotice.entries).toHaveLength(1);
    expect(onlyNotice.lastUpdateAt).toBeNull();
  });

  it("hides a photo's document when it shows the withdrawn notice", () => {
    const photo = item({
      id: "photo",
      kind: "photo",
      photoDocumentId: "doc-photo",
      withdrawnAt: new Date("2026-10-10T15:00:00Z"),
      withdrawnReason: "photo_consent_withdrawn",
    });
    const [entry] = buildFamilyFeed([photo], viewer(), new Set(["photo"])).entries;
    expect(entry).toMatchObject({ display: "withdrawn_notice", photoDocumentId: null });
  });

  it("orders updates that happened together by when they were written, then by id", () => {
    const at = new Date("2026-10-10T10:00:00Z");
    const feed = buildFamilyFeed(
      [
        item({ id: "b", occurredAt: at, composedAt: at }),
        item({ id: "a", occurredAt: at, composedAt: at }),
        item({ id: "c", occurredAt: at, composedAt: new Date("2026-10-10T11:00:00Z") }),
      ],
      viewer(),
    );
    expect(feed.entries.map((e) => e.itemId)).toEqual(["c", "a", "b"]);
  });
});

describe("what was seen cannot be unseen (exposure history)", () => {
  const withdrawnAt = new Date("2026-10-10T12:00:00Z");
  const closed = decision({ withdrawnAt });
  const view = (overrides: Partial<FeedViewRecord> = {}): FeedViewRecord => ({
    itemId: "item-1",
    personId: ADA,
    contactId: BEN,
    decisionId: "d1",
    section: "activities_and_visits",
    carePlanDomain: null,
    personStatus: "active",
    capacityForSharing: "presumed",
    viewedAt: new Date("2026-10-09T09:00:00Z"),
    ...overrides,
  });

  it("lists what was seen before the withdrawal, with the first time each was seen", () => {
    const exposure = feedExposure(closed, [
      view({ viewedAt: new Date("2026-10-09T18:00:00Z") }),
      view(),
      view({ itemId: "item-2", viewedAt: new Date("2026-10-10T08:00:00Z") }),
      view({ itemId: "item-3", decisionId: "other" }),
    ]);
    expect(exposure).toEqual({
      seen: [
        { itemId: "item-1", firstSeenAt: new Date("2026-10-09T09:00:00Z") },
        { itemId: "item-2", firstSeenAt: new Date("2026-10-10T08:00:00Z") },
      ],
      seenAfterClosing: [],
    });
  });

  it("hazard HZ-022 flags views after the decision closed for the breach register", () => {
    const late = view({ viewedAt: new Date("2026-10-10T13:00:00Z") });
    const afterDeath = view({ itemId: "item-4", personStatus: "deceased" });
    expect(feedExposure(closed, [late, afterDeath]).seenAfterClosing).toEqual([afterDeath, late]);
  });
});
