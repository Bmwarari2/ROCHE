/**
 * The device's unsent work, told to the server (security review, queue depth): how many entries
 * wait in the upload queue, how many the server refused and how many are held after a session
 * ended, and the age of the oldest. Counts and an age only, never personal data or ids, through
 * `POST /v1/sync/device-report`, which writes an audit event. Without it, a device lost or wiped
 * with unsent work would leave no trace on the server (HZ-006).
 *
 * Sent after each sync when the counts change (or every half hour while anything waits), and as
 * soon as a hold starts, with the hold's start (clinical review round 4, H2). While anything waits,
 * the server keeps one task for the location's Registered Manager, due at the hold's start plus
 * `mobile.held_entries_max_days`, and closes it when a report shows nothing waiting. A hold usually
 * starts because the session ended; the device tries with that session at once (it still works
 * when only the access Care mode needs was withdrawn) and again whenever the app comes back to the
 * foreground or every few minutes while it runs. Until then the report waits in the keystore
 * (counts, times and opaque ids only) and goes with the next session on the device in the same
 * tenant, including one that is refused because the entries are someone else's, under the id of the
 * device that held them. Every report names whose entries they are (opaque ids), so the owner's own
 * sign-in can close the manager's task even when someone else's sign-in raised it, and the
 * locations of the owner's sync scope, where the task goes (clinical review round 6, M1 and M2).
 */
import type { SyncDeviceReport } from "@harbour/contracts";
import { type ApiOptions, apiHeaders } from "./discards";

/** Mirrors `SYNC_DEVICE_REPORT_MAX_LOCATIONS` in `@harbour/contracts`; a test keeps them equal. */
export const MAX_REPORT_LOCATIONS = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

/** Opaque location ids as a report carries them: UUIDs only, each once, at most 50. */
export function reportLocationIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.filter(isUuid).map((id) => id.toLowerCase()))].slice(
    0,
    MAX_REPORT_LOCATIONS,
  );
}

/**
 * The report with whose entries they are and where (clinical review round 6, M1 and M2): the hold's
 * owner, and the locations of their sync scope. Unknown values are left out.
 */
export function withOwner(
  report: SyncDeviceReport,
  ownerTenantUserId: string | null,
  locationIds: readonly string[],
): SyncDeviceReport {
  const locations = reportLocationIds(locationIds);
  return {
    ...report,
    ...(isUuid(ownerTenantUserId) ? { ownerTenantUserId: ownerTenantUserId.toLowerCase() } : {}),
    ...(locations.length > 0 ? { locationIds: locations } : {}),
  };
}

export interface ReportDb {
  getUploadQueueStats(): Promise<{ count: number }>;
  getOptional<T>(sql: string, params?: unknown[]): Promise<T | null>;
  getCrudBatch(limit?: number): Promise<{
    readonly crud: ReadonlyArray<{ readonly opData?: Record<string, unknown> | undefined }>;
  } | null>;
}

const MAX_AGE_SECONDS = 10 * 365 * 24 * 3600;

/** Re-sends an unchanged report this often while anything is waiting. */
export const REPORT_REPEAT_MS = 30 * 60_000;

function instant(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** The oldest of several times, as an age in whole seconds at `now`; null when there is none. */
export function oldestAgeSeconds(
  times: readonly (string | null | undefined)[],
  now: Date,
): number | null {
  const parsed = times.map(instant).filter((t): t is number => t !== null);
  if (parsed.length === 0) return null;
  const age = Math.floor((now.getTime() - Math.min(...parsed)) / 1000);
  return Math.min(Math.max(age, 0), MAX_AGE_SECONDS);
}

/** Counts the unsent work and finds the oldest: the first queued entry, refusal or hold. */
export async function buildDeviceReport(db: ReportDb, now: Date): Promise<SyncDeviceReport> {
  const [stats, refused, held, blocked, first] = await Promise.all([
    db.getUploadQueueStats(),
    db.getOptional<{ count: number; oldest: string | null }>(
      "SELECT COUNT(*) AS count, MIN(rejected_at) AS oldest FROM upload_issue",
    ),
    db.getOptional<{ count: number; oldest: string | null }>(
      "SELECT COUNT(*) AS count, MIN(held_at) AS oldest FROM held_entry",
    ),
    // Entries a failed deletion left, among the refused ones: they keep the manager's task open
    // until someone deals with them (clinical review round 5, C-M3).
    db.getOptional<{ count: number }>(
      "SELECT COUNT(*) AS count FROM upload_issue WHERE code = 'held_discard_failed'",
    ),
    db.getCrudBatch(1),
  ]);
  const queuedAt = first?.crud[0]?.opData?.device_time;
  const heldCount = Number(held?.count ?? 0);
  const heldAt = heldCount > 0 ? instant(held?.oldest) : null;
  return {
    unsent: stats.count,
    refused: Number(refused?.count ?? 0),
    held: heldCount,
    blocked: Number(blocked?.count ?? 0),
    oldestAgeSeconds: oldestAgeSeconds(
      [typeof queuedAt === "string" ? queuedAt : null, refused?.oldest, held?.oldest],
      now,
    ),
    heldSince: heldAt === null ? null : new Date(heldAt).toISOString(),
    reportedAt: now.toISOString(),
  };
}

/**
 * A hold's report when the device could not count what it holds (clinical review round 5, C-M4):
 * at least the entries the marker counted, or one, so the manager's task is raised all the same.
 */
export function fallbackHoldReport(entries: number | null, now: Date): SyncDeviceReport {
  return {
    unsent: 0,
    refused: 0,
    held: Math.max(1, entries ?? 1),
    blocked: 0,
    oldestAgeSeconds: null,
    heldSince: null,
    reportedAt: now.toISOString(),
  };
}

/**
 * The report for a hold that has just started (clinical review round 4, H2): the hold's own start,
 * so the manager's task falls due at the hold's start plus `mobile.held_entries_max_days`.
 */
export function holdReport(report: SyncDeviceReport, heldAt: string): SyncDeviceReport {
  const at = instant(heldAt);
  return at === null ? report : { ...report, heldSince: new Date(at).toISOString() };
}

export interface LastReport {
  readonly counts: string;
  readonly at: number;
}

const countsOf = (report: SyncDeviceReport) => `${report.unsent}/${report.refused}/${report.held}`;

/**
 * Whether to send: always the first time, whenever the counts change, and every half hour while
 * anything waits. A device with nothing waiting says so once.
 */
export function shouldSendReport(
  last: LastReport | null,
  report: SyncDeviceReport,
  now: Date,
): boolean {
  if (!last || last.counts !== countsOf(report)) return true;
  const waiting = report.unsent + report.refused + report.held > 0;
  return waiting && now.getTime() - last.at >= REPORT_REPEAT_MS;
}

export function reportSent(report: SyncDeviceReport, now: Date): LastReport {
  return { counts: countsOf(report), at: now.getTime() };
}

/** Sends a report; true when the server recorded it. Never throws. */
export async function sendDeviceReport(
  options: ApiOptions,
  report: SyncDeviceReport,
): Promise<boolean> {
  try {
    const response = await options.fetch(`${options.apiUrl}/v1/sync/device-report`, {
      method: "POST",
      headers: apiHeaders(options),
      credentials: "omit",
      body: JSON.stringify(report),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------------------------------------
// A report waiting in the keystore (counts only) for the next session in the same tenant
// -------------------------------------------------------------------------------------------------

export const PENDING_REPORT_ITEM = "harbour.device-report.v1";

export interface PendingReport {
  readonly tenantId: string;
  readonly report: SyncDeviceReport;
  /**
   * The device that held the entries (its id when the hold began), so a report sent once the
   * device has a new database still names the right device (clinical review round 6, M1).
   */
  readonly deviceId?: string;
}

export interface PlainStore {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

const whole = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

export function parsePendingReport(raw: string | null): PendingReport | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as {
      tenantId?: unknown;
      deviceId?: unknown;
      report?: Record<string, unknown>;
    };
    const r = value.report ?? {};
    if (typeof value.tenantId !== "string" || !UUID.test(value.tenantId)) return null;
    if (!whole(r.unsent) || !whole(r.refused) || !whole(r.held)) return null;
    if (r.blocked !== undefined && !whole(r.blocked)) return null;
    if (r.oldestAgeSeconds !== null && !whole(r.oldestAgeSeconds)) return null;
    if (typeof r.reportedAt !== "string" || instant(r.reportedAt) === null) return null;
    const heldSince = instant(r.heldSince);
    const report: SyncDeviceReport = {
      unsent: r.unsent,
      refused: r.refused,
      held: r.held,
      blocked: whole(r.blocked) ? r.blocked : 0,
      oldestAgeSeconds: r.oldestAgeSeconds as number | null,
      heldSince: heldSince === null ? null : new Date(heldSince).toISOString(),
      reportedAt: r.reportedAt,
    };
    return {
      tenantId: value.tenantId,
      report: withOwner(
        report,
        isUuid(r.ownerTenantUserId) ? r.ownerTenantUserId : null,
        reportLocationIds(r.locationIds),
      ),
      ...(isUuid(value.deviceId) ? { deviceId: value.deviceId.toLowerCase() } : {}),
    };
  } catch {
    return null;
  }
}

/** The session's options, under the id of the device that held the entries when it is known. */
const asHoldingDevice = (options: ApiOptions, pending: PendingReport): ApiOptions =>
  pending.deviceId ? { ...options, deviceId: pending.deviceId } : options;

/** Sends the report now when it can, otherwise keeps it (counts only) for the next session. */
export async function reportOrKeep(
  store: PlainStore,
  pending: PendingReport,
  options: ApiOptions | null,
): Promise<"sent" | "kept"> {
  if (options && options.tenantId === pending.tenantId) {
    if (await sendDeviceReport(asHoldingDevice(options, pending), pending.report)) {
      await store.remove(PENDING_REPORT_ITEM).catch(() => undefined);
      return "sent";
    }
  }
  await store.write(PENDING_REPORT_ITEM, JSON.stringify(pending)).catch(() => undefined);
  return "kept";
}

/** Sends a waiting report with a session in the same tenant. Never throws. */
export async function flushPendingReport(
  store: PlainStore,
  options: ApiOptions,
): Promise<"sent" | "none" | "kept"> {
  const pending = parsePendingReport(await store.read(PENDING_REPORT_ITEM).catch(() => null));
  if (!pending) return "none";
  if (pending.tenantId !== options.tenantId) return "kept";
  if (!(await sendDeviceReport(asHoldingDevice(options, pending), pending.report))) return "kept";
  await store.remove(PENDING_REPORT_ITEM).catch(() => undefined);
  return "sent";
}
