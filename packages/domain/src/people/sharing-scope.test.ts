import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { resolveRate } from "../platform/rates";
import type { PersonStatus } from "./lifecycle";
import {
  type CapacityForSharing,
  checkAboutMeShareLink,
  checkSectionVisibility,
  checkSharingDecision,
  decisionInForceAt,
  isSharingSuspendedAt,
  type SharingAuthority,
  type SharingDecision,
  type SharingRecipient,
  type SharingSection,
} from "./sharing";

/**
 * Sharing scope rules added with the family feed review (people.md rule 13; HZ-022): appointees
 * cover benefits only, deputies act within the sections their order covers, a decision that needs a
 * lack of capacity follows the current finding, and suspensions are periods. Invented people: Ada
 * Example and her son Ben.
 */

const ADA = "person-ada";
const NOW = new Date("2026-10-11T10:00:00Z");
const FROM = new Date("2026-10-01T00:00:00Z");
const TO = new Date("2027-04-01T00:00:00Z");
const BEN: SharingRecipient = { kind: "family", contactId: "contact-ben" };
const LINK: SharingRecipient = { kind: "link", linkId: "link-1" };
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

function authority(
  role: SharingAuthority["role"],
  orderSections: readonly SharingSection[] | null = null,
): SharingAuthority {
  return {
    role,
    contactId: "contact-ben",
    reference: "COP-EXAMPLE-1",
    evidenceDocumentId: "doc-order",
    validUntil: null,
    orderSections,
  };
}

describe("hazard HZ-022 authorities cover only what the law gives them", () => {
  const ok = { personStatus: "active" as PersonStatus, now: NOW, maxMonths: MAX_MONTHS };
  const byAuthority = (overrides: Partial<SharingDecision>) =>
    decision({ basis: "legal_authority", consentGivenBy: null, ...overrides });

  it.each<[string, Partial<SharingDecision>, readonly string[]]>([
    [
      "an appointee for benefits",
      { sections: ["benefits"], authority: authority("appointee") },
      [],
    ],
    [
      "an appointee for finance statements",
      { sections: ["finance"], authority: authority("appointee") },
      ["authority_does_not_cover_section"],
    ],
    [
      "a finance attorney for benefits and finance",
      { sections: ["finance", "benefits"], authority: authority("lpa_property_finance") },
      [],
    ],
    [
      "a welfare deputy within the order",
      {
        sections: ["daily_updates"],
        capacity: "assessed_lacks_capacity",
        authority: authority("deputy_personal_welfare", ["daily_updates", "care_plan"]),
      },
      [],
    ],
    [
      "a welfare deputy outside the order",
      {
        sections: ["photos"],
        capacity: "assessed_lacks_capacity",
        authority: authority("deputy_personal_welfare", ["daily_updates"]),
      },
      ["authority_does_not_cover_section"],
    ],
    [
      "a deputy with no order sections recorded",
      { sections: ["finance"], authority: authority("deputy_property_affairs") },
      ["authority_does_not_cover_section", "deputy_order_scope_required"],
    ],
    [
      "a property and affairs deputy within the order",
      { sections: ["finance"], authority: authority("deputy_property_affairs", ["finance"]) },
      [],
    ],
    [
      "a suspension that ends before it starts",
      { basis: "consent", consentGivenBy: "person", suspensions: [{ from: NOW, to: FROM }] },
      ["suspension_ends_before_start"],
    ],
  ])("checks %s", (_label, overrides, problems) => {
    const result = checkSharingDecision(byAuthority(overrides), ok);
    expect(result.ok ? [] : [...result.problems].sort()).toEqual([...problems].sort());
  });

  it("hides finance statements from an appointee whose stored decision names finance", () => {
    const stored = byAuthority({ sections: ["finance"], authority: authority("appointee") });
    expect(
      checkSectionVisibility([stored], {
        personId: ADA,
        personStatus: "active",
        recipient: BEN,
        section: "finance",
        now: NOW,
      }),
    ).toEqual({ visible: false, reason: "decision_invalid" });
  });
});

describe("hazard HZ-022 a decision that needs a lack of capacity follows the current finding", () => {
  const welfare = decision({
    basis: "legal_authority",
    consentGivenBy: null,
    capacity: "assessed_lacks_capacity",
    authority: { ...authority("lpa_health_welfare"), reference: "OPG-EXAMPLE-1" },
  });
  const bestInterests = decision({
    basis: "best_interests",
    consentGivenBy: null,
    capacity: "assessed_lacks_capacity",
    bestInterestsDecisionId: "bi-1",
  });
  const request = (capacityNow?: CapacityForSharing) => ({
    personId: ADA,
    personStatus: "active" as PersonStatus,
    recipient: BEN,
    section: "photos" as const,
    now: NOW,
    ...(capacityNow ? { capacityNow } : {}),
  });

  it.each<[string, SharingDecision, CapacityForSharing | undefined, boolean]>([
    [
      "a welfare attorney while the person lacks capacity",
      welfare,
      "assessed_lacks_capacity",
      true,
    ],
    ["a welfare attorney once the person has capacity", welfare, "assessed_has_capacity", false],
    ["a welfare attorney with no current finding (presumed)", welfare, undefined, false],
    [
      "best interests while the person lacks capacity",
      bestInterests,
      "assessed_lacks_capacity",
      true,
    ],
    ["best interests once capacity is presumed", bestInterests, "presumed", false],
    ["the person's own consent, whatever the finding", decision(), undefined, true],
  ])("%s: visible %s", (_label, d, capacityNow, visible) => {
    const result = checkSectionVisibility([d], request(capacityNow));
    expect(result.visible).toBe(visible);
    if (!result.visible) expect(result.reason).toBe("capacity_regained");
  });

  it("closes an About Me link an attorney agreed to once the person has capacity", () => {
    const viaAttorney = decision({
      ...welfare,
      recipient: LINK,
      sections: ["about_me"],
      basis: "consent",
      consentGivenBy: "authority_holder",
    });
    const check = (capacityNow?: CapacityForSharing) =>
      checkAboutMeShareLink(viaAttorney, {
        personStatus: "active",
        linkExpiresAt: new Date("2026-10-18T10:00:00Z"),
        now: NOW,
        ...(capacityNow ? { capacityNow } : {}),
      });
    expect(check("assessed_lacks_capacity")).toEqual({ ok: true });
    expect(check("assessed_has_capacity")).toEqual({
      ok: false,
      problems: ["decision_not_in_force"],
    });
  });
});

describe("hazard HZ-022 suspensions are periods", () => {
  const enquiry = { from: new Date("2026-10-05T00:00:00Z"), to: new Date("2026-10-09T00:00:00Z") };
  const request = (now: Date) => ({
    personId: ADA,
    personStatus: "active" as PersonStatus,
    recipient: BEN,
    section: "photos" as const,
    now,
  });

  it("closes the section during a safeguarding suspension and reopens it when it ends", () => {
    const d = decision({ suspensions: [enquiry] });
    expect(checkSectionVisibility([d], request(new Date("2026-10-06T00:00:00Z")))).toEqual({
      visible: false,
      reason: "suspended",
    });
    expect(checkSectionVisibility([d], request(NOW)).visible).toBe(true);
  });

  it("keeps an open-ended suspension closed", () => {
    const d = decision({ suspensions: [{ from: enquiry.from, to: null }] });
    expect(checkSectionVisibility([d], request(NOW))).toEqual({
      visible: false,
      reason: "suspended",
    });
    expect(isSharingSuspendedAt(d, NOW)).toBe(true);
  });

  it.each<[string, Partial<SharingDecision>, string, string]>([
    ["in force", { suspensions: [enquiry] }, "2026-10-10T00:00:00Z", "in_force"],
    ["suspended at the time", { suspensions: [enquiry] }, "2026-10-06T00:00:00Z", "suspended"],
    ["not started", {}, "2026-09-30T00:00:00Z", "not_yet_valid"],
    [
      "withdrawn by then",
      { withdrawnAt: new Date("2026-10-03T00:00:00Z") },
      "2026-10-04T00:00:00Z",
      "withdrawn",
    ],
    [
      "expired by then",
      { validTo: new Date("2026-10-03T00:00:00Z") },
      "2026-10-04T00:00:00Z",
      "expired",
    ],
    [
      "suspended by the single open-ended field",
      { suspendedAt: new Date("2026-10-03T00:00:00Z") },
      "2026-10-04T00:00:00Z",
      "suspended",
    ],
  ])("says whether the decision was in force at a time: %s", (_label, overrides, at, state) => {
    expect(decisionInForceAt(decision(overrides), new Date(at))).toBe(state);
  });
});
