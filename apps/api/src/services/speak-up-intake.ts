import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import type { Transaction } from "@harbour/db";
import { sql } from "drizzle-orm";

/**
 * Public speak-up intake limits (ADR-0089; security review H1 and L6). Counted in Postgres
 * (`speak_up_intake`), so every API instance and every deploy shares them:
 * - per network: an IPv6 /64 (one household or phone gets a whole /64) or an IPv4 address, held
 *   only as an HMAC keyed by a secret from the managed store and the UK date, so it can neither be
 *   reversed nor followed from one day to the next;
 * - per organisation per minute, which also covers requests that carry no usable address;
 * - anonymous concerns per organisation per UK day: past it, the lead's list says "possible flood".
 */

/** The network an address belongs to: its IPv6 /64, or the IPv4 address. Null when unusable. */
export function networkOf(address: string | null): string | null {
  if (!address) return null;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped?.[1]) return isIP(mapped[1]) === 4 ? mapped[1] : null;
  const family = isIP(address);
  if (family === 4) return address;
  if (family !== 6) return null;
  const [head = "", tail = ""] = address.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = address.includes("::")
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : left;
  if (groups.length !== 8) return null;
  return `${groups
    .slice(0, 4)
    .map((g) => g.padStart(4, "0"))
    .join(":")}::/64`;
}

/** The network's bucket: an HMAC of the network and the UK date, never the address itself. */
export function networkBucket(secret: string, network: string, ukDate: string): string {
  return `net:${createHmac("sha256", secret).update(`${ukDate}|${network}`).digest("hex")}`;
}

/** The start of the current UK day, as Postgres works it out (shared by the count and the lead's view). */
export const UK_DAY_START = sql`(date_trunc('day', now() AT TIME ZONE 'Europe/London') AT TIME ZONE 'Europe/London')`;

export type IntakeBucket =
  | { readonly kind: "network"; readonly bucket: string; readonly limit: number }
  | { readonly kind: "tenant"; readonly limit: number }
  | { readonly kind: "day"; readonly limit: number };

/**
 * Counts one request against each bucket in turn and returns the first one now over its limit,
 * or null; buckets after it are not counted, so a network held back never uses up the
 * organisation's daily count.
 * Run in a public request's transaction of its own, so the count stands even when the request
 * itself then fails (a wrong token, say).
 */
export async function countIntake(
  tx: Transaction,
  buckets: readonly IntakeBucket[],
): Promise<IntakeBucket | null> {
  for (const b of buckets) {
    const bucket = b.kind === "network" ? b.bucket : b.kind;
    const window =
      b.kind === "day"
        ? sql`${UK_DAY_START}, ${UK_DAY_START} + interval '1 day'`
        : sql`date_trunc('minute', now()), date_trunc('minute', now()) + interval '1 minute'`;
    const result = await tx.execute<{ hits: number }>(sql`
      INSERT INTO speak_up_intake (bucket, window_start, window_end, hits)
      VALUES (${bucket}, ${window}, 1)
      ON CONFLICT (tenant_id, bucket, window_start)
      DO UPDATE SET hits = speak_up_intake.hits + 1
      RETURNING hits`);
    const hits = Number(result.rows[0]?.hits ?? 0);
    if (hits > b.limit) return b;
  }
  return null;
}

/** Today's anonymous concerns against the cap, for the lead: null when under it. */
export async function possibleFlood(
  tx: Transaction,
  cap: number,
): Promise<{ readonly count: number; readonly cap: number } | null> {
  const result = await tx.execute<{ hits: number }>(sql`
    SELECT hits FROM speak_up_intake WHERE bucket = 'day' AND window_start = ${UK_DAY_START}`);
  const count = Number(result.rows[0]?.hits ?? 0);
  return count >= cap ? { count, cap } : null;
}
