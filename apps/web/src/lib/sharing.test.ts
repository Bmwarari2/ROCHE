import type {
  AboutMeOut,
  AboutMeShareLinkOut,
  ContactOut,
  SharingDecisionOut,
} from "@harbour/contracts";
import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  aboutMeMediaCount,
  aboutMeText,
  authorityRolesFor,
  decisionActions,
  decisionLastDay,
  decisionStatus,
  linkDecisions,
  linkExpiry,
  linkStatus,
  orderDecisions,
  readAboutMeForm,
  readSharingForm,
  recipientLabel,
} from "./sharing";

const t = createTranslator("en-GB");
const NOW = new Date("2026-10-31T12:00:00Z");
const PERSON = "0194d000-0000-7000-8600-000000000006";
const CONTACT = "0194d000-0000-7000-8700-000000000001";

function decision(overrides: Partial<SharingDecisionOut> = {}): SharingDecisionOut {
  return {
    id: "0194d000-0000-7000-8800-000000000001",
    personId: PERSON,
    recipient: { kind: "family", contactId: CONTACT },
    sections: ["activities_and_visits"],
    carePlanDomains: null,
    basis: "consent",
    consentGivenBy: "person",
    capacity: "presumed",
    capacityAssessmentId: null,
    bestInterestsDecisionId: null,
    authority: null,
    validFrom: "2026-10-01T09:00:00.000Z",
    validTo: "2027-01-01T00:00:00.000Z",
    withdrawnAt: null,
    withdrawnReason: null,
    suspendedAt: null,
    suspendedReason: null,
    suspensions: [],
    inForce: true,
    recordedBy: null,
    version: 1,
    ...overrides,
  };
}

function about(overrides: Partial<AboutMeOut> = {}): AboutMeOut {
  return {
    personId: PERSON,
    sections: {},
    authoredByPerson: false,
    summary: { filled: [], missing: [], dateLastUpdated: null, hasContent: false },
    updatedAt: null,
    version: 0,
    ...overrides,
  };
}

/** A form as posted: single values, and lists for the checkboxes. */
function form(values: Record<string, string | readonly string[]>) {
  return {
    get: (name: string) => {
      const value = values[name];
      return typeof value === "string" ? value : (value?.[0] ?? null);
    },
    getAll: (name: string) => {
      const value = values[name];
      return value === undefined ? [] : typeof value === "string" ? [value] : [...value];
    },
  };
}

describe("sharing decisions on the web (PEOP-013, HZ-022)", () => {
  it.each([
    [{}, "in_force"],
    [{ withdrawnAt: "2026-10-30T09:00:00.000Z", inForce: false }, "withdrawn"],
    [{ suspendedAt: "2026-10-30T09:00:00.000Z", inForce: false }, "suspended"],
    [{ validTo: "2026-10-30T00:00:00.000Z", inForce: false }, "expired"],
    [{ validFrom: "2026-11-02T00:00:00.000Z", inForce: false }, "not_started"],
    // Closed for a reason its dates do not show (the person left, an authority lapsed, capacity
    // regained): never read as in force.
    [{ inForce: false }, "not_in_force"],
  ] as const)("reads %j as %s", (overrides, status) => {
    expect(decisionStatus(decision(overrides), NOW)).toBe(status);
  });

  it("orders decisions in force first and offers only what each can still have done", () => {
    const withdrawn = decision({ id: "w", withdrawnAt: "2026-10-30T09:00:00.000Z" });
    const suspended = decision({ id: "s", suspendedAt: "2026-10-30T09:00:00.000Z" });
    const live = decision({ id: "l" });
    expect(orderDecisions([withdrawn, suspended, live], NOW).map((d) => d.id)).toEqual([
      "l",
      "s",
      "w",
    ]);
    expect(decisionActions(live, NOW)).toEqual(["suspend", "withdraw"]);
    expect(decisionActions(suspended, NOW)).toEqual(["lift", "withdraw"]);
    expect(decisionActions(withdrawn, NOW)).toEqual([]);
  });

  it("names the recipient, or says the contact or member is no longer listed", () => {
    const relative: ContactOut = {
      id: CONTACT,
      personId: PERSON,
      role: "next_of_kin",
      givenName: "Relative",
      familyName: "Dummy",
      relationship: null,
      phone: null,
      email: null,
      addressLine1: null,
      town: null,
      postcode: null,
      isNextOfKin: true,
      authorityReference: null,
      authorityDocumentId: null,
      validUntil: null,
      authorityScope: null,
      notes: null,
      evidenceMissing: false,
      expired: false,
      updatedAt: "2026-10-01T09:00:00.000Z",
      version: 1,
    };
    const names = { contacts: new Map([[CONTACT, relative]]), staff: new Map([["u1", "Gina GP"]]) };
    expect(recipientLabel({ kind: "family", contactId: CONTACT }, names, t)).toBe(
      "Relative Dummy, Next of kin",
    );
    expect(recipientLabel({ kind: "professional", tenantUserId: "u1" }, names, t)).toBe(
      "Gina GP (professional)",
    );
    expect(recipientLabel({ kind: "family", contactId: "gone" }, names, t)).toBe(
      "A contact no longer on the record",
    );
    expect(recipientLabel({ kind: "link" }, names, t)).toBe("Whoever holds a share link");
  });

  it("offers each authority a contact can hold, from their role and a deputy's order", () => {
    expect(authorityRolesFor({ role: "lpa_health_welfare", authorityScope: null })).toEqual([
      "lpa_health_welfare",
    ]);
    expect(authorityRolesFor({ role: "deputy", authorityScope: "both" })).toEqual([
      "deputy_personal_welfare",
      "deputy_property_affairs",
    ]);
    expect(authorityRolesFor({ role: "deputy", authorityScope: null })).toEqual([]);
    expect(authorityRolesFor({ role: "next_of_kin", authorityScope: null })).toEqual([]);
  });

  it("reads a consent decision for a family member, ending at the end of the UK day", () => {
    const read = readSharingForm(
      form({
        recipientKind: "family",
        contactId: CONTACT,
        sections: ["activities_and_visits", "photos", "not_a_section"],
        basis: "consent",
        consentGivenBy: "person",
        capacity: "presumed",
      }),
      "2026-12-31",
      "2026-10-31",
      t,
    );
    expect(read).toEqual({
      ok: true,
      decision: {
        recipient: { kind: "family", contactId: CONTACT },
        sections: ["activities_and_visits", "photos"],
        basis: "consent",
        consentGivenBy: "person",
        capacity: "presumed",
        validTo: "2027-01-01T00:00:00.000Z",
      },
    });
    // In summer the UK day ends at 23:00 UTC.
    const summer = readSharingForm(
      form({
        recipientKind: "link",
        sections: "about_me",
        basis: "consent",
        consentGivenBy: "person",
      }),
      "2027-06-30",
      "2026-10-31",
      t,
    );
    expect(summer.ok && summer.decision.validTo).toBe("2027-06-30T23:00:00.000Z");
  });

  it("takes a legal authority as held by the family member it shares with, with a deputy's sections", () => {
    const read = readSharingForm(
      form({
        recipientKind: "family",
        contactId: CONTACT,
        sections: "finance",
        basis: "legal_authority",
        authorityContactId: "someone-else",
        authorityRole: "deputy_property_affairs",
        orderSections: ["finance", "benefits"],
        capacity: "assessed_lacks_capacity",
        capacityAssessmentId: "assessment-1",
      }),
      "2026-12-31",
      "2026-10-31",
      t,
    );
    expect(read.ok && read.decision.authority).toEqual({
      role: "deputy_property_affairs",
      contactId: CONTACT,
      orderSections: ["finance", "benefits"],
    });
    expect(read.ok && read.decision.capacityAssessmentId).toBe("assessment-1");
  });

  it("finds every problem at once, at its field", () => {
    const read = readSharingForm(
      form({ basis: "best_interests", capacity: "assessed_lacks_capacity" }),
      "2026-10-01",
      "2026-10-31",
      t,
    );
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(Object.keys(read.errors).sort()).toEqual([
        "bestInterestsDecisionId",
        "capacityAssessmentId",
        "recipientKind",
        "sections",
        "validTo",
      ]);
      expect(read.errors.validTo).toBe("Enter a day from today onwards");
    }
    const consent = readSharingForm(
      form({
        recipientKind: "family",
        sections: "photos",
        basis: "consent",
        consentGivenBy: "authority_holder",
      }),
      null,
      "2026-10-31",
      t,
    );
    expect(consent.ok).toBe(false);
    if (!consent.ok) {
      expect(Object.keys(consent.errors).sort()).toEqual([
        "authorityContactId",
        "authorityRole",
        "contactId",
        "validTo",
      ]);
    }
  });
});

describe("About me and its share links (PEOP-003)", () => {
  const written = about({
    sections: {
      what_is_most_important_to_me: { text: "My garden" },
      my_wellness: {
        text: null,
        media: [{ documentId: "0194d000-0000-7000-8900-000000000001", mimeType: "image/jpeg" }],
      },
      supported_to_write_this_by: "Sam Example, key worker",
    },
    version: 2,
  });

  it("reads each part's words and how many pictures it keeps", () => {
    expect(aboutMeText(written, "what_is_most_important_to_me")).toBe("My garden");
    expect(aboutMeText(written, "my_wellness")).toBeNull();
    expect(aboutMeMediaCount(written, "my_wellness")).toBe(1);
  });

  it("keeps pictures already added, replaces the words, and needs a supporter when supported", () => {
    const read = readAboutMeForm(
      form({
        authoredBy: "supported",
        supporter: "Sam Example, key worker",
        what_is_most_important_to_me: "",
        how_i_communicate: "Speak slowly",
      }),
      written,
      t,
    );
    expect(read).toEqual({
      ok: true,
      update: {
        authoredByPerson: false,
        sections: {
          my_wellness: {
            text: null,
            media: [{ documentId: "0194d000-0000-7000-8900-000000000001", mimeType: "image/jpeg" }],
          },
          how_i_communicate: { text: "Speak slowly" },
          supported_to_write_this_by: "Sam Example, key worker",
        },
      },
    });
    const missing = readAboutMeForm(form({ authoredBy: "supported" }), written, t);
    expect(missing).toEqual({
      ok: false,
      errors: { supporter: "Enter who supported them to write this" },
    });
    expect(readAboutMeForm(form({}), written, t)).toEqual({
      ok: false,
      errors: { authoredBy: "Choose who wrote it" },
    });
    const own = readAboutMeForm(form({ authoredBy: "person", supporter: "kept?" }), about(), t);
    expect(own.ok && own.update.sections.supported_to_write_this_by).toBeNull();
  });

  it("refuses a part longer than the API takes", () => {
    const read = readAboutMeForm(
      form({ authoredBy: "person", my_wellness: "x".repeat(4001) }),
      about(),
      t,
    );
    expect(read.ok).toBe(false);
    if (!read.ok)
      expect(read.errors.my_wellness).toBe("Shorten this part to 4,000 characters or fewer");
  });

  function link(overrides: Partial<AboutMeShareLinkOut> = {}): AboutMeShareLinkOut {
    return {
      id: "0194d000-0000-7000-8a00-000000000001",
      personId: PERSON,
      sharingDecisionId: "0194d000-0000-7000-8800-000000000001",
      expiresAt: "2026-11-30T00:00:00.000Z",
      revokedAt: null,
      revokedReason: null,
      lastOpenedAt: null,
      createdBy: null,
      createdAt: "2026-10-30T09:00:00.000Z",
      active: true,
      version: 1,
      ...overrides,
    };
  }

  it("says whether a link is active, revoked, expired or closed by its decision", () => {
    expect(linkStatus(link(), NOW)).toBe("active");
    expect(linkStatus(link({ revokedAt: "2026-10-31T09:00:00.000Z", active: false }), NOW)).toBe(
      "revoked",
    );
    expect(linkStatus(link({ expiresAt: "2026-10-31T00:00:00.000Z", active: false }), NOW)).toBe(
      "expired",
    );
    expect(linkStatus(link({ active: false }), NOW)).toBe("closed");
  });

  it("offers only decisions for a share link that cover About me and are in force", () => {
    const forLink = decision({ id: "a", recipient: { kind: "link" }, sections: ["about_me"] });
    const closed = decision({ ...forLink, id: "b", inForce: false });
    const family = decision({ id: "c", sections: ["about_me"] });
    expect(linkDecisions([forLink, closed, family]).map((d) => d.id)).toEqual(["a"]);
  });

  it("never lets a link outlive its decision, and refuses a day before today", () => {
    const decisionEnd = "2027-01-01T00:00:00.000Z";
    expect(decisionLastDay(decisionEnd)).toBe("2026-12-31");
    expect(linkExpiry("2026-11-30", decisionEnd, "2026-10-31")).toEqual({
      ok: true,
      expiresAt: "2026-12-01T00:00:00.000Z",
    });
    expect(linkExpiry("2026-12-31", decisionEnd, "2026-10-31")).toEqual({
      ok: true,
      expiresAt: decisionEnd,
    });
    // A decision that ends at 15:00 on its last day: a link that day stops then too.
    expect(linkExpiry("2026-12-31", "2026-12-31T15:00:00.000Z", "2026-10-31")).toEqual({
      ok: true,
      expiresAt: "2026-12-31T15:00:00.000Z",
    });
    expect(linkExpiry("2027-01-01", decisionEnd, "2026-10-31")).toEqual({
      ok: false,
      problem: "after_decision",
    });
    expect(linkExpiry("2026-10-30", decisionEnd, "2026-10-31")).toEqual({
      ok: false,
      problem: "past",
    });
  });
});
