/**
 * Turns a queued clock event or lone-worker action into a request to the API's own route for it
 * (scheduling.md section 18): a clock event to `POST /v1/me/clock-events` (the device's time and
 * the client's UUID; the server keeps its own time too, HZ-010), a lone-worker session start to
 * `POST /v1/lone-worker/sessions` and a lone-worker event to
 * `POST /v1/lone-worker/sessions/{id}/events`. Each carries the client's UUID, so a retry records
 * once. `POST /v1/sync/upload` writes none of them.
 *
 * A duress press is sent as what it is, but anything the phone keeps about it after a refusal
 * ("needs attention") reads as an ordinary check-in (`screenSafePayload`), so the device never
 * shows that duress was pressed (HZ-125).
 *
 * Pure, so the mapping is tested without a device. A change that cannot become a valid request is
 * refused here, with a reason, rather than sent; the connector keeps it as "needs attention".
 */
import { SHIFT_WRITABLE_TABLES, type ShiftWritableTable } from "@harbour/sync/client";
import { t } from "../i18n/t";
import type { CrudEntryLike } from "./connector";

export function isShiftWritableTable(table: string): table is ShiftWritableTable {
  return (SHIFT_WRITABLE_TABLES as readonly string[]).includes(table);
}

export interface ShiftUploadRequest {
  readonly kind: "request";
  readonly table: ShiftWritableTable;
  /** The event's or the session's own id: the idempotency key and "needs attention" id. */
  readonly recordId: string;
  readonly tenantId: string;
  readonly path: string;
  readonly body: Record<string, unknown>;
}

export interface ShiftUploadRefusal {
  readonly kind: "refused";
  readonly table: ShiftWritableTable;
  readonly recordId: string;
  readonly tenantId: string | null;
  readonly code: "shift_change_unreadable";
  readonly message: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLOCK_KINDS = new Set(["in", "out", "break_start", "break_end"]);
const LONE_WORKER_KINDS = new Set(["check_in", "help", "duress", "finish"]);

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parsed(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try {
    const v: unknown = JSON.parse(value);
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isInstant(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

const segment = encodeURIComponent;

/** Maps one queued change to its API request, or says why it cannot be sent. */
export function toShiftUpload(
  entry: CrudEntryLike & { readonly table: ShiftWritableTable },
): ShiftUploadRequest | ShiftUploadRefusal {
  const data = entry.opData ?? {};
  const tenantId = text(data.tenant_id);
  const refused = (): ShiftUploadRefusal => ({
    kind: "refused",
    table: entry.table,
    recordId: entry.id,
    tenantId,
    code: "shift_change_unreadable",
    message: t("mobile.shifts.unreadable"),
  });
  // Both are inserts only: nothing on the phone changes or removes one once queued.
  if (entry.op !== "PUT" || !tenantId || !UUID.test(entry.id)) return refused();

  if (entry.table === "clock_event") {
    const kind = text(data.kind);
    const locationId = text(data.location_id);
    const shiftId = text(data.shift_id);
    const deviceTime = data.device_time;
    if (!kind || !CLOCK_KINDS.has(kind) || !locationId || !UUID.test(locationId)) return refused();
    if (shiftId !== null && !UUID.test(shiftId)) return refused();
    if (!isInstant(deviceTime)) return refused();
    return {
      kind: "request",
      table: entry.table,
      recordId: entry.id,
      tenantId,
      path: "/v1/me/clock-events",
      body: {
        id: entry.id,
        kind,
        locationId,
        shiftId,
        deviceTime: new Date(deviceTime).toISOString(),
        evidence: "none",
        nfcTagRef: null,
      },
    };
  }

  // lone_worker_outbox
  const action = text(data.action);
  const sessionId = text(data.session_id);
  const body = parsed(data.body);
  if (!body || !sessionId || !UUID.test(sessionId)) return refused();
  if (action === "start") {
    // The row's id is the idempotency key: it must be the session's own.
    if (body.id !== sessionId || entry.id !== sessionId) return refused();
    return {
      kind: "request",
      table: entry.table,
      recordId: entry.id,
      tenantId,
      path: "/v1/lone-worker/sessions",
      body,
    };
  }
  // Help with no session on the phone (H-1317): straight to the emergency route. The row's
  // session id is its own id, so the queue keeps one key.
  if (action === "emergency") {
    if (body.kind !== "help" || body.id !== entry.id || sessionId !== entry.id) return refused();
    if (!isInstant(body.deviceAt)) return refused();
    return {
      kind: "request",
      table: entry.table,
      recordId: entry.id,
      tenantId,
      path: "/v1/lone-worker/emergency",
      body: { id: body.id, kind: "help", deviceAt: body.deviceAt, sessionId: null },
    };
  }
  if (action === "event") {
    if (typeof body.kind !== "string" || !LONE_WORKER_KINDS.has(body.kind)) return refused();
    if (body.id !== entry.id || !isInstant(body.deviceAt)) return refused();
    return {
      kind: "request",
      table: entry.table,
      recordId: entry.id,
      tenantId,
      path: `/v1/lone-worker/sessions/${segment(sessionId)}/events`,
      body,
    };
  }
  return refused();
}

/**
 * What the phone keeps of a refused or held change: a duress press kept as an ordinary check-in, so
 * nothing on the device shows that duress was pressed (HZ-125). When the API reached the event and
 * refused it as a check-in, it recorded and alarmed the duress press all the same (scheduling.md
 * section 17.3 rule 8). When it did not (the session unknown or refused, access withdrawn), the
 * duress press raised nothing: the screen then says the session is not with Harbour and that
 * nobody is told, with "call 999" (section 18.4), and an API that accepts help and duress for any
 * session is H-1317's question.
 */
export function screenSafePayload(
  table: ShiftWritableTable,
  payload: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  if (table !== "lone_worker_outbox") return { ...payload };
  const body = parsed(payload.body);
  if (body?.kind !== "duress") return { ...payload };
  return { ...payload, body: JSON.stringify({ ...body, kind: "check_in" }) };
}

/**
 * A help or duress press its session's route refused with 403 or 404 (the session unknown, someone
 * else's, refused at its start) goes again to `POST /v1/lone-worker/emergency`, which records it
 * against the worker and raises the alarm all the same (H-1317; scheduling.md section 17.3 rule
 * 7). Anything else, or a refusal there too, is kept under "needs attention" as before.
 */
export function emergencyRequest(
  request: ShiftUploadRequest,
  status: number,
  /** The refusal's code: only a plain 403 is about the session; a device or sign-in one is not. */
  code = "forbidden",
): ShiftUploadRequest | null {
  if (request.table !== "lone_worker_outbox") return null;
  if (status !== 404 && !(status === 403 && code === "forbidden")) return null;
  const match = /^\/v1\/lone-worker\/sessions\/([^/]+)\/events$/.exec(request.path);
  const kind = request.body.kind;
  if (!match || (kind !== "help" && kind !== "duress")) return null;
  return {
    ...request,
    path: "/v1/lone-worker/emergency",
    body: {
      id: request.body.id,
      kind,
      deviceAt: request.body.deviceAt,
      sessionId: decodeURIComponent(match[1] ?? ""),
    },
  };
}
