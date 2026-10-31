import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { resolveRate } from "../platform/rates";
import { addUkMonths } from "../shared/time";
import type { PersonStatus } from "./lifecycle";
import {
  checkAboutMeShareLink,
  checkSectionVisibility,
  checkSharingDecision,
  type SectionVisibilityRequest,
  type SharingDecision,
  type SharingRecipient,
  visibleSharingSections,
} from "./sharing";

const ADA = "person-ada";
const NOW = new Date("2026-10-11T10:00:00Z");
const FROM = new Date("2026-10-01T00:00:00Z");
const TO = new Date("2027-04-01T00:00:00Z");
const BEN: SharingRecipient = { kind: "family", contactId: "contact-ben" };
const GP: SharingRecipient = { kind: "professional", tenantUserId: "user-gp" };
const LINK: SharingRecipient = { kind: "link", linkId: "link-1" };
/** `sharing.decision_max_months` from the rate table (H-38), never a literal. */
const MAX_MONTHS = Number(
  resolveRate(readRateTable(), "sharing.decision_max_months", "england", "2026-10-11", null).value,
);

function decision(overrides: Partial<SharingDecision> = {}): SharingDecision {
  return {
    id: "d1",
    personId: ADA,
    recipient: BEN,
    sections: ["daily_updates", "photos"],
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

const lpaHealth = {
  role: "lpa_health_welfare" as const,
  contactId: "contact-ben",
  reference: "OPG-EXAMPLE-1",
  evidenceDocumentId: "doc-lpa",
  validUntil: null,
};

describe("recording a sharing decision", () => {
  const ok: { personStatus: PersonStatus; now: Date; maxMonths: number } = {
    personStatus: "active",
    now: NOW,
    maxMonths: MAX_MONTHS,
  };

  it.each<[string, Partial<SharingDecision>]>([
    ["the person's consent for updates and photos", {}],
    [
      "a health and welfare attorney for the care plan when the person lacks capacity",
      {
        basis: "legal_authority",
        sections: ["care_plan", "health_summary"],
        capacity: "assessed_lacks_capacity",
        authority: lpaHealth,
      },
    ],
    [
      "a property and finance attorney for invoices while the person has capacity",
      {
        basis: "legal_authority",
        sections: ["finance"],
        authority: { ...lpaHealth, role: "lpa_property_finance" },
      },
    ],
    [
      "consent by an attorney to share photos with a grandchild",
      {
        recipient: { kind: "family", contactId: "contact-cara" },
        consentGivenBy: "authority_holder",
        capacity: "assessed_lacks_capacity",
        authority: lpaHealth,
      },
    ],
    [
      "a best-interests decision",
      {
        basis: "best_interests",
        capacity: "assessed_lacks_capacity",
        bestInterestsDecisionId: "bi-1",
        consentGivenBy: null,
      },
    ],
    [
      "direct care for the GP",
      {
        recipient: GP,
        basis: "direct_care",
        sections: ["health_summary", "medicines"],
        consentGivenBy: null,
      },
    ],
    ["an About Me link with consent", { recipient: LINK, sections: ["about_me"] }],
    [
      "selected care plan domains",
      { sections: ["care_plan"], carePlanDomains: ["eating_and_drinking"] },
    ],
    [
      "a decision ending exactly at the longest it may last",
      { validTo: addUkMonths(FROM, MAX_MONTHS) },
    ],
    [
      "an attorney's decision ending at the end of the authority's last day",
      {
        basis: "legal_authority",
        sections: ["care_plan"],
        capacity: "assessed_lacks_capacity",
        authority: { ...lpaHealth, validUntil: "2027-01-31" },
        // 1 February 2027 00:00 in the UK (GMT).
        validTo: new Date("2027-02-01T00:00:00Z"),
      },
    ],
  ])("accepts %s", (_label, overrides) => {
    expect(checkSharingDecision(decision(overrides), ok)).toEqual({ ok: true });
  });

  it.each<[string, Partial<SharingDecision>, Partial<typeof ok>, readonly string[]]>([
    ["no sections", { sections: [] }, {}, ["no_sections"]],
    ["an unknown section", { sections: ["diary"] }, {}, ["unknown_section"]],
    ["a repeated section", { sections: ["photos", "photos"] }, {}, ["duplicate_section"]],
    [
      "care plan domains without the care plan",
      { carePlanDomains: ["mobility"] },
      {},
      ["care_plan_domains_without_care_plan"],
    ],
    [
      "an expiry before the start",
      { validTo: FROM },
      {},
      ["expiry_before_start", "expiry_in_past"],
    ],
    [
      "an expiry already passed",
      { validTo: new Date("2026-10-05T00:00:00Z") },
      {},
      ["expiry_in_past"],
    ],
    ["a person who has left", {}, { personStatus: "discharged" }, ["person_record_not_live"]],
    [
      "consent with no one named as giving it",
      { consentGivenBy: null },
      {},
      ["consent_giver_required"],
    ],
    [
      "consent from a person assessed as lacking capacity",
      { capacity: "assessed_lacks_capacity" },
      {},
      ["person_lacks_capacity"],
    ],
    [
      "an authority with no evidence",
      {
        basis: "legal_authority",
        capacity: "assessed_lacks_capacity",
        authority: { ...lpaHealth, reference: null, evidenceDocumentId: null },
      },
      {},
      ["authority_evidence_required"],
    ],
    [
      "an authority basis with no authority",
      { basis: "legal_authority" },
      {},
      ["authority_required"],
    ],
    [
      "a finance attorney for the care plan",
      {
        basis: "legal_authority",
        sections: ["care_plan"],
        authority: { ...lpaHealth, role: "lpa_property_finance" },
      },
      {},
      ["authority_does_not_cover_section"],
    ],
    [
      "a welfare attorney for finance",
      {
        basis: "legal_authority",
        sections: ["finance"],
        capacity: "assessed_lacks_capacity",
        authority: lpaHealth,
      },
      {},
      ["authority_does_not_cover_section"],
    ],
    [
      "a welfare attorney while the person has capacity",
      { basis: "legal_authority", authority: lpaHealth },
      {},
      ["authority_needs_lack_of_capacity"],
    ],
    [
      "an authority held by someone else",
      {
        basis: "legal_authority",
        capacity: "assessed_lacks_capacity",
        authority: { ...lpaHealth, contactId: "contact-cara" },
      },
      {},
      ["authority_not_recipient"],
    ],
    [
      "an expired authority",
      {
        basis: "legal_authority",
        capacity: "assessed_lacks_capacity",
        authority: { ...lpaHealth, validUntil: "2026-10-10" },
      },
      {},
      ["authority_expired"],
    ],
    [
      "best interests without the decision",
      { basis: "best_interests", capacity: "assessed_lacks_capacity" },
      {},
      ["best_interests_decision_required"],
    ],
    [
      "best interests for a person with capacity",
      { basis: "best_interests", bestInterestsDecisionId: "bi-1" },
      {},
      ["best_interests_needs_lack_of_capacity"],
    ],
    [
      "direct care for a family member",
      { basis: "direct_care", sections: ["health_summary"] },
      {},
      ["direct_care_professionals_only"],
    ],
    [
      "direct care for finance or photos",
      { recipient: GP, basis: "direct_care", sections: ["finance", "photos"] },
      {},
      ["direct_care_section_not_clinical"],
    ],
    [
      "a link to more than About Me",
      { recipient: LINK, sections: ["about_me", "photos"] },
      {},
      ["link_only_about_me"],
    ],
    [
      "a decision lasting longer than the rate table allows (H-38)",
      { validTo: new Date(addUkMonths(FROM, MAX_MONTHS).getTime() + 60_000) },
      {},
      ["expiry_beyond_maximum"],
    ],
    [
      "a decision outlasting the attorney's authority it rests on (H-38)",
      {
        basis: "legal_authority",
        sections: ["care_plan"],
        capacity: "assessed_lacks_capacity",
        authority: { ...lpaHealth, validUntil: "2027-01-31" },
        validTo: new Date("2027-02-01T00:01:00Z"),
      },
      {},
      ["expiry_beyond_authority"],
    ],
    [
      "consent by an attorney outlasting their authority",
      {
        recipient: { kind: "family", contactId: "contact-cara" },
        consentGivenBy: "authority_holder",
        capacity: "assessed_lacks_capacity",
        authority: { ...lpaHealth, validUntil: "2026-12-31" },
      },
      {},
      ["expiry_beyond_authority"],
    ],
    [
      "a link under direct care",
      { recipient: LINK, sections: ["about_me"], basis: "direct_care" },
      {},
      ["direct_care_professionals_only", "link_not_direct_care"],
    ],
  ])("refuses %s", (_label, overrides, context, problems) => {
    const result = checkSharingDecision(decision(overrides), { ...ok, ...context });
    expect(result.ok).toBe(false);
    if (!result.ok) expect([...result.problems].sort()).toEqual([...problems].sort());
  });
});

describe("hazard HZ-022 a section is visible only under a sharing decision in force", () => {
  function request(overrides: Partial<SectionVisibilityRequest> = {}): SectionVisibilityRequest {
    return {
      personId: ADA,
      personStatus: "active",
      recipient: BEN,
      section: "photos",
      now: NOW,
      ...overrides,
    };
  }

  it("shows a covered section under a decision in force", () => {
    expect(checkSectionVisibility([decision()], request())).toEqual({
      visible: true,
      decisionId: "d1",
      expiresAt: TO,
    });
  });

  it("names the decision that runs longest when two are in force", () => {
    const later = new Date("2027-09-01T00:00:00Z");
    expect(
      checkSectionVisibility([decision(), decision({ id: "d2", validTo: later })], request()),
    ).toEqual({ visible: true, decisionId: "d2", expiresAt: later });
  });

  it("hazard HZ-022 never applies a professional's decision to a family member with the same id", () => {
    const sameId = decision({
      recipient: { kind: "professional", tenantUserId: "contact-ben" },
      basis: "direct_care",
      sections: ["health_summary"],
      consentGivenBy: null,
    });
    expect(checkSectionVisibility([sameId], request({ section: "health_summary" }))).toEqual({
      visible: false,
      reason: "no_decision",
    });
  });

  it.each<[string, readonly SharingDecision[], Partial<SectionVisibilityRequest>, string]>([
    ["hazard HZ-022 no decision at all", [], {}, "no_decision"],
    [
      "hazard HZ-022 a section the decision does not name",
      [decision()],
      { section: "care_plan" },
      "section_not_covered",
    ],
    [
      "hazard HZ-022 a decision for someone else",
      [decision({ recipient: { kind: "family", contactId: "contact-cara" } })],
      {},
      "no_decision",
    ],
    [
      "hazard HZ-022 a decision about another person",
      [decision({ personId: "person-dev" })],
      {},
      "no_decision",
    ],
    [
      "hazard HZ-022 an expired decision",
      [decision({ validTo: new Date("2026-10-11T09:59:00Z") })],
      {},
      "expired",
    ],
    [
      "hazard HZ-022 a decision not yet started",
      [decision({ validFrom: new Date("2026-10-12T00:00:00Z") })],
      {},
      "not_yet_valid",
    ],
    [
      "hazard HZ-022 withdrawn consent",
      [decision({ withdrawnAt: new Date("2026-10-10T00:00:00Z") })],
      {},
      "withdrawn",
    ],
    [
      "hazard HZ-022 a suspended decision (safeguarding)",
      [decision({ suspendedAt: new Date("2026-10-10T00:00:00Z") })],
      {},
      "suspended",
    ],
    [
      "hazard HZ-022 an attorney whose authority has lapsed",
      [
        decision({
          basis: "legal_authority",
          capacity: "assessed_lacks_capacity",
          authority: { ...lpaHealth, validUntil: "2026-10-01" },
        }),
      ],
      {},
      "authority_lapsed",
    ],
    [
      "hazard HZ-022 a stored decision that breaks the rules",
      [decision({ basis: "direct_care" })],
      {},
      "decision_invalid",
    ],
    [
      "hazard HZ-022 a person who has died",
      [decision()],
      { personStatus: "deceased" },
      "person_record_closed",
    ],
    [
      "hazard HZ-022 a person who has left",
      [decision()],
      { personStatus: "discharged" },
      "person_record_closed",
    ],
  ])("hides the section for %s", (_label, decisions, overrides, reason) => {
    expect(checkSectionVisibility(decisions, request(overrides))).toEqual({
      visible: false,
      reason,
    });
  });

  it("shows a future decision's section once it starts and hides it once it expires", () => {
    const future = decision({ validFrom: new Date("2026-10-12T00:00:00Z") });
    expect(
      checkSectionVisibility([future], request({ now: new Date("2026-10-12T00:00:00Z") })).visible,
    ).toBe(true);
    expect(checkSectionVisibility([future], request({ now: TO })).visible).toBe(false);
  });

  it("uses the decision in force when another has been withdrawn", () => {
    const withdrawn = decision({ id: "old", withdrawnAt: FROM });
    const current = decision({ id: "new" });
    expect(checkSectionVisibility([withdrawn, current], request())).toMatchObject({
      visible: true,
      decisionId: "new",
    });
  });

  it("reports the most serious reason when several decisions are not in force", () => {
    const expired = decision({ id: "a", validTo: new Date("2026-10-05T00:00:00Z") });
    const withdrawn = decision({ id: "b", withdrawnAt: FROM });
    expect(checkSectionVisibility([expired, withdrawn], request())).toEqual({
      visible: false,
      reason: "withdrawn",
    });
  });

  it("limits the care plan to the domains shared", () => {
    const domains = decision({ sections: ["care_plan"], carePlanDomains: ["eating_and_drinking"] });
    expect(
      checkSectionVisibility(
        [domains],
        request({ section: "care_plan", carePlanDomain: "eating_and_drinking" }),
      ).visible,
    ).toBe(true);
    expect(
      checkSectionVisibility(
        [domains],
        request({ section: "care_plan", carePlanDomain: "mobility" }),
      ),
    ).toEqual({
      visible: false,
      reason: "section_not_covered",
    });
    const all = decision({ sections: ["care_plan"] });
    expect(
      checkSectionVisibility([all], request({ section: "care_plan", carePlanDomain: "mobility" }))
        .visible,
    ).toBe(true);
  });

  it("matches professionals and links by their own ids", () => {
    const gp = decision({
      recipient: GP,
      basis: "direct_care",
      sections: ["medicines"],
      consentGivenBy: null,
    });
    expect(
      checkSectionVisibility([gp], request({ recipient: GP, section: "medicines" })).visible,
    ).toBe(true);
    expect(
      checkSectionVisibility(
        [gp],
        request({
          recipient: { kind: "professional", tenantUserId: "user-dn" },
          section: "medicines",
        }),
      ).visible,
    ).toBe(false);
    const link = decision({ recipient: LINK, sections: ["about_me"] });
    expect(
      checkSectionVisibility([link], request({ recipient: LINK, section: "about_me" })).visible,
    ).toBe(true);
    expect(
      checkSectionVisibility(
        [link],
        request({ recipient: { kind: "link", linkId: "link-2" }, section: "about_me" }),
      ).visible,
    ).toBe(false);
  });

  it("lists only the open sections for the family feed", () => {
    expect(
      visibleSharingSections([decision()], {
        personId: ADA,
        personStatus: "active",
        recipient: BEN,
        now: NOW,
      }),
    ).toEqual(["daily_updates", "photos"]);
    expect(
      visibleSharingSections([], {
        personId: ADA,
        personStatus: "active",
        recipient: BEN,
        now: NOW,
      }),
    ).toEqual([]);
  });
});

describe("About Me share links", () => {
  const link = decision({ recipient: LINK, sections: ["about_me"] });
  const at = (iso: string) => new Date(iso);

  it("issues a link that expires before the decision does", () => {
    expect(
      checkAboutMeShareLink(link, {
        personStatus: "in_hospital",
        linkExpiresAt: at("2026-10-18T10:00:00Z"),
        now: NOW,
      }),
    ).toEqual({ ok: true });
  });

  it.each<[string, SharingDecision, string, string, readonly string[]]>([
    [
      "a decision for a family member",
      decision({ sections: ["about_me"] }),
      "active",
      "2026-10-18T10:00:00Z",
      ["not_a_link_decision"],
    ],
    [
      "a link decision without About Me (itself invalid)",
      decision({ recipient: LINK, sections: ["photos"] }),
      "active",
      "2026-10-18T10:00:00Z",
      ["about_me_not_covered", "decision_not_in_force"],
    ],
    [
      "a withdrawn decision",
      decision({ recipient: LINK, sections: ["about_me"], withdrawnAt: FROM }),
      "active",
      "2026-10-18T10:00:00Z",
      ["decision_not_in_force"],
    ],
    ["a person who has died", link, "deceased", "2026-10-18T10:00:00Z", ["decision_not_in_force"]],
    ["an expiry in the past", link, "active", "2026-10-11T09:00:00Z", ["link_expiry_in_past"]],
    [
      "a link outliving the decision",
      link,
      "active",
      "2027-05-01T00:00:00Z",
      ["link_outlives_decision"],
    ],
  ])("refuses %s", (_label, d, personStatus, expires, problems) => {
    expect(
      checkAboutMeShareLink(d, {
        personStatus: personStatus as never,
        linkExpiresAt: at(expires),
        now: NOW,
      }),
    ).toEqual({
      ok: false,
      problems,
    });
  });
});

describe("hazard HZ-022 every sharing decision is renewed within the rate table's maximum (H-38)", () => {
  const base = { personStatus: "active" as PersonStatus, now: NOW };

  it("ignores an authority's end date when the decision does not rest on it", () => {
    const ownConsent = decision({ authority: { ...lpaHealth, validUntil: "2026-12-31" } });
    expect(checkSharingDecision(ownConsent, { ...base, maxMonths: MAX_MONTHS })).toEqual({
      ok: true,
    });
  });

  it("counts the months on the UK wall clock across a change of the clocks", () => {
    // 10:00 BST on 15 June 2026; the same wall-clock time six months on is 10:00 GMT.
    const from = new Date("2026-06-15T09:00:00Z");
    const atLimit = decision({ validFrom: from, validTo: addUkMonths(from, 6) });
    expect(atLimit.validTo.toISOString()).toBe("2026-12-15T10:00:00.000Z");
    expect(checkSharingDecision(atLimit, { ...base, maxMonths: 6 })).toEqual({ ok: true });
    const later = decision({ validFrom: from, validTo: new Date("2026-12-15T10:00:01Z") });
    expect(checkSharingDecision(later, { ...base, maxMonths: 6 })).toEqual({
      ok: false,
      problems: ["expiry_beyond_maximum"],
    });
  });

  it.each([0, -1, 1.5, Number.NaN])(
    "refuses a maximum of %s months as a misconfigured table",
    (m) => {
      expect(() => checkSharingDecision(decision(), { ...base, maxMonths: m })).toThrow(RangeError);
    },
  );
});
