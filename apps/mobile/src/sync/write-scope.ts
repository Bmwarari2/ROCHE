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
 * Before any token has been seen (an app updated while offline), recording is offered only when
 * the user's permissions, as last read, include care.note.write; with no permissions known, as
 * before.
 */

/** The permission recording needs (notes, charts, body map marks). */
export const RECORD_PERMISSION = "care.note.write";

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

/**
 * A scope that records about no one: where the phone may record could not be kept, so it offers
 * nothing until the next token (review round 4).
 */
export const NO_WRITE_SCOPE: WriteScope = {
  locationIds: [],
  assigned: false,
  personIds: [],
  peopleLocationIds: [],
};

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

const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((v) => typeof v === "string") ? [...value] : null;

/**
 * The write scope a sync token carries, read from its payload (the phone does not verify the
 * signature: PowerSync and the API do; this only decides what to offer). Null when the token has
 * no write claims or cannot be read.
 */
export function writeScopeFromToken(token: string): WriteScope | null {
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
  if (typeof claims !== "object" || claims === null) return null;
  const record = claims as Record<string, unknown>;
  const locationIds = strings(record.entries_write_location_ids);
  if (locationIds === null || typeof record.entries_write_assigned !== "boolean") return null;
  return {
    locationIds,
    assigned: record.entries_write_assigned,
    personIds: strings(record.entries_write_person_ids),
    peopleLocationIds: strings(record.people_location_ids) ?? [],
  };
}

/** Whether the phone offers recording about a person (see the module comment). */
export function mayRecordFor(
  person: { readonly id: string; readonly locationId: string | null },
  scope: WriteScope | null,
  permissions: readonly string[] | null = null,
): boolean {
  if (scope === null) return permissions === null || permissions.includes(RECORD_PERMISSION);
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
