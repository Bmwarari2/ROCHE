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
  /**
   * `handover.preview_lead_minutes` (H-420): within this many minutes before a shift ends, the
   * handover screen shows the running shift's own handover first. Absent when the token left it
   * out or the phone cannot read it: the screen then shows the handover the shift received first.
   */
  readonly lead?: number;
}

export type HandoverShifts = Readonly<Record<string, NationShifts>>;

/** `sync_meta` row holding the last pattern a token carried. */
export const HANDOVER_SHIFTS_META_ID = "meta:handover-shifts";
export const HANDOVER_SHIFTS_META_KEY = "handover_config";

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
    const lead = minute((figures as Record<string, unknown>).lead);
    shifts[nation] = lead === null ? { day, night } : { day, night, lead };
  }
  return shifts;
}

/**
 * What the phone knows about the handover from its last sync token: each nation's shift pattern,
 * and where the handover streams reach (`handover_location_ids`: homes whose handovers it receives
 * whole; `handover_assigned`: also those where a person assigned to the reader lives), so the screen
 * lists only homes whose handover the phone can receive (clinical review of the handover screen,
 * M2) and never says "not compiled yet" for one it never could.
 */
export interface HandoverConfig {
  readonly shifts: HandoverShifts;
  readonly locationIds: readonly string[];
  readonly assigned: boolean;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

function parseConfig(record: Record<string, unknown>): HandoverConfig | null {
  const shifts = parseHandoverShifts(record.shifts ?? record.handover_shifts) ?? {};
  const locationIds = strings(record.locationIds ?? record.handover_location_ids);
  const assigned = (record.assigned ?? record.handover_assigned) === true;
  if (locationIds.length === 0 && !assigned) return null;
  return { shifts, locationIds, assigned };
}

/**
 * The handover reach and pattern a sync token carries; null when the handover family does not reach
 * the phone (no homes and not assigned), when the cached copy is then cleared.
 */
export function handoverConfigFromToken(token: string): HandoverConfig | null {
  const claims = decodeTokenClaims(token);
  return claims === null ? null : parseConfig(claims);
}

/** Reads and writes `sync_meta` (the PowerSync database or a transaction). */
export interface ShiftsMetaStore {
  getOptional<T>(sql: string, params?: unknown[]): Promise<T | null>;
  execute(sql: string, params?: unknown[]): Promise<unknown>;
}

/** Parses the kept copy (`sync_meta`); null when none or unreadable. */
export function parseCachedHandoverConfig(value: string | null | undefined): HandoverConfig | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parseConfig(parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The copy kept on the phone; null when none is kept or it cannot be read. */
export async function readCachedHandoverConfig(
  db: ShiftsMetaStore,
): Promise<HandoverConfig | null> {
  const row = await db
    .getOptional<{ value: string }>("SELECT value FROM sync_meta WHERE id = ?", [
      HANDOVER_SHIFTS_META_ID,
    ])
    .catch(() => null);
  return parseCachedHandoverConfig(row?.value);
}

/**
 * Keeps what a new token carries in place of the last; a token whose handover family does not reach
 * the phone clears it, so an old pattern or reach is never used (clinical review L1).
 */
export async function writeCachedHandoverConfig(
  db: ShiftsMetaStore,
  config: HandoverConfig | null,
): Promise<void> {
  await db.execute("DELETE FROM sync_meta WHERE id = ?", [HANDOVER_SHIFTS_META_ID]);
  if (config === null) return;
  await db.execute("INSERT INTO sync_meta (id, key, value) VALUES (?, ?, ?)", [
    HANDOVER_SHIFTS_META_ID,
    HANDOVER_SHIFTS_META_KEY,
    JSON.stringify(config),
  ]);
}
