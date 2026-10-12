/**
 * Copies of refused entries on the server (care.md section 6, Device integrity part 5; HZ-006).
 *
 * Every entry in the device's "needs attention" list (`upload_issue`) is sent to
 * `POST /v1/sync/refused-entries` with its content, so a refused entry is never only on one phone:
 * the server keeps a copy, read like the care record, and the nurse in charge gets a review task.
 * The device sends a refusal's copy as soon as it records it, and again after each sync until the
 * server has it; `upload_issue.server_copy` says where each stands. The entry stays on the device
 * all the same, until someone removes it with a recorded reason.
 *
 * The copy carries the request the device made for the entry (`toCareUpload`), which the server
 * checks against that entry kind's own contract (#25 review round 2, M2). An entry that cannot
 * become a valid request, and one the server will not keep, is marked `refused`: the device's
 * report counts it (`copiesRefused`) and the needs-attention list says only this device has it.
 *
 * Entries a deletion that did not finish left (`held_discard_failed`) are never sent: their
 * deletion is on record, and the person chose not to send them.
 */
import type { SyncRefusedEntry } from "@harbour/contracts";
import { isCareEntryTable, toCareUpload } from "./care-upload";
import { type ApiOptions, apiHeaders } from "./discards";

/** The tables a device writes care entries to: the only refusals the server copies. */
export const REFUSED_COPY_TABLES: ReadonlySet<string> = new Set([
  "care_note",
  "observation",
  "body_map_mark",
  "activity_record",
  "visit_log",
]);

/** Needs-attention codes that are never sent to the server. */
export const NOT_COPIED_CODES: ReadonlySet<string> = new Set(["held_discard_failed"]);

/** Where a refusal's server copy stands (`upload_issue.server_copy`). */
export type ServerCopyState = "copied" | "refused" | "not_copied";

/** At most this many copies go in one flush; the rest wait for the next. */
const COPIES_PER_FLUSH = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface UploadIssueRow {
  readonly id: string;
  readonly tenant_id: string | null;
  readonly person_id: string | null;
  readonly record_table: string | null;
  readonly http_status: number | null;
  readonly code: string | null;
  readonly message: string | null;
  readonly payload: string | null;
  readonly rejected_at: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A refusal code the API takes: lower-case letters, digits and underscores, at most 80. */
export function copyCode(code: string | null): string {
  const cleaned = (code ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .slice(0, 80);
  return cleaned.length > 0 ? cleaned : "refused";
}

/**
 * The copy the server takes for a refusal, or why none is sent: an entry that is never copied (a
 * recorded deletion's, or not a care entry: `skip`), or one that cannot become a valid request for
 * its kind (`unbuildable`: only this device has it).
 */
export function toRefusedCopy(
  row: UploadIssueRow,
  now: Date,
):
  | { readonly kind: "copy"; readonly body: SyncRefusedEntry }
  | { readonly kind: "skip" }
  | { readonly kind: "unbuildable" } {
  const table = row.record_table;
  if (!table || !REFUSED_COPY_TABLES.has(table) || !isCareEntryTable(table)) {
    return { kind: "skip" };
  }
  if (row.code && NOT_COPIED_CODES.has(row.code)) return { kind: "skip" };
  if (!UUID.test(row.id)) return { kind: "unbuildable" };
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.payload ?? "{}");
    if (isRecord(parsed)) data = parsed;
  } catch {
    data = {};
  }
  // The request the device made (or would have made) for the entry.
  const request = toCareUpload({
    op: "PUT",
    table,
    id: row.id,
    // The refusal keeps the entry's tenant and person in their own columns too.
    opData: { tenant_id: row.tenant_id, person_id: row.person_id, ...data },
  });
  if (request.kind !== "request") return { kind: "unbuildable" };
  const refusedAt =
    row.rejected_at && !Number.isNaN(Date.parse(row.rejected_at))
      ? new Date(row.rejected_at).toISOString()
      : now.toISOString();
  return {
    kind: "copy",
    body: {
      entryId: row.id.toLowerCase(),
      table,
      personId: row.person_id && UUID.test(row.person_id) ? row.person_id.toLowerCase() : null,
      payload: request.body,
      httpStatus:
        typeof row.http_status === "number" && row.http_status >= 100 && row.http_status <= 599
          ? row.http_status
          : null,
      code: copyCode(row.code),
      message: row.message ? row.message.slice(0, 500) : null,
      refusedAt,
      // The request's shape is the contract's for its table (care-upload.ts builds each from it).
    } as SyncRefusedEntry,
  };
}

/**
 * Sends one copy. copied: the server has it; refused: it will not take it (kept on the device,
 * not sent again); retry: try again later (no network, a server error, a limit, a session that
 * cannot send it now). Never throws. `ownerHeaders` names the owner of handed-over entries.
 */
export async function sendRefusedCopy(
  options: ApiOptions,
  body: SyncRefusedEntry,
  extraHeaders: Record<string, string> = {},
): Promise<"copied" | "refused" | "retry"> {
  try {
    const response = await options.fetch(`${options.apiUrl}/v1/sync/refused-entries`, {
      method: "POST",
      headers: { ...apiHeaders(options), ...extraHeaders },
      credentials: "omit",
      body: JSON.stringify(body),
    });
    if (response.ok) return "copied";
    if (response.status === 401 || response.status === 403 || response.status === 408) {
      return "retry";
    }
    if (response.status === 425 || response.status === 429 || response.status >= 500) {
      return "retry";
    }
    return "refused";
  } catch {
    return "retry";
  }
}

type CopyDb = {
  getAll<T>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<unknown>;
};

export const SET_SERVER_COPY_SQL = "UPDATE upload_issue SET server_copy = ? WHERE id = ?";

/**
 * Sends the copies the server does not have yet, for the session's organisation, oldest first;
 * stops at the first that must wait. Returns how many the server now has. Never throws.
 */
export async function flushRefusedCopies(
  db: CopyDb,
  options: ApiOptions,
  now: Date = new Date(),
  extraHeaders: Record<string, string> = {},
): Promise<number> {
  let rows: UploadIssueRow[];
  try {
    rows = await db.getAll<UploadIssueRow>(
      `SELECT id, tenant_id, person_id, record_table, http_status, code, message, payload,
         rejected_at FROM upload_issue
       WHERE server_copy IS NULL AND tenant_id = ? ORDER BY rejected_at, id LIMIT ?`,
      [options.tenantId, COPIES_PER_FLUSH],
    );
  } catch {
    return 0;
  }
  let copied = 0;
  for (const row of rows) {
    const copy = toRefusedCopy(row, now);
    let state: ServerCopyState;
    if (copy.kind === "skip") {
      state = "not_copied";
    } else if (copy.kind === "unbuildable") {
      // Reported, never silently dropped: only this device has it (#25 review round 2, low).
      state = "refused";
    } else {
      const sent = await sendRefusedCopy(options, copy.body, extraHeaders);
      if (sent === "retry") break;
      state = sent;
      if (sent === "copied") copied += 1;
    }
    await db.execute(SET_SERVER_COPY_SQL, [state, row.id]).catch(() => undefined);
  }
  return copied;
}
