/**
 * Display rules for a person's identity and safety flags. Wrong-person selection (hazard HZ-001)
 * is mitigated by always showing two identifiers; allergy display (HZ-007) never turns "nothing
 * recorded" into "no allergies".
 */

export interface PersonNameParts {
  readonly preferredName?: string | null;
  readonly givenName?: string | null;
  readonly familyName?: string | null;
}

function clean(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/** First letter (any script) of a name part, upper-cased in British English. */
function firstLetter(value: string): string {
  const match = /\p{L}/u.exec(value);
  return match ? match[0].toLocaleUpperCase("en-GB") : "";
}

/**
 * Up to two initials for the avatar fallback: the name the person is known by, then the family
 * name. "Ada Example" gives "AE". Returns an empty string when no letters are available, so the
 * caller can show a generic person icon instead of a misleading character.
 */
export function initialsFor(name: PersonNameParts): string {
  const known = clean(name.preferredName) || clean(name.givenName);
  const family = clean(name.familyName);
  const first = firstLetter(known);
  const last = firstLetter(family);
  return `${first}${last}`;
}

/** The name a person is known by, falling back to their given name. */
export function knownAsName(name: PersonNameParts): string {
  return clean(name.preferredName) || clean(name.givenName) || clean(name.familyName);
}

/** Full legal-style name: given name then family name. */
export function fullName(name: PersonNameParts): string {
  return [clean(name.givenName), clean(name.familyName)].filter(Boolean).join(" ");
}

/**
 * Formats a 10-digit NHS number as "999 000 0018" (the NHS display format).
 * Anything that is not exactly 10 digits is returned unchanged so it is never silently altered.
 */
export function formatNhsNumber(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\s+/g, "");
  if (!/^\d{10}$/.test(digits)) return value;
  return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
}

/** Validates the NHS number modulus 11 check digit. */
export function isValidNhsNumber(value: string): boolean {
  const digits = value.replace(/\s+/g, "");
  if (!/^\d{10}$/.test(digits)) return false;
  let total = 0;
  for (let i = 0; i < 9; i += 1) {
    total += Number(digits[i]) * (10 - i);
  }
  const raw = 11 - (total % 11);
  const check = raw === 11 ? 0 : raw;
  if (check === 10) return false;
  return check === Number(digits[9]);
}

/** Values of `person.allergy_status` from the sync schema. */
export type AllergyStatus = "unknown" | "no_known_allergies" | "has_allergies";

export interface AllergyFlag {
  readonly tone: "danger" | "warning" | "neutral";
  /** Lucide icon name. */
  readonly icon: "triangle-alert" | "circle-help" | "circle-minus";
  readonly label: string;
  readonly accessibilityLabel: string;
  /** Lists hide only the calm "No known allergies" state, to limit alert fatigue (HZ-005). */
  readonly showInLists: boolean;
}

/** Anything other than a recognised value is treated as unknown, never as "none". */
export function parseAllergyStatus(value: string | null | undefined): AllergyStatus {
  return value === "no_known_allergies" || value === "has_allergies" ? value : "unknown";
}

/**
 * Allergy flag (hazard HZ-007: incorrect allergy display). Three recorded states are kept apart:
 * - allergy rows on the device always win and show "Allergies (n)", whatever the status says;
 * - "has_allergies" without rows on the device still shows danger, never a calm state;
 * - "no_known_allergies" is a recorded clinical statement: "No known allergies";
 * - "unknown" (or anything unrecognised) is a warning: "Allergies not recorded".
 */
export function describeAllergyFlag(
  status: string | null | undefined,
  activeAllergyCount: number,
): AllergyFlag {
  const parsed = parseAllergyStatus(status);
  if (activeAllergyCount > 0) {
    return {
      tone: "danger",
      icon: "triangle-alert",
      label: `Allergies (${activeAllergyCount})`,
      accessibilityLabel:
        activeAllergyCount === 1
          ? "Allergies: 1 allergy recorded"
          : `Allergies: ${activeAllergyCount} allergies recorded`,
      showInLists: true,
    };
  }
  if (parsed === "has_allergies") {
    return {
      tone: "danger",
      icon: "triangle-alert",
      label: "Allergies (details not on device)",
      accessibilityLabel:
        "Allergies recorded. The details have not reached this device yet; check the full record.",
      showInLists: true,
    };
  }
  if (parsed === "no_known_allergies") {
    return {
      tone: "neutral",
      icon: "circle-minus",
      label: "No known allergies",
      accessibilityLabel: "No known allergies",
      showInLists: false,
    };
  }
  return {
    tone: "warning",
    icon: "circle-help",
    label: "Allergies not recorded",
    accessibilityLabel: "Allergies not recorded. Check before giving food or medicines.",
    showInLists: true,
  };
}

/**
 * A further safety flag for the point-of-care header or a list row, worded by the app through its
 * message catalogue: for example the resuscitation status (HZ-015) or the prescribed IDDSI level
 * (HZ-016). Shown as an icon plus words, never colour alone.
 */
export interface HeaderFlag {
  /** Stable key, also used in the test id. */
  readonly key: string;
  readonly tone: "danger" | "warning" | "success" | "info" | "neutral";
  /** A Lucide icon name from `namedIcons`; an unknown name shows the alert circle. */
  readonly icon: string;
  readonly label: string;
  /** Spoken instead of the label when the label alone would be ambiguous. */
  readonly accessibilityLabel?: string;
}

/** Communication-needs flag wording (Accessible Information Standard). */
export function communicationFlagLabel(count: number): string {
  if (count <= 0) return "";
  return count === 1 ? "Communication need" : `Communication needs (${count})`;
}
