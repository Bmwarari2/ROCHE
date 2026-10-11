/**
 * Turns local person rows into what the screens show. Pure, so the safety rules are tested:
 * communication needs that cannot be read still raise a flag rather than disappearing.
 */
import { describeAllergyFlag, fullName, knownAsName } from "@harbour/ui-native/logic";
import type { PersonRow } from "./queries";

export interface CommunicationNeed {
  readonly code: string | null;
  readonly display: string;
  readonly preferredFormat: string | null;
}

export const UNREADABLE_NEEDS =
  "Communication needs could not be shown on this device. Check the full record.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Parses the `communication_needs` JSON column: an array of { code, display, preferredFormat }.
 * Empty or null means none recorded. Anything malformed is reported as unreadable.
 */
export function parseCommunicationNeeds(raw: string | null | undefined): {
  readonly needs: readonly CommunicationNeed[];
  readonly unreadable: boolean;
} {
  if (raw === null || raw === undefined || raw.trim() === "")
    return { needs: [], unreadable: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { needs: [], unreadable: true };
  }
  if (!Array.isArray(parsed)) return { needs: [], unreadable: true };
  const needs: CommunicationNeed[] = [];
  let unreadable = false;
  for (const item of parsed) {
    const display = isRecord(item) ? text(item.display) : null;
    if (!isRecord(item) || !display) {
      unreadable = true;
      continue;
    }
    needs.push({
      code: text(item.code),
      display,
      preferredFormat: text(item.preferredFormat),
    });
  }
  return { needs, unreadable };
}

export interface PersonView {
  readonly id: string;
  readonly preferredName: string | null;
  readonly givenName: string | null;
  readonly familyName: string | null;
  /** The name the person is known by. */
  readonly knownAs: string;
  /** Known-as name with the family name, for list titles: "Bea Sample". */
  readonly displayName: string;
  /** Given and family name: "Beatrice Sample". */
  readonly fullName: string;
  /** List subtitle: room, and the full name when it differs from the display name. */
  readonly subtitle: string;
  readonly room: string | null;
  readonly dateOfBirth: string | null;
  readonly nhsNumber: string | null;
  readonly photoDocumentId: string | null;
  readonly allergyStatus: string | null;
  readonly allergyCount: number;
  /** Display text for each need; includes a warning line if the stored value was unreadable. */
  readonly communicationNeeds: readonly string[];
  /** One sentence a screen reader reads for the whole list row. */
  readonly accessibilityLabel: string;
}

export function toPersonView(row: PersonRow): PersonView {
  const name = {
    preferredName: row.preferred_name,
    givenName: row.given_name,
    familyName: row.family_name,
  };
  const { needs, unreadable } = parseCommunicationNeeds(row.communication_needs);
  const communicationNeeds = needs.map((n) =>
    n.preferredFormat ? `${n.display} (${n.preferredFormat})` : n.display,
  );
  if (unreadable) communicationNeeds.push(UNREADABLE_NEEDS);

  const allergyCount = Number(row.allergy_count) || 0;
  const allergy = describeAllergyFlag(row.allergy_status, allergyCount);
  const known = knownAsName(name) || "Name not recorded";
  const full = fullName(name);
  const family = (row.family_name ?? "").trim();
  const displayName = family && known !== family ? `${known} ${family}` : known;
  const showFull = full !== "" && full !== displayName;
  const subtitle = [row.room_label, showFull ? full : null]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  const spoken = [
    showFull ? `${displayName}, full name ${full}` : displayName,
    row.room_label,
    allergy.showInLists ? allergy.accessibilityLabel : null,
    communicationNeeds.length > 0 ? `Communication needs: ${communicationNeeds.join(", ")}` : null,
  ].filter((part): part is string => Boolean(part));

  return {
    id: row.id,
    preferredName: row.preferred_name,
    givenName: row.given_name,
    familyName: row.family_name,
    knownAs: known,
    displayName,
    fullName: full,
    subtitle,
    room: row.room_label,
    dateOfBirth: row.date_of_birth,
    nhsNumber: row.nhs_number,
    photoDocumentId: row.photo_document_id,
    allergyStatus: row.allergy_status,
    allergyCount,
    communicationNeeds,
    accessibilityLabel: spoken.join(". "),
  };
}
