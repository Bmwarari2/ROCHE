/**
 * Each nation's shift pattern, from the sync token (`handover_shifts`, ADR-0074; screens gate item
 * (e)): the day and night start times, minutes after midnight UK time, from the rate table, for the
 * nations the organisation has homes in, where the handover family reaches. The phone keeps the
 * last one it was given in the encrypted database's bookkeeping, so it can work out offline which
 * handover it should hold (`care/handover-view.ts`). A nation the token leaves out, or figures the
 * phone cannot read, leave that nation unknown: the handover screen then says it cannot tell,
 * rather than guess (HZ-018, H-303).
 *
 * The figures are statutory-free and carry no personal data; they are read, never verified (the API
 * signs the token for PowerSync, which checks it).
 */
import { decodeTokenClaims } from "./write-scope";

export interface NationShifts {
  readonly day: number;
  readonly night: number;
}

export type HandoverShifts = Readonly<Record<string, NationShifts>>;

/** `sync_meta` row holding the last pattern a token carried. */
export const HANDOVER_SHIFTS_META_ID = "meta:handover-shifts";
export const HANDOVER_SHIFTS_META_KEY = "handover_shifts";

const MINUTES_IN_DAY = 24 * 60;

function minute(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < MINUTES_IN_DAY
    ? value
    : null;
}

/**
 * The readable nations of a `handover_shifts` value; a nation whose figures are missing, out of
 * range or equal (no shift between them) is left out. Null when the value is not an object.
 */
export function parseHandoverShifts(value: unknown): HandoverShifts | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const shifts: Record<string, NationShifts> = {};
  for (const [nation, figures] of Object.entries(value as Record<string, unknown>)) {
    if (typeof figures !== "object" || figures === null) continue;
    const day = minute((figures as Record<string, unknown>).day);
    const night = minute((figures as Record<string, unknown>).night);
    if (day === null || night === null || day === night) continue;
    shifts[nation] = { day, night };
  }
  return shifts;
}

/** The pattern a sync token carries; null when it carries none (nothing changes). */
export function handoverShiftsFromToken(token: string): HandoverShifts | null {
  const claims = decodeTokenClaims(token);
  if (claims === null || !("handover_shifts" in claims)) return null;
  return parseHandoverShifts(claims.handover_shifts);
}

/** Reads and writes `sync_meta` (the PowerSync database or a transaction). */
export interface ShiftsMetaStore {
  getOptional<T>(sql: string, params?: unknown[]): Promise<T | null>;
  execute(sql: string, params?: unknown[]): Promise<unknown>;
}

/** The pattern kept on the phone; null when none is kept or it cannot be read. */
export async function readCachedHandoverShifts(
  db: ShiftsMetaStore,
): Promise<HandoverShifts | null> {
  const row = await db
    .getOptional<{ value: string }>("SELECT value FROM sync_meta WHERE id = ?", [
      HANDOVER_SHIFTS_META_ID,
    ])
    .catch(() => null);
  if (!row?.value) return null;
  try {
    return parseHandoverShifts(JSON.parse(row.value));
  } catch {
    return null;
  }
}

/** Keeps the pattern a new token carries in place of the last one. */
export async function writeCachedHandoverShifts(
  db: ShiftsMetaStore,
  shifts: HandoverShifts,
): Promise<void> {
  await db.execute("DELETE FROM sync_meta WHERE id = ?", [HANDOVER_SHIFTS_META_ID]);
  await db.execute("INSERT INTO sync_meta (id, key, value) VALUES (?, ?, ?)", [
    HANDOVER_SHIFTS_META_ID,
    HANDOVER_SHIFTS_META_KEY,
    JSON.stringify(shifts),
  ]);
}
