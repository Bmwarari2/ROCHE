import {
  PersonCareProfile,
  type PersonCareProfile as PersonCareProfileType,
  PersonSummary,
  type PersonSummary as PersonSummaryType,
  ResuscitationStatus,
  type ResuscitationStatus as ResuscitationStatusType,
} from "@harbour/contracts";

/**
 * Reads what the point-of-care header shows (hazards HZ-001, HZ-015 and HZ-016) with the API's
 * own schemas when it arrives, not just by its TypeScript type. A value the web app cannot read,
 * such as a resuscitation status it does not know, is never shown as if it were a calm one: the
 * header says it could not be read and to check the paper record.
 */

/** A person as the header shows them; `resuscitation` is null when it could not be read. */
export interface PersonRecord extends Omit<PersonSummaryType, "resuscitation"> {
  readonly resuscitation: ResuscitationStatusType | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const PersonWithoutResuscitation = PersonSummary.omit({ resuscitation: true });

/**
 * The person summary from the API, or null when it cannot be read safely (then the record shows
 * a warning instead of details that may be wrong). The resuscitation status is read on its own,
 * so a status the web app does not know shows as unreadable without hiding the rest.
 */
export function readPersonSummary(data: unknown): PersonRecord | null {
  if (!isRecord(data)) return null;
  const person = PersonWithoutResuscitation.safeParse(data);
  if (!person.success) return null;
  return { ...person.data, resuscitation: readResuscitation(data.resuscitation) };
}

/** A resuscitation status from the API, or null when it cannot be read. */
export function readResuscitation(data: unknown): ResuscitationStatusType | null {
  const status = ResuscitationStatus.safeParse(data);
  return status.success ? status.data : null;
}

/** The care profile (IDDSI levels, SpO2 scale, fluid target) as a page has it. */
export type CareProfileLoad =
  | { readonly kind: "ok"; readonly profile: PersonCareProfileType }
  /** The person viewing may not read the care profile: the header says so in words. */
  | { readonly kind: "no_access" }
  /** The API's answer could not be read: the header says to check the paper record. */
  | { readonly kind: "unreadable" };

export function readCareProfile(data: unknown): CareProfileLoad {
  const profile = PersonCareProfile.safeParse(data);
  return profile.success ? { kind: "ok", profile: profile.data } : { kind: "unreadable" };
}

/** The profile when it was read, otherwise null. */
export function profileOf(load: CareProfileLoad): PersonCareProfileType | null {
  return load.kind === "ok" ? load.profile : null;
}
