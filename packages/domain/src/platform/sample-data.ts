import { isTestRangeNhsNumber, validateNhsNumber } from "../people/nhs-number";
import { can, type EffectiveAccess } from "./access";

/**
 * Sample data mode (master prompt section 9.1, "Help and onboarding"; platform-completions.md
 * rules 29 to 32; hazard HZ-072). A new organisation can load invented people to learn Harbour
 * before go-live. Sample rows carry a flag and a batch id, are plainly invented (family name
 * "Example", 999-range NHS numbers, Ofcom drama telephone numbers, example.invalid email
 * addresses, invented addresses), never mix with real people, carry a "Sample" badge on screen and
 * a watermark on print, take part in nothing that leaves the screen (notifications, alerts,
 * handover, exports, reports, bills, messages), and leave in one step.
 */

/**
 * What happens to sample records in each part of Harbour: `exclude` (left out entirely), `watermark`
 * (allowed, with the sample watermark on every page) or `badge` (shown with the "Sample" badge).
 */
export const SAMPLE_DATA_TREATMENT = {
  statutory_notifications: "exclude",
  regulatory_returns: "exclude",
  full_export: "exclude",
  reports_and_dashboards: "exclude",
  billing_and_seats: "exclude",
  outbound_messages: "exclude",
  integrations: "exclude",
  in_app_alerts: "exclude",
  escalation_chains: "exclude",
  handover: "exclude",
  downtime_pack: "exclude",
  bulk_prints: "exclude",
  record_print: "watermark",
  screens: "badge",
} as const satisfies Record<string, "exclude" | "watermark" | "badge">;
export type SampleDataSurface = keyof typeof SAMPLE_DATA_TREATMENT;

/**
 * The items a part of Harbour may use: sample items are removed where they are excluded, and kept
 * (to be watermarked or badged) elsewhere. Each module calls this before acting on a list.
 */
export function forSurface<T extends { readonly sample: boolean }>(
  surface: SampleDataSurface,
  items: readonly T[],
): T[] {
  return SAMPLE_DATA_TREATMENT[surface] === "exclude" ? items.filter((i) => !i.sample) : [...items];
}

export const SAMPLE_BADGE = {
  label: "Sample",
  description: "An invented person for practice. Not a real person.",
} as const;

/** The badge shown beside a sample person's name on every screen, or null for a real person. */
export function samplePersonBadge(person: {
  readonly sample: boolean;
}): typeof SAMPLE_BADGE | null {
  return person.sample ? SAMPLE_BADGE : null;
}

export const SAMPLE_WATERMARK = "SAMPLE DATA: NOT A REAL PERSON";

/** The watermark for a printed page, when anything on it is sample data. */
export function samplePrintWatermark(
  items: readonly { readonly sample: boolean }[],
): typeof SAMPLE_WATERMARK | null {
  return items.some((i) => i.sample) ? SAMPLE_WATERMARK : null;
}

export type OutboundCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly problem: "sample_data"; readonly message: string };

/**
 * The central outbound guard (the integrations adapter guard calls it before any email, SMS, push,
 * webhook or partner message): nothing about, or addressed to, a sample record leaves Harbour.
 */
export function checkOutboundForSample(
  records: readonly { readonly sample: boolean }[],
): OutboundCheck {
  return records.some((r) => r.sample)
    ? { ok: false, problem: "sample_data", message: "Sample data never leaves Harbour." }
    : { ok: true };
}

/** The family name every sample person has, so no one mistakes one for a real person. */
export const SAMPLE_FAMILY_NAME = "Example";
export const SAMPLE_EMAIL_DOMAIN = "example.invalid";
/** Sample addresses name an Example street and use no postcode or the ZZ99 pseudo-postcode area. */
export const SAMPLE_ADDRESS_WORD = "example";
export const SAMPLE_POSTCODE_AREA = "ZZ99";

/**
 * Ofcom's telephone numbers reserved for drama, which are never allocated to anyone: each entry is
 * the first 8 digits of a block of 1,000 numbers (for example 07700 900000 to 07700 900999). To
 * verify against Ofcom's published list before a real tenant loads sample data (H-123):
 * https://www.ofcom.org.uk/phones-and-broadband/phone-numbers/numbers-for-drama
 */
export const OFCOM_DRAMA_NUMBER_BLOCKS: readonly string[] = [
  "07700900",
  "01134960",
  "01144960",
  "01154960",
  "01164960",
  "01174960",
  "01184960",
  "01214960",
  "01314960",
  "01414960",
  "01514960",
  "01614960",
  "02079460",
  "01914980",
  "02896496",
  "02920180",
  "01632960",
  "03069990",
  "08081570",
  "09098790",
];

/** True for a UK number in one of Ofcom's drama blocks, typed with spaces or as +44. */
export function isOfcomDramaNumber(phone: string): boolean {
  let digits = "";
  const trimmed = phone.trim();
  for (const ch of trimmed.startsWith("+44") ? `0${trimmed.slice(3)}` : trimmed) {
    if (ch >= "0" && ch <= "9") digits += ch;
    else if (ch !== " " && ch !== "-" && ch !== "(" && ch !== ")") return false;
  }
  return digits.length === 11 && OFCOM_DRAMA_NUMBER_BLOCKS.includes(digits.slice(0, 8));
}

export type SamplePersonProblem =
  | "family_name_not_example"
  | "nhs_number_not_valid_test_number"
  | "email_not_example_invalid"
  | "phone_not_drama_number"
  | "address_not_invented";

export interface SamplePersonInput {
  readonly familyName: string;
  readonly nhsNumber: string | null;
  readonly emails: readonly string[];
  readonly phones: readonly string[];
  readonly address: { readonly line1: string; readonly postcode: string | null } | null;
}

/** Checks one sample person (or contact) is plainly invented before it is loaded. */
export function checkSamplePerson(person: SamplePersonInput): SamplePersonProblem[] {
  const problems: SamplePersonProblem[] = [];
  if (person.familyName.trim().toLowerCase() !== SAMPLE_FAMILY_NAME.toLowerCase()) {
    problems.push("family_name_not_example");
  }
  if (
    person.nhsNumber !== null &&
    (!isTestRangeNhsNumber(person.nhsNumber) || !validateNhsNumber(person.nhsNumber).valid)
  ) {
    problems.push("nhs_number_not_valid_test_number");
  }
  const domainSuffix = `@${SAMPLE_EMAIL_DOMAIN}`;
  if (person.emails.some((e) => !e.trim().toLowerCase().endsWith(domainSuffix))) {
    problems.push("email_not_example_invalid");
  }
  if (person.phones.some((p) => !isOfcomDramaNumber(p))) problems.push("phone_not_drama_number");
  const address = person.address;
  if (
    address !== null &&
    (!address.line1.toLowerCase().includes(SAMPLE_ADDRESS_WORD) ||
      (address.postcode !== null &&
        !address.postcode.trim().toUpperCase().startsWith(SAMPLE_POSTCODE_AREA)))
  ) {
    problems.push("address_not_invented");
  }
  return problems;
}

export type SampleFlagCheck =
  | { readonly ok: true; readonly sample: boolean }
  | { readonly ok: false; readonly problem: "mixes_sample_and_real"; readonly message: string };

/**
 * The flag for a new record from the records it refers to: a record about a sample person is
 * sample too (staff practising on sample people write sample notes); a record that would join
 * sample and real records (an incident involving both, a real document on a sample person) is
 * refused. Staff accounts are real and may act on either.
 */
export function sampleFlagForNewRecord(
  references: readonly { readonly sample: boolean }[],
): SampleFlagCheck {
  const sample = references.some((r) => r.sample);
  if (sample && references.some((r) => !r.sample)) {
    return {
      ok: false,
      problem: "mixes_sample_and_real",
      message: "Sample records cannot be linked to real ones.",
    };
  }
  return { ok: true, sample };
}

/**
 * Every way real records about people or staff enter Harbour. While sample data exists none of
 * them may run, so real and sample records never share a list.
 */
export const REAL_RECORD_CREATION_PATHS = [
  "manual_entry",
  "enquiry",
  "import",
  "integration",
  "tupe_transfer",
] as const;
export type RealRecordCreationPath = (typeof REAL_RECORD_CREATION_PATHS)[number];

export type SampleDataProblem =
  | "missing_permission"
  | "real_people_exist"
  | "already_loaded"
  | "remove_sample_data_first"
  | "nothing_to_remove"
  | "not_sample"
  | "held"
  | "referenced_by_real_records";

export type SampleDataCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly problem: SampleDataProblem; readonly message: string };

const MESSAGES: Record<SampleDataProblem, string> = {
  missing_permission: "Only the organisation's owner can load or remove sample data.",
  real_people_exist: "Sample data can only be loaded before you add real people.",
  already_loaded: "Sample data is already loaded.",
  remove_sample_data_first: "Remove the sample data before adding real records.",
  nothing_to_remove: "There is no sample data to remove.",
  not_sample: "Something in this batch is not sample data, so nothing was removed.",
  held: "A legal hold covers part of this batch, so nothing was removed.",
  referenced_by_real_records: "Real records refer to this sample data, so nothing was removed.",
};
/** A refusal in plain English, for a problem found here or reported by the database (rule 32). */
export function sampleDataRefusal(
  problem: SampleDataProblem,
): Extract<SampleDataCheck, { ok: false }> {
  return { ok: false, problem, message: MESSAGES[problem] };
}
const fail = (problem: SampleDataProblem): SampleDataCheck => sampleDataRefusal(problem);

/** Loading sample data: the owner, once, before any real person exists. */
export function checkSampleDataLoad(input: {
  readonly access: EffectiveAccess;
  readonly realPeople: number;
  readonly samplePresent: boolean;
}): SampleDataCheck {
  if (!can(input.access, "platform.onboarding.manage")) return fail("missing_permission");
  if (input.realPeople > 0) return fail("real_people_exist");
  if (input.samplePresent) return fail("already_loaded");
  return { ok: true };
}

/**
 * Real records wait until the sample data has gone, whichever way they arrive: typed in, from an
 * enquiry, an import, an integration or a TUPE transfer of staff.
 */
export function checkRealRecordCreation(input: {
  readonly path: RealRecordCreationPath;
  readonly samplePresent: boolean;
}): SampleDataCheck {
  return input.samplePresent ? fail("remove_sample_data_first") : { ok: true };
}

/**
 * Removing sample data is one step that removes every row of the batch or none: every row must be
 * flagged sample, none under legal hold and none referred to by a real record. The database does
 * the deletion through a narrow security-definer function owned by a dedicated no-login role, never
 * by a DELETE grant to the application (platform-completions.md rule 32). Audit events about sample
 * records stay (they hold opaque ids only) and the removal is audited.
 */
export function checkSampleDataRemoval(input: {
  readonly access: EffectiveAccess;
  readonly rows: readonly { readonly sample: boolean; readonly legalHold: boolean }[];
  readonly realReferences: number;
}): SampleDataCheck {
  if (!can(input.access, "platform.onboarding.manage")) return fail("missing_permission");
  if (input.rows.length === 0) return fail("nothing_to_remove");
  if (input.rows.some((r) => !r.sample)) return fail("not_sample");
  if (input.rows.some((r) => r.legalHold)) return fail("held");
  if (input.realReferences > 0) return fail("referenced_by_real_records");
  return { ok: true };
}

/** One invented person the sample batch loads (rule 29). */
export interface SamplePersonSeed {
  readonly givenName: string;
  readonly familyName: string;
  readonly preferredName: string;
  /** "yyyy-mm-dd". */
  readonly dateOfBirth: string;
  /** 999 range, with a valid check digit. */
  readonly nhsNumber: string;
  readonly roomLabel: string;
  readonly allergyStatus: "unknown" | "no_known_allergies" | "has_allergies";
}

/**
 * The people a sample batch loads: plainly invented (family name "Example", 999-range NHS numbers
 * that pass their check digit), varied enough to practise with (one whose allergy status is not
 * yet known, as on a real admission). Checked with `checkSamplePerson` by the tests.
 */
export const SAMPLE_PEOPLE: readonly SamplePersonSeed[] = [
  {
    givenName: "Ada",
    familyName: SAMPLE_FAMILY_NAME,
    preferredName: "Ada",
    dateOfBirth: "1938-02-01",
    nhsNumber: "9996000001",
    roomLabel: "Sample 1",
    allergyStatus: "has_allergies",
  },
  {
    givenName: "Benjamin",
    familyName: SAMPLE_FAMILY_NAME,
    preferredName: "Ben",
    dateOfBirth: "1941-07-14",
    nhsNumber: "9996000028",
    roomLabel: "Sample 2",
    allergyStatus: "no_known_allergies",
  },
  {
    givenName: "Cara",
    familyName: SAMPLE_FAMILY_NAME,
    preferredName: "Cara",
    dateOfBirth: "1950-11-30",
    nhsNumber: "9996000036",
    roomLabel: "Sample 3",
    allergyStatus: "unknown",
  },
  {
    givenName: "Devendra",
    familyName: SAMPLE_FAMILY_NAME,
    preferredName: "Dev",
    dateOfBirth: "1946-04-22",
    nhsNumber: "9996000044",
    roomLabel: "Sample 4",
    allergyStatus: "no_known_allergies",
  },
];
