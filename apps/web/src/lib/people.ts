import type { PersonSummary } from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";
import { formatDate } from "./format";

/**
 * Point-of-care helpers shared by the people list and the person header. Pure, unit tested.
 */
export type PersonRow = PersonSummary;

export type AllergyTone = "danger" | "warning" | "neutral";

export interface AllergySummary {
  readonly tone: AllergyTone;
  readonly label: string;
  /** Lucide icon to show beside the word (status is never colour alone). */
  readonly icon: "triangle-alert" | "circle-help" | "circle-check";
}

/**
 * The allergy chip. "Allergies not recorded" is a warning, never shown as if there were none
 * (hazard: incorrect allergy display). A recorded status of "has allergies" with no active
 * allergy rows still reads as a warning rather than "No known allergies".
 */
export function allergySummary(
  person: Pick<PersonSummary, "allergyStatus" | "allergies">,
  t: Translator,
): AllergySummary {
  switch (person.allergyStatus) {
    case "no_known_allergies":
      return {
        tone: "neutral",
        label: t("people.header.allergies", { count: 0 }),
        icon: "circle-check",
      };
    case "has_allergies":
      if (person.allergies.length === 0) {
        return {
          tone: "warning",
          label: t("people.header.allergiesUnknown"),
          icon: "circle-help",
        };
      }
      return {
        tone: "danger",
        label: t("people.header.allergies", { count: person.allergies.length }),
        icon: "triangle-alert",
      };
    default:
      return {
        tone: "warning",
        label: t("people.header.allergiesUnknown"),
        icon: "circle-help",
      };
  }
}

/**
 * Communication needs (Accessible Information Standard; hazard HZ-023). Needs are listed when
 * recorded. "None identified" is shown only when someone recorded that the person has none; an
 * empty list otherwise reads "Not recorded", a warning with an icon and the words, never blank
 * and never "none".
 */
export type CommunicationSummary =
  | { readonly kind: "recorded"; readonly needs: readonly string[] }
  | { readonly kind: "none_identified"; readonly label: string }
  | { readonly kind: "not_recorded"; readonly label: string };

export function communicationSummary(
  person: Pick<PersonSummary, "communicationNeeds" | "communicationNeedsStatus">,
  t: Translator,
): CommunicationSummary {
  if (person.communicationNeeds.length > 0) {
    return { kind: "recorded", needs: person.communicationNeeds.map((need) => need.display) };
  }
  if (person.communicationNeedsStatus === "none_identified") {
    return { kind: "none_identified", label: t("people.communication.noneIdentified") };
  }
  return { kind: "not_recorded", label: t("people.communication.notRecorded") };
}

export interface PersonNames {
  /** What to call the person: their preferred name, or their given name. */
  readonly preferred: string;
  readonly full: string;
  /** True when a preferred name is recorded and differs from the given name. */
  readonly hasPreferred: boolean;
}

export function personNames(
  person: Pick<PersonSummary, "givenName" | "familyName" | "preferredName">,
): PersonNames {
  const full = `${person.givenName} ${person.familyName}`.trim();
  const preferred = person.preferredName?.trim() || person.givenName;
  return { preferred, full, hasPreferred: preferred !== person.givenName };
}

/** Two letters for the photo placeholder, for example "AE" for Ada Example. */
export function initials(person: Pick<PersonSummary, "givenName" | "familyName">): string {
  const first = Array.from(person.givenName.trim())[0] ?? "";
  const last = Array.from(person.familyName.trim())[0] ?? "";
  return `${first}${last}`.toLocaleUpperCase("en-GB");
}

export function roomLabel(person: Pick<PersonSummary, "roomLabel">): string | null {
  return person.roomLabel?.trim() || null;
}

export function canBreakGlass(permissions: readonly string[]): boolean {
  return permissions.includes("people.person.break_glass");
}

/** The shortest justification the break-glass form accepts (section 4). */
export const BREAK_GLASS_MIN_LENGTH = 20;

/** The longest justification the break-glass form accepts. */
export const BREAK_GLASS_MAX_LENGTH = 1000;

/**
 * Checks a break-glass justification after trimming. The form and the server action both use it,
 * so the person sees the same rule before and after sending.
 */
export function justificationProblem(justification: string): "too-short" | "too-long" | null {
  const length = justification.trim().length;
  if (length < BREAK_GLASS_MIN_LENGTH) return "too-short";
  if (length > BREAK_GLASS_MAX_LENGTH) return "too-long";
  return null;
}

/** What the people list needs for one row, prepared on the server so the table stays light. */
export interface PersonListItem {
  readonly id: string;
  readonly preferred: string;
  readonly full: string;
  readonly hasPreferred: boolean;
  readonly initials: string;
  readonly hasPhoto: boolean;
  /** "Room 4", or null when no room is recorded. */
  readonly room: string | null;
  readonly locationName: string | null;
  readonly dateOfBirth: string | null;
  readonly dateOfBirthIso: string | null;
  readonly allergy: AllergySummary;
  readonly communication: CommunicationSummary;
  /** Family name first, for sorting. */
  readonly sortName: string;
}

export function toPersonListItem(
  person: PersonRow,
  t: Translator,
  locationNames: ReadonlyMap<string, string>,
): PersonListItem {
  const names = personNames(person);
  const room = roomLabel(person);
  return {
    id: person.id,
    preferred: names.preferred,
    full: names.full,
    hasPreferred: names.hasPreferred,
    initials: initials(person),
    hasPhoto: person.photoUrl !== null,
    room: room ? t("people.header.room", { room }) : null,
    locationName: locationNames.get(person.locationId) ?? null,
    dateOfBirth: formatDate(person.dateOfBirth),
    dateOfBirthIso: person.dateOfBirth,
    allergy: allergySummary(person, t),
    communication: communicationSummary(person, t),
    sortName: `${person.familyName} ${person.givenName}`,
  };
}
