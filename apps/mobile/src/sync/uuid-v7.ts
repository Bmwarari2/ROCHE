/**
 * UUIDv7 (RFC 9562 section 5.7) made on the device for every offline write. The id travels with
 * the entry to the API, which ignores a replay of an id it already holds, so an upload retried
 * after a lost response never creates a second record (care.md section 5, HZ-006).
 *
 * Layout: 48-bit Unix time in milliseconds, version 7, 12 random bits, the RFC variant, 62 random
 * bits. Ids sort by creation time, which keeps the server's indexes compact.
 */

/** Fills `length` bytes from a cryptographically secure source (expo-crypto on the device). */
export type RandomBytes = (length: number) => Uint8Array;

const MAX_TIMESTAMP = 2 ** 48 - 1;

function hex(bytes: Uint8Array, from: number, to: number): string {
  let out = "";
  for (let i = from; i < to; i += 1) out += (bytes[i] ?? 0).toString(16).padStart(2, "0");
  return out;
}

export function uuidV7(nowMs: number, randomBytes: RandomBytes): string {
  if (!Number.isInteger(nowMs) || nowMs < 0 || nowMs > MAX_TIMESTAMP) {
    throw new RangeError("The clock reading cannot be encoded in a UUIDv7");
  }
  const random = randomBytes(16);
  if (random.length < 16) throw new RangeError("UUIDv7 needs 16 random bytes");
  const bytes = Uint8Array.from(random.subarray(0, 16));
  // Bytes 0 to 5: the timestamp, most significant byte first (exact in a double below 2^53).
  for (let i = 0; i < 6; i += 1) {
    bytes[i] = Math.floor(nowMs / 2 ** (8 * (5 - i))) % 256;
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return [
    hex(bytes, 0, 4),
    hex(bytes, 4, 6),
    hex(bytes, 6, 8),
    hex(bytes, 8, 10),
    hex(bytes, 10, 16),
  ].join("-");
}

/** The creation time encoded in a UUIDv7, or null when the id is not a version 7 UUID. */
export function uuidV7Time(id: string): Date | null {
  if (!isUuidV7(id)) return null;
  const digits = id.slice(0, 8) + id.slice(9, 13);
  return new Date(Number.parseInt(digits, 16));
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidV7(id: string): boolean {
  return UUID_V7.test(id);
}
