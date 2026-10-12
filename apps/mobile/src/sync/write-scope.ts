/**
 * Where this phone may record (ADR-0071 review round 2, C2-M3). The sync token carries where the
 * user's care.note.write reaches: `entries_write_location_ids` (homes where they may record about
 * everyone) and `entries_write_assigned` (they may record about the people they are assigned to),
 * with `people_location_ids`, the homes whose people sync in full. A coordinator's phone holds
 * people it may read but not record on; the person screen offers recording only where the server
 * would take it, so nothing is written that would be refused with no copy kept.
 *
 * The phone cannot tell an assigned person from one synced through their home, so a person is
 * taken as assigned only when their home is not one that syncs in full: one who is both assigned
 * and at a home where the user may only read is shown as read only (fails closed); the API decides
 * either way. Before any token has been seen (an app updated while offline), nothing is known and
 * recording is offered as before.
 */

export interface WriteScope {
  /** Homes where the user may record about everyone. */
  readonly locationIds: readonly string[];
  /** Whether the user may record about the people they are assigned to. */
  readonly assigned: boolean;
  /** Homes whose people sync to the phone in full. */
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
  const peopleLocationIds = strings(record.people_location_ids);
  if (locationIds === null || typeof record.entries_write_assigned !== "boolean") return null;
  return {
    locationIds,
    assigned: record.entries_write_assigned,
    peopleLocationIds: peopleLocationIds ?? [],
  };
}

/** Whether the phone offers recording about a person at `locationId` (see the module comment). */
export function mayRecordFor(locationId: string | null, scope: WriteScope | null): boolean {
  if (scope === null) return true;
  if (locationId !== null && scope.locationIds.includes(locationId)) return true;
  if (!scope.assigned) return false;
  return locationId === null || !scope.peopleLocationIds.includes(locationId);
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
    const peopleLocationIds = strings(value.peopleLocationIds);
    if (locationIds === null || peopleLocationIds === null || typeof value.assigned !== "boolean") {
      return null;
    }
    return { locationIds, assigned: value.assigned, peopleLocationIds };
  } catch {
    return null;
  }
}
