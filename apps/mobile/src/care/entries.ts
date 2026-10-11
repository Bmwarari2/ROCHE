/**
 * What every point-of-care entry written on the device shares (care.md sections 4 and 6):
 *
 * - a UUIDv7 made on the device, so a replayed upload is ignored by the API;
 * - the event time and the device time (HZ-010, HZ-017);
 * - append-only: a correction is a new entry that supersedes the original with a reason, and both
 *   stay readable (Reg 17). Screens show the latest entry in each chain;
 * - a status a person can read: waiting to upload, saved, or (demo mode) on this device only
 *   (HZ-002, HZ-006). A refused upload is shown separately as "needs attention".
 */
import type { MessageValues } from "@harbour/i18n";
import type { OfflineWindowTable } from "@harbour/sync/client";
import type { MessageKey } from "../i18n/t";

/** API limits from `@harbour/contracts` (`entryInput.correctionReason`); a test keeps them equal. */
export const CORRECTION_REASON_LIMITS = { min: 3, max: 500 } as const;

/** A message for one field, translated by the screen. */
export interface FieldError {
  readonly key: MessageKey;
  readonly values?: MessageValues;
}

export interface EntryContext {
  readonly tenantId: string;
  readonly personId: string;
  /** The person's location from the synced person row; the API sets its own on upload. */
  readonly locationId: string | null;
  /** The signed-in user, shown as the author until the server's copy arrives. */
  readonly userId: string | null;
  /** Days of entries the device keeps: how far back an event may be dated (C4). */
  readonly windowDays?: number | null;
  /** Minutes a typed time may be ahead of the device clock (`sync.clock_drift_flag_minutes`). */
  readonly clockToleranceMinutes?: number | null;
  readonly newId: () => string;
}

export interface Correction {
  readonly supersedesId: string;
  readonly reason: string;
}

export type SqlValue = string | number | null;
export type EntryRow = Readonly<Record<string, SqlValue>>;

/** The columns every entry row starts with. `recorded_at` stays empty until the server's copy. */
export function entryRow(
  context: EntryContext,
  occurredAt: Date,
  deviceTime: Date,
  correction: Correction | null,
): EntryRow {
  return {
    id: context.newId(),
    tenant_id: context.tenantId,
    person_id: context.personId,
    location_id: context.locationId,
    occurred_at: occurredAt.toISOString(),
    device_time: deviceTime.toISOString(),
    recorded_at: null,
    late_entry: 0,
    clock_drift: 0,
    supersedes_id: correction?.supersedesId ?? null,
    correction_reason: correction ? correction.reason.trim() : null,
    created_by: context.userId,
  };
}

/** HZ-017: a correction always says why. */
export function checkCorrectionReason(reason: string): FieldError | null {
  const length = reason.trim().length;
  if (length < CORRECTION_REASON_LIMITS.min) {
    return {
      key: "mobile.correction.reasonRequired",
      values: { min: CORRECTION_REASON_LIMITS.min },
    };
  }
  if (length > CORRECTION_REASON_LIMITS.max) {
    return {
      key: "mobile.correction.reasonTooLong",
      values: { max: CORRECTION_REASON_LIMITS.max },
    };
  }
  return null;
}

/** An INSERT for one entry; column names come from code, never from input. */
export function insertStatement(
  table: OfflineWindowTable,
  row: EntryRow,
): { readonly sql: string; readonly params: SqlValue[] } {
  const columns = Object.keys(row);
  return {
    sql: `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    params: columns.map((c) => row[c] ?? null),
  };
}

export type EntryStatus = "queued" | "saved" | "demo";

/**
 * Saved means the server's copy has replaced the one written here (it carries the server-received
 * time). Until then the entry is waiting to upload. Demo entries never leave the device.
 */
export function entryStatus(
  row: { readonly recorded_at: string | null },
  demo: boolean,
): EntryStatus {
  if (demo) return "demo";
  return row.recorded_at ? "saved" : "queued";
}

/** Icon-plus-word appearance of each status (never colour alone). */
export const ENTRY_STATUS_APPEARANCE: Readonly<
  Record<EntryStatus, { readonly tone: "info" | "success" | "neutral"; readonly icon: string }>
> = {
  queued: { tone: "info", icon: "cloud-upload" },
  saved: { tone: "success", icon: "circle-check" },
  demo: { tone: "neutral", icon: "circle-minus" },
};

/**
 * The latest entry in each correction chain: an entry another entry on the device supersedes is
 * left out of lists (its history stays in the record). Keeps the input order.
 */
export function currentEntries<
  T extends { readonly id: string; readonly supersedes_id: string | null },
>(rows: readonly T[]): T[] {
  const superseded = new Set(rows.flatMap((r) => (r.supersedes_id ? [r.supersedes_id] : [])));
  return rows.filter((r) => !superseded.has(r.id));
}

/** SQLite flags: 1 is true. */
export function flag(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}
