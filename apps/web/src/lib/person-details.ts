import type {
  ContactOut,
  ContactRole,
  CreateContact,
  PersonDetails,
  UpdatePersonDetails,
} from "@harbour/contracts";
import { validateNhsNumber } from "@harbour/domain";
import type { Translator } from "@harbour/i18n";
import { formatDate } from "./format";

/**
 * Helpers for the personal details tab (PEOP-001; people.md rule 15; data-standards.md `person`
 * and `contact`). Pure and unit tested: the web app reads what the form holds, checks what it can
 * before sending, and sends only what changed. The API checks every rule again.
 */

type FormValues = Pick<FormData, "get">;

const text = (form: FormValues, name: string) => String(form.get(name) ?? "").trim();

/** The codes the form offers (NHS Data Dictionary); a stored code not listed is still shown. */
export const SEX_CODES = ["1", "2", "9", "X"] as const;
export const ETHNIC_CATEGORY_CODES = [
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "J",
  "K",
  "L",
  "M",
  "N",
  "P",
  "R",
  "S",
  "Z",
  "99",
] as const;
/** Languages most often recorded in UK care (ISO 639-1, else 639-3; `bfi` is BSL). */
export const LANGUAGE_CODES = [
  "en",
  "cy",
  "gd",
  "ga",
  "bfi",
  "ar",
  "bn",
  "zh",
  "fr",
  "gu",
  "it",
  "lt",
  "pl",
  "pt",
  "pa",
  "ro",
  "so",
  "es",
  "ta",
  "tr",
  "ur",
] as const;

/** The fields of the personal details form, in the order they appear. */
export const DETAILS_FIELDS = [
  "title",
  "givenName",
  "familyName",
  "preferredName",
  "dateOfBirth",
  "nhsNumber",
  "localIdentifier",
  "sexCode",
  "genderIdentity",
  "ethnicCategoryCode",
  "religion",
  "firstLanguage",
  "interpreterRequired",
  "addressLine1",
  "addressLine2",
  "town",
  "postcode",
  "gpPracticeOdsCode",
] as const;
export type DetailsField = (typeof DETAILS_FIELDS)[number];

const POSTCODE = /^[A-Z]{1,2}[0-9][A-Z0-9]? ?[0-9][A-Z]{2}$/;
const ODS_PRACTICE = /^[A-Z][0-9]{5}$/;

/** A postcode as typed is one the API will take (it stores it upper case with one space). */
export function looksLikePostcode(value: string): boolean {
  return POSTCODE.test(value.toUpperCase().replace(/\s+/g, " ").trim());
}

/** A coded value as words, or the code itself when this version does not know it (never blank). */
export function codeLabel(
  key: "people.details.sex" | "people.details.ethnicCategory" | "people.details.language",
  code: string | null,
  t: Translator,
): string | null {
  return code ? t(key, { code }) : null;
}

/** "Address line 1, line 2, town, postcode" as one line, or null when none is recorded. */
export function addressLine(parts: readonly (string | null | undefined)[]): string | null {
  const present = parts.map((part) => part?.trim()).filter((part): part is string => !!part);
  return present.length > 0 ? present.join(", ") : null;
}

export type DetailsRead =
  | { readonly ok: true; readonly changes: Omit<UpdatePersonDetails, "version"> }
  | { readonly ok: false; readonly errors: Readonly<Record<string, string>> };

/**
 * The personal details form against the details it was opened with: only what changed, an empty
 * box clearing an optional field. Every problem it can find is returned at once, keyed by field.
 * The date of birth arrives already read from its boxes (null when left empty).
 */
export function readDetailsForm(
  form: FormValues,
  current: PersonDetails,
  dateOfBirth: string | null,
  today: string,
  t: Translator,
): DetailsRead {
  const errors: Record<string, string> = {};
  const value = (name: DetailsField): string | null => text(form, name) || null;
  const next = {
    title: value("title"),
    givenName: value("givenName"),
    familyName: value("familyName"),
    preferredName: value("preferredName"),
    dateOfBirth,
    nhsNumber: value("nhsNumber"),
    localIdentifier: value("localIdentifier"),
    sexCode: value("sexCode"),
    genderIdentity: value("genderIdentity"),
    ethnicCategoryCode: value("ethnicCategoryCode"),
    religion: value("religion"),
    firstLanguage: value("firstLanguage"),
    interpreterRequired: text(form, "interpreterRequired") === "yes",
    addressLine1: value("addressLine1"),
    addressLine2: value("addressLine2"),
    town: value("town"),
    postcode: value("postcode")?.toUpperCase() ?? null,
    gpPracticeOdsCode: value("gpPracticeOdsCode")?.toUpperCase() ?? null,
  };
  if (!next.givenName) errors.givenName = t("people.details.form.givenNameRequired");
  if (!next.familyName) errors.familyName = t("people.details.form.familyNameRequired");
  if (next.dateOfBirth && next.dateOfBirth > today) {
    errors.dateOfBirth = t("people.details.form.dobFuture");
  }
  if (next.nhsNumber) {
    const check = validateNhsNumber(next.nhsNumber);
    if (!check.valid) {
      errors.nhsNumber =
        check.problem === "invalid_check_digit"
          ? t("people.details.form.nhsCheckDigit")
          : t("people.details.form.nhsLength");
    } else {
      next.nhsNumber = check.value;
    }
  }
  if (!next.nhsNumber && !next.localIdentifier) {
    errors.localIdentifier = t("people.details.form.identifierRequired");
  }
  if (next.postcode && !looksLikePostcode(next.postcode)) {
    errors.postcode = t("people.details.form.postcodeInvalid");
  }
  if (next.gpPracticeOdsCode && !ODS_PRACTICE.test(next.gpPracticeOdsCode)) {
    errors.gpPracticeOdsCode = t("people.details.form.odsInvalid");
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(next)) {
    const before = current[key as keyof PersonDetails] ?? null;
    if (value !== before) changes[key] = value;
  }
  if (Object.keys(changes).length === 0) {
    return { ok: false, errors: { givenName: t("people.details.form.noChange") } };
  }
  return { ok: true, changes: changes as Omit<UpdatePersonDetails, "version"> };
}

// ------------------------------------------------------------------------------------------------
// Contacts and representatives
// ------------------------------------------------------------------------------------------------

export const CONTACT_ROLES = [
  "next_of_kin",
  "lpa_health_welfare",
  "lpa_property_finance",
  "deputy",
  "appointee",
  "imca",
  "advocate",
  "gp",
  "social_worker",
  "other",
] as const satisfies readonly ContactRole[];

/** A legal authority to act for the person: an attorney, a deputy or a DWP appointee. */
export const AUTHORITY_ROLES: readonly ContactRole[] = [
  "lpa_health_welfare",
  "lpa_property_finance",
  "deputy",
  "appointee",
];

/** Representatives listed first: the authorities, then advocates. */
const REPRESENTATIVE_ROLES: readonly ContactRole[] = [...AUTHORITY_ROLES, "imca", "advocate"];

export function isAuthorityRole(role: string): boolean {
  return (AUTHORITY_ROLES as readonly string[]).includes(role);
}

export interface ContactGroups {
  readonly representatives: readonly ContactOut[];
  readonly others: readonly ContactOut[];
}

/**
 * Legal representatives and advocates first, then everyone else with the next of kin at the top;
 * in each group, the order of the roles above and then by name. Ended ones stay listed, last.
 */
export function contactGroups(items: readonly ContactOut[]): ContactGroups {
  const roleRank = (c: ContactOut) => (CONTACT_ROLES as readonly string[]).indexOf(c.role);
  const byName = (a: ContactOut, b: ContactOut) =>
    a.familyName.localeCompare(b.familyName, "en-GB") ||
    a.givenName.localeCompare(b.givenName, "en-GB");
  const representative = (c: ContactOut) => REPRESENTATIVE_ROLES.includes(c.role);
  return {
    representatives: items
      .filter(representative)
      .sort(
        (a, b) =>
          Number(a.expired) - Number(b.expired) || roleRank(a) - roleRank(b) || byName(a, b),
      ),
    others: items
      .filter((c) => !representative(c))
      .sort(
        (a, b) =>
          Number(a.expired) - Number(b.expired) ||
          Number(b.isNextOfKin) - Number(a.isNextOfKin) ||
          roleRank(a) - roleRank(b) ||
          byName(a, b),
      ),
  };
}

export interface ContactStatus {
  readonly kind: "ended" | "evidence_missing" | "valid_until" | "no_end";
  /** StatusChip status: never colour alone, always with the icon and the words. */
  readonly tone: "overdue" | "due" | "neutral";
  readonly icon: "circle-x" | "triangle-alert" | "calendar-check" | "calendar";
  readonly label: string;
}

/**
 * What the list says about a contact's authority, most urgent first: ended, then evidence not
 * recorded (nothing is shared on it until there is some), then until when it lasts. Contacts who
 * are not representatives and have no end date say nothing.
 */
export function contactStatuses(contact: ContactOut, t: Translator): ContactStatus[] {
  const out: ContactStatus[] = [];
  const until = formatDate(contact.validUntil);
  if (contact.expired && until) {
    out.push({
      kind: "ended",
      tone: "overdue",
      icon: "circle-x",
      label: t("people.contacts.status.ended", { date: until }),
    });
  }
  if (contact.evidenceMissing) {
    out.push({
      kind: "evidence_missing",
      tone: "due",
      icon: "triangle-alert",
      label: t("people.contacts.status.evidenceMissing"),
    });
  }
  if (!contact.expired && until) {
    out.push({
      kind: "valid_until",
      tone: "neutral",
      icon: "calendar-check",
      label: t("people.contacts.status.validUntil", { date: until }),
    });
  } else if (!until && isAuthorityRole(contact.role)) {
    out.push({
      kind: "no_end",
      tone: "neutral",
      icon: "calendar",
      label: t("people.contacts.status.noEnd"),
    });
  }
  return out;
}

export function contactName(contact: Pick<ContactOut, "givenName" | "familyName">): string {
  return `${contact.givenName} ${contact.familyName}`;
}

export const CONTACT_FIELDS = [
  "role",
  "givenName",
  "familyName",
  "relationship",
  "isNextOfKin",
  "phone",
  "email",
  "addressLine1",
  "town",
  "postcode",
  "authorityReference",
  "authorityDocumentId",
  "validUntil",
  "authorityScope",
  "notes",
] as const;
export type ContactField = (typeof CONTACT_FIELDS)[number];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ContactRead =
  | { readonly ok: true; readonly contact: CreateContact }
  | { readonly ok: false; readonly errors: Readonly<Record<string, string>> };

/**
 * The contact form as the API takes it: every field (an empty box is null), with each problem it
 * can find at once. A deputy says what their order covers; nobody else has one. The end date
 * arrives already read from its boxes (null when empty).
 */
export function readContactForm(
  form: FormValues,
  validUntil: string | null,
  t: Translator,
): ContactRead {
  const errors: Record<string, string> = {};
  const value = (name: ContactField): string | null => text(form, name) || null;
  const role = value("role") as ContactRole | null;
  if (!role || !(CONTACT_ROLES as readonly string[]).includes(role)) {
    errors.role = t("people.contacts.form.roleRequired");
  }
  const givenName = value("givenName");
  const familyName = value("familyName");
  if (!givenName) errors.givenName = t("people.details.form.givenNameRequired");
  if (!familyName) errors.familyName = t("people.details.form.familyNameRequired");
  const email = value("email");
  if (email && !EMAIL.test(email)) errors.email = t("people.contacts.form.emailInvalid");
  const postcode = value("postcode")?.toUpperCase() ?? null;
  if (postcode && !looksLikePostcode(postcode)) {
    errors.postcode = t("people.details.form.postcodeInvalid");
  }
  const scope = role === "deputy" ? value("authorityScope") : null;
  if (role === "deputy" && !scope) errors.authorityScope = t("people.contacts.form.scopeRequired");
  if (Object.keys(errors).length > 0 || !role || !givenName || !familyName) {
    return { ok: false, errors };
  }
  const authority = isAuthorityRole(role);
  return {
    ok: true,
    contact: {
      role,
      givenName,
      familyName,
      relationship: value("relationship"),
      isNextOfKin: text(form, "isNextOfKin") === "yes",
      phone: value("phone"),
      email,
      addressLine1: value("addressLine1"),
      town: value("town"),
      postcode,
      authorityReference: authority ? value("authorityReference") : null,
      authorityDocumentId: authority ? value("authorityDocumentId") : null,
      validUntil,
      authorityScope: scope as CreateContact["authorityScope"],
      notes: value("notes"),
    },
  };
}

/** Only the fields that differ from the contact as it was loaded. */
export function contactChanges(
  next: CreateContact,
  current: ContactOut,
): Partial<CreateContact> | null {
  const changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(next)) {
    const before = current[key as keyof ContactOut] ?? null;
    if ((value ?? null) !== before) changes[key] = value ?? null;
  }
  return Object.keys(changes).length > 0 ? (changes as Partial<CreateContact>) : null;
}
