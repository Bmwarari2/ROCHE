import { isTestRangeNhsNumber, validateNhsNumber } from "../people/nhs-number";
import { can, type EffectiveAccess } from "./access";

/**
 * Sample data mode (master prompt section 9.1, "Help and onboarding"; platform-completions.md
 * rules 29 to 32; hazard HZ-072). A new organisation can load invented people to learn Harbour
 * before go-live. Sample rows carry a flag and a batch id, are obviously invented (family name
 * "Example", 999-range NHS numbers, example.invalid addresses), never mix with real people, take
 * part in no statutory clock, notification, export, report or bill, and leave in one step.
 */

/** Things sample records never take part in; each module checks the flag before acting. */
export const SAMPLE_DATA_EXCLUSIONS = [
  "statutory_notifications",
  "regulatory_returns",
  "full_export",
  "reports_and_dashboards",
  "billing_and_seats",
  "outbound_messages",
  "integrations",
] as const;
export type SampleDataExclusion = (typeof SAMPLE_DATA_EXCLUSIONS)[number];

/** The family name every sample person has, so no one mistakes one for a real person. */
export const SAMPLE_FAMILY_NAME = "Example";
export const SAMPLE_EMAIL_DOMAIN = "example.invalid";

export type SamplePersonProblem =
  | "family_name_not_example"
  | "nhs_number_not_test_range"
  | "nhs_number_invalid"
  | "email_not_example_invalid";

/** Checks one sample person (or contact) is plainly invented before it is loaded. */
export function checkSamplePerson(person: {
  readonly familyName: string;
  readonly nhsNumber: string | null;
  readonly emails: readonly string[];
}): SamplePersonProblem[] {
  const problems: SamplePersonProblem[] = [];
  if (person.familyName.trim().toLowerCase() !== SAMPLE_FAMILY_NAME.toLowerCase()) {
    problems.push("family_name_not_example");
  }
  if (person.nhsNumber !== null) {
    if (!validateNhsNumber(person.nhsNumber).valid) problems.push("nhs_number_invalid");
    else if (!isTestRangeNhsNumber(person.nhsNumber)) problems.push("nhs_number_not_test_range");
  }
  const domainSuffix = `@${SAMPLE_EMAIL_DOMAIN}`;
  if (person.emails.some((e) => !e.trim().toLowerCase().endsWith(domainSuffix))) {
    problems.push("email_not_example_invalid");
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
  remove_sample_data_first: "Remove the sample data before adding real people.",
  nothing_to_remove: "There is no sample data to remove.",
  not_sample: "Something in this batch is not sample data, so nothing was removed.",
  held: "A legal hold covers part of this batch, so nothing was removed.",
  referenced_by_real_records: "Real records refer to this sample data, so nothing was removed.",
};
const fail = (problem: SampleDataProblem): SampleDataCheck => ({
  ok: false,
  problem,
  message: MESSAGES[problem],
});

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

/** The first real person waits until the sample data has gone, so the two never mix. */
export function checkRealPersonCreation(input: {
  readonly samplePresent: boolean;
}): SampleDataCheck {
  return input.samplePresent ? fail("remove_sample_data_first") : { ok: true };
}

/**
 * Removing sample data is one step that removes every row of the batch or none: every row must be
 * flagged sample, none under legal hold and none referred to by a real record. Audit events about
 * sample records stay (they hold opaque ids only) and the removal is audited.
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
