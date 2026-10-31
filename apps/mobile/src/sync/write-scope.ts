/**
 * Where this phone may record (ADR-0071 review rounds 2 and 3, C2-M3 and C3-M2). The sync token
 * carries where the user's care.note.write reaches: `entries_write_location_ids` (homes where they
 * may record about everyone), `entries_write_assigned` (they may record about the people they are
 * assigned to) and `entries_write_person_ids` (those people, by id). A coordinator's phone holds
 * people it may read but not record on; the person screen offers recording only where the server
 * would take it, so nothing is written that would be refused with no copy kept.
 *
 * A coordinator who is also a care worker records about the people assigned to them wherever
 * they live, even at a home whose people sync to the phone for reading only: the phone decides
 * per person from the ids. A token that does not name the people (more than it carries, or one
 * from before) falls back to the location rule (review round 4): a person is taken as assigned
 * only when their home is not one whose people sync in full (`people_location_ids`), so one at a
 * home the user may only read is shown read only (fails closed); the API decides either way.
 *
 * While no scope is known (none kept since the last token, one that could not be kept or read,
 * or an app updated while offline before its first token), the phone records about no one and
 * says why (review round 5): it never guesses from the user's permissions.
 */

export interface WriteScope {
  /** Homes where the user may record about everyone. */
  readonly locationIds: readonly string[];
  /** Whether the user may record about the people they are assigned to. */
  readonly assigned: boolean;
  /** The people the user is assigned to, or null when the token did not name them. */
  readonly personIds: readonly string[] | null;
  /** Homes whose people sync to the phone in full (for the location rule when no ids are named). */
  readonly peopleLocationIds: readonly string[];
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Decodes base64url to text (UTF-8), or null when it is not valid. */
function decodeBase64Url(input: string): string | null {
  const clean = input.replace(/-/g, "+").replace(/_/g, "/");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    if (char === "=") break;
    const value = BASE64.indexOf(char);
    if (value < 0) return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  try {
    return decodeURIComponent(bytes.map((b) => `%${b.toString(16).padStart(2, "0")}`).join(""));
  } catch {
    return null;
  }
}

/**
 * A sync token's claims, read from its payload without verifying it (PowerSync and the API do);
 * null when the token cannot be read.
 */
export function decodeTokenClaims(token: string): Record<string, unknown> | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  const text = decodeBase64Url(payload);
  if (text === null) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(text);
  } catch {
    return null;
  }
  return typeof claims === "object" && claims !== null && !Array.isArray(claims)
    ? (claims as Record<string, unknown>)
    : null;
}

const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((v) => typeof v === "string") ? [...value] : null;

/**
 * The write scope a sync token carries, read from its payload (the phone does not verify the
 * signature: PowerSync and the API do; this only decides what to offer). Null when the token has
 * no write claims or cannot be read.
 */
export function writeScopeFromToken(token: string): WriteScope | null {
  const record = decodeTokenClaims(token);
  if (record === null) return null;
  const locationIds = strings(record.entries_write_location_ids);
  if (locationIds === null || typeof record.entries_write_assigned !== "boolean") return null;
  return {
    locationIds,
    assigned: record.entries_write_assigned,
    personIds: strings(record.entries_write_person_ids),
    peopleLocationIds: strings(record.people_location_ids) ?? [],
  };
}

/**
 * Whether the phone offers recording about a person (see the module comment): never while no
 * scope is known.
 */
export function mayRecordFor(
  person: { readonly id: string; readonly locationId: string | null },
  scope: WriteScope | null,
): boolean {
  if (scope === null) return false;
  if (person.locationId !== null && scope.locationIds.includes(person.locationId)) return true;
  if (!scope.assigned) return false;
  if (scope.personIds !== null) return scope.personIds.includes(person.id);
  // No ids named (more than the token carries): the location rule (review rounds 2 and 4).
  return person.locationId === null || !scope.peopleLocationIds.includes(person.locationId);
}

/** Stored form of the scope (plain JSON), so it is known again after a restart while offline. */
export function serialiseWriteScope(scope: WriteScope): string {
  return JSON.stringify(scope);
}

export function parseStoredWriteScope(text: string | null): WriteScope | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const locationIds = strings(value.locationIds);
    if (locationIds === null || typeof value.assigned !== "boolean") return null;
    return {
      locationIds,
      assigned: value.assigned,
      personIds: strings(value.personIds),
      peopleLocationIds: strings(value.peopleLocationIds) ?? [],
    };
  } catch {
    return null;
  }
}
