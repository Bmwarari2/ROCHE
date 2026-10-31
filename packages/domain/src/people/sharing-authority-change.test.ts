import { describe, expect, it } from "vitest";
import {
  type AuthorityChange,
  type AuthorityHolder,
  authorityChangeEffects,
  type SharingAuthority,
  type SharingDecision,
} from "./sharing";

/**
 * A change to the contact who holds a decision's authority (PEOP-001 with people.md rule 13;
 * HZ-022, fail closed). Contacts are changed on the personal details tab; a decision keeps its own
 * copy of the authority, so anything that takes the authority away must close the decision. Ben
 * is Ada Example's son and her health and welfare attorney; Dee is her deputy. Invented people.
 */

const BEN = "contact-ben";
const DEE = "contact-dee";

const lpa: SharingAuthority = {
  role: "lpa_health_welfare",
  contactId: BEN,
  reference: "OPG-EXAMPLE-1",
  evidenceDocumentId: null,
  validUntil: "2027-06-30",
};

type Decision = Pick<SharingDecision, "basis" | "consentGivenBy" | "authority">;
const onAuthority: Decision = { basis: "legal_authority", consentGivenBy: null, authority: lpa };

const ben: AuthorityHolder = {
  role: "lpa_health_welfare",
  authorityScope: null,
  reference: "OPG-EXAMPLE-1",
  documentId: null,
  validUntil: "2027-06-30",
  removed: false,
};

const deputy: Decision = {
  basis: "legal_authority",
  consentGivenBy: null,
  authority: {
    role: "deputy_personal_welfare",
    contactId: DEE,
    reference: "COP-EXAMPLE-2",
    evidenceDocumentId: null,
    validUntil: null,
    orderSections: ["care_plan"],
  },
};
const dee: AuthorityHolder = {
  role: "deputy",
  authorityScope: "personal_welfare",
  reference: "COP-EXAMPLE-2",
  documentId: null,
  validUntil: null,
  removed: false,
};

describe("hazard HZ-022 a change to the authority's holder closes what it took away", () => {
  it.each<[string, Decision, string, AuthorityHolder, AuthorityHolder, AuthorityChange[]]>([
    // Nothing that matters to the authority changed.
    ["a phone number changed", onAuthority, BEN, ben, ben, []],
    ["the authority extended", onAuthority, BEN, ben, { ...ben, validUntil: "2030-01-01" }, []],
    ["evidence added", onAuthority, BEN, ben, { ...ben, documentId: "doc-1" }, []],
    // The authority was taken away, or ends sooner than the decision recorded.
    ["the contact removed", onAuthority, BEN, ben, { ...ben, removed: true }, ["holder_removed"]],
    [
      "no longer an attorney",
      onAuthority,
      BEN,
      ben,
      { ...ben, role: "next_of_kin" },
      ["role_changed"],
    ],
    ["ends earlier", onAuthority, BEN, ben, { ...ben, validUntil: "2026-11-01" }, ["ends_earlier"]],
    [
      "the last evidence removed",
      onAuthority,
      BEN,
      ben,
      { ...ben, reference: null },
      ["evidence_removed"],
    ],
    [
      "ends where the decision recorded no end",
      deputy,
      DEE,
      dee,
      { ...dee, validUntil: "2027-01-01" },
      ["ends_earlier"],
    ],
    [
      "a deputy's order now covers property only",
      deputy,
      DEE,
      dee,
      { ...dee, authorityScope: "property_affairs" },
      ["order_scope_changed"],
    ],
    [
      "a deputy's order still covers welfare",
      deputy,
      DEE,
      dee,
      { ...dee, authorityScope: "both" },
      [],
    ],
    [
      "several at once",
      onAuthority,
      BEN,
      ben,
      { ...ben, role: "other", reference: null, validUntil: "2026-11-01" },
      ["role_changed", "evidence_removed", "ends_earlier"],
    ],
    // A decision that does not rest on this contact's authority is untouched.
    ["another contact's authority", onAuthority, DEE, dee, { ...dee, removed: true }, []],
    [
      "the person's own consent",
      { basis: "consent", consentGivenBy: "person", authority: null },
      BEN,
      ben,
      { ...ben, removed: true },
      [],
    ],
    [
      "consent given by the attorney",
      { basis: "consent", consentGivenBy: "authority_holder", authority: lpa },
      BEN,
      ben,
      { ...ben, role: "next_of_kin" },
      ["role_changed"],
    ],
    // Evidence was never on the contact (the decision carried its own): not "removed".
    [
      "no evidence before or after",
      onAuthority,
      BEN,
      { ...ben, reference: null },
      { ...ben, reference: null, phone: "01632 960000" } as AuthorityHolder,
      [],
    ],
  ])("%s", (_name, decision, holderId, before, after, expected) => {
    expect(authorityChangeEffects(decision, holderId, before, after)).toEqual(expected);
  });
});
