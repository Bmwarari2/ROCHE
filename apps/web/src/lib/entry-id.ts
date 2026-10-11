/**
 * Client ids for append-only entries (master prompt section 6: client UUIDs and idempotent
 * inserts; hazard HZ-029). A form makes one UUIDv7 per entry and sends it with every attempt, so
 * when the outcome of a save is unknown (the network dropped), trying again cannot make a second
 * entry: the API keeps the first and ignores the replay. A new id is made only after a save.
 */

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** A UUIDv7 (RFC 9562): 48 bits of milliseconds, the version, then random bits. */
export function uuidv7(
  now: number = Date.now(),
  random: Uint8Array = crypto.getRandomValues(new Uint8Array(10)),
): string {
  const bytes = new Uint8Array(16);
  let time = Math.floor(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = time % 256;
    time = Math.floor(time / 256);
  }
  bytes[6] = 0x70 | ((random[0] ?? 0) & 0x0f);
  bytes[7] = random[1] ?? 0;
  bytes[8] = 0x80 | ((random[2] ?? 0) & 0x3f);
  for (let index = 9; index < 16; index += 1) bytes[index] = random[index - 6] ?? 0;
  const text = hex(bytes);
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}
