import type { ContactOut, PersonDetails } from "@harbour/contracts";
import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  addressLine,
  codeLabel,
  contactChanges,
  contactGroups,
  contactStatuses,
  looksLikePostcode,
  readContactForm,
  readDetailsForm,
} from "./person-details";

const t = createTranslator("en-GB");
const TODAY = "2026-10-31";

/** Invented people only (section 20): test-range NHS numbers, example.invalid emails. */
const FRANK: PersonDetails = {
  personId: "0194d000-0000-7000-8600-000000000006",
  status: "active",
  nhsNumber: "9990000069",
  localIdentifier: null,
  title: null,
  givenName: "Frank",
  familyName: "Dummy",
  preferredName: null,
  dateOfBirth: "1946-01-25",
  sexCode: null,
  genderIdentity: null,
  ethnicCategoryCode: null,
  religion: null,
  firstLanguage: "en",
  interpreterRequired: false,
  addressLine1: null,
  addressLine2: null,
  town: null,
  postcode: null,
  gpPracticeOdsCode: null,
  legalStatus: null,
  nationalDataOptOut: false,
  updatedAt: "2026-10-01T09:00:00.000Z",
  updatedBy: null,
  version: 3,
};

/** A form as the details form posts it: every field, as typed. */
function detailsForm(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    title: "",
    givenName: "Frank",
    familyName: "Dummy",
    preferredName: "",
    nhsNumber: "999 000 0069",
    localIdentifier: "",
    sexCode: "",
    genderIdentity: "",
    ethnicCategoryCode: "",
    religion: "",
    firstLanguage: "en",
    addressLine1: "",
    addressLine2: "",
    town: "",
    postcode: "",
    gpPracticeOdsCode: "",
    ...overrides,
  };
  return { get: (name: string) => values[name] ?? null };
}

function contact(overrides: Partial<ContactOut> = {}): ContactOut {
  return {
    id: "0194d000-0000-7000-8700-000000000001",
    personId: FRANK.personId,
    role: "next_of_kin",
    givenName: "Relative",
    familyName: "Dummy",
    relationship: "Child",
    phone: null,
    email: "relative.dummy@example.invalid",
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
    ...overrides,
  };
}

describe("personal details form (PEOP-001)", () => {
  it("sends only what changed, and an empty box clears a field", () => {
    const read = readDetailsForm(
      detailsForm({ religion: "Quaker", firstLanguage: "", postcode: "zz99 3zz" }),
      FRANK,
      FRANK.dateOfBirth,
      TODAY,
      t,
    );
    expect(read).toEqual({
      ok: true,
      changes: { religion: "Quaker", firstLanguage: null, postcode: "ZZ99 3ZZ" },
    });
  });

  it("says when nothing has changed rather than sending an empty change", () => {
    const read = readDetailsForm(detailsForm(), FRANK, FRANK.dateOfBirth, TODAY, t);
    expect(read.ok).toBe(false);
  });

  it.each([
    [{ nhsNumber: "9990000019" }, "nhsNumber", "Check the NHS number"],
    [{ nhsNumber: "99900" }, "nhsNumber", "Enter all 10 digits of the NHS number"],
    [{ nhsNumber: "", localIdentifier: "" }, "localIdentifier", "Enter an NHS number or a local"],
    [{ givenName: "  " }, "givenName", "Enter a given name"],
    [{ familyName: "" }, "familyName", "Enter a family name"],
    [{ postcode: "ZZ99" }, "postcode", "Enter a full UK postcode"],
    [{ gpPracticeOdsCode: "12345" }, "gpPracticeOdsCode", "a capital letter and 5 digits"],
  ])("refuses %j at %s in words", (overrides, field, words) => {
    const read = readDetailsForm(detailsForm(overrides), FRANK, FRANK.dateOfBirth, TODAY, t);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.errors[field]).toContain(words);
  });

  it("refuses a date of birth in the future and finds every problem at once", () => {
    const read = readDetailsForm(
      detailsForm({ givenName: "", postcode: "nope" }),
      FRANK,
      "2027-01-01",
      TODAY,
      t,
    );
    expect(read.ok).toBe(false);
    if (!read.ok)
      expect(Object.keys(read.errors).sort()).toEqual(["dateOfBirth", "givenName", "postcode"]);
  });

  it("takes an NHS number typed with spaces as its 10 digits, so it is not a change", () => {
    const read = readDetailsForm(
      detailsForm({ nhsNumber: "999-000-0069", religion: "None" }),
      FRANK,
      FRANK.dateOfBirth,
      TODAY,
      t,
    );
    expect(read).toEqual({ ok: true, changes: { religion: "None" } });
  });

  it("names coded values in words, and an unknown code as itself, never blank", () => {
    expect(codeLabel("people.details.sex", "2", t)).toBe("Female");
    expect(codeLabel("people.details.ethnicCategory", "99", t)).toBe("Not known");
    expect(codeLabel("people.details.language", "bfi", t)).toBe("British Sign Language");
    expect(codeLabel("people.details.language", "xx", t)).toBe("Language code xx");
    expect(codeLabel("people.details.sex", null, t)).toBeNull();
  });

  it("joins the parts of an address that are recorded", () => {
    expect(addressLine(["1 Example Street", null, " ", "ZZ99 3ZZ"])).toBe(
      "1 Example Street, ZZ99 3ZZ",
    );
    expect(addressLine([null, ""])).toBeNull();
    expect(looksLikePostcode("zz99 3zz")).toBe(true);
    expect(looksLikePostcode("ZZ993")).toBe(false);
  });
});

describe("contacts and representatives (PEOP-001)", () => {
  it("lists representatives apart, authorities first, and ended ones last", () => {
    const groups = contactGroups([
      contact({ id: "a", role: "other", isNextOfKin: false, familyName: "Other" }),
      contact({ id: "b", role: "advocate", isNextOfKin: false }),
      contact({ id: "c", role: "lpa_health_welfare", isNextOfKin: false, expired: true }),
      contact({ id: "d", role: "deputy", isNextOfKin: false, authorityScope: "both" }),
      contact({ id: "e" }),
    ]);
    expect(groups.representatives.map((c) => c.id)).toEqual(["d", "b", "c"]);
    expect(groups.others.map((c) => c.id)).toEqual(["e", "a"]);
  });

  it("says an authority has ended, has no evidence, or until when it lasts, in words", () => {
    const ended = contactStatuses(
      contact({ role: "lpa_property_finance", validUntil: "2020-01-01", expired: true }),
      t,
    );
    expect(ended.map((s) => s.label)).toEqual(["Ended 01/01/2020"]);
    const missing = contactStatuses(
      contact({ role: "appointee", evidenceMissing: true, validUntil: "2027-12-31" }),
      t,
    );
    expect(missing.map((s) => [s.kind, s.label])).toEqual([
      ["evidence_missing", "Evidence not recorded"],
      ["valid_until", "Valid until 31/12/2027"],
    ]);
    // Every status has an icon and a word (never colour alone).
    for (const status of missing) expect(status.icon).toBeTruthy();
    expect(contactStatuses(contact({ role: "deputy", authorityScope: "both" }), t)).toEqual([
      expect.objectContaining({ kind: "no_end", label: "No end date recorded" }),
    ]);
    expect(contactStatuses(contact(), t)).toEqual([]);
  });

  function contactForm(values: Record<string, string>) {
    return { get: (name: string) => values[name] ?? null };
  }

  it("reads a representative with every field, and refuses a deputy without an order scope", () => {
    const read = readContactForm(
      contactForm({
        role: "lpa_health_welfare",
        givenName: "Pat",
        familyName: "Attorney",
        email: "pat.attorney@example.invalid",
        postcode: "zz99 3zz",
        authorityReference: "OPG-EXAMPLE-0001",
      }),
      "2027-12-31",
      t,
    );
    expect(read).toEqual({
      ok: true,
      contact: expect.objectContaining({
        role: "lpa_health_welfare",
        postcode: "ZZ99 3ZZ",
        authorityReference: "OPG-EXAMPLE-0001",
        validUntil: "2027-12-31",
        isNextOfKin: false,
        authorityScope: null,
      }),
    });
    const deputy = readContactForm(
      contactForm({ role: "deputy", givenName: "Dee", familyName: "Deputy" }),
      null,
      t,
    );
    expect(deputy).toEqual({
      ok: false,
      errors: { authorityScope: "Choose what the deputy's order covers" },
    });
    const bad = readContactForm(contactForm({ role: "", email: "not an email" }), null, t);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(Object.keys(bad.errors).sort()).toEqual(["email", "familyName", "givenName", "role"]);
    }
  });

  it("drops an authority's reference for a role that has none, and finds what changed", () => {
    const read = readContactForm(
      contactForm({
        role: "gp",
        givenName: "Gina",
        familyName: "Practice",
        authorityReference: "ignored",
      }),
      null,
      t,
    );
    expect(read.ok && read.contact.authorityReference).toBeNull();
    const current = contact();
    const same = readContactForm(
      contactForm({
        role: "next_of_kin",
        givenName: "Relative",
        familyName: "Dummy",
        relationship: "Child",
        email: "relative.dummy@example.invalid",
        isNextOfKin: "yes",
      }),
      null,
      t,
    );
    expect(same.ok && contactChanges(same.contact, current)).toBeNull();
    const phone = readContactForm(
      contactForm({
        role: "next_of_kin",
        givenName: "Relative",
        familyName: "Dummy",
        relationship: "Child",
        email: "relative.dummy@example.invalid",
        isNextOfKin: "yes",
        phone: "01632 960000",
      }),
      null,
      t,
    );
    expect(phone.ok && contactChanges(phone.contact, current)).toEqual({ phone: "01632 960000" });
  });
});
