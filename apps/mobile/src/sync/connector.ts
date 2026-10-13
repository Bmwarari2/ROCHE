/**
 * PowerSync backend connector for the Harbour API.
 *
 * - fetchCredentials: exchanges the Better Auth session for a short-lived PowerSync token
 *   (`POST /v1/sync/token`), in the session's organisation. A 401 means the session expired or was
 *   revoked elsewhere. A 403 `device_revoked`, on the token or any upload, means a manager revoked
 *   this device, which the vault treats as a remote wipe (`onDeviceRevoked`). A 403 whose problem
 *   body comes from the API (a session code, or any other code such as `missing_permission`) means
 *   the session or the access Care mode needs has gone; a
 *   403 with no body, an HTML page or the edge's `edge_blocked` is checked with `GET /v1/me` first
 *   (`session-signals.ts`). The connector reports an ended session and the vault decides (HZ-006,
 *   `held-work.ts`): wipe when nothing is waiting to upload, otherwise hold the unsent entries for
 *   their owner. Otherwise it backs off and tries again.
 * - uploadData: sends the next local transaction. Care entries (notes, chart observations,
 *   body-map marks, activities and visits) go one by one to the API's own endpoints for them
 *   (`care-upload.ts`) with the device's UUIDv7, the device id, the tenant and the time the device
 *   sent the request (`x-harbour-sent-at`), so the server computes late-entry and clock-drift flags
 *   correctly (HZ-010, HZ-017) and ignores a replay. A task's move and a handover acknowledgement
 *   go to their own routes (`round-upload.ts`). Anything else goes to `POST /v1/sync/upload`.
 *
 * Transient failures (no network, 408, 425, 429, 5xx) are retried with backoff and then left
 * queued for PowerSync to retry. The API is authoritative: when it refuses an entry for good (for
 * example the person's record closed while the device was offline) the entry moves, with its
 * content, to the local-only `upload_issue` table and the queue moves on, so one refusal never
 * blocks later entries and nothing is lost silently (HZ-006). Screens show those entries as "not
 * saved: needs attention" until someone deals with them, and the content goes to the server's copy
 * of refused entries (`onRefused`, `refused-copies.ts`), so it is never only on one phone.
 */

import type { RoundWritableTable } from "@harbour/sync/client";
import type {
  CommonPowerSyncDatabase,
  PowerSyncBackendConnector,
  PowerSyncCredentials,
} from "@powersync/common";
import { type FetchLike, HttpError, isRetryableStatus, parseRetryAfter } from "../auth/http";
import { t } from "../i18n/t";
import {
  type BackoffPolicy,
  type RetryDecision,
  retryWithBackoff,
  UPLOAD_BACKOFF,
} from "./backoff";
import { isCareEntryTable, toCareUpload } from "./care-upload";
import {
  isRoundWritableTable,
  type RoundMove,
  roundRefusalMessage,
  settleMove,
  type TaskState,
  taskStateIn,
  taskStatePath,
  toRoundUpload,
} from "./round-upload";
import {
  checkSession,
  classifyForbidden,
  readProblemBody,
  type SessionCheck,
  TENANT_HEADER,
} from "./session-signals";
import { type WriteScope, writeScopeFromToken } from "./write-scope";

export type UploadOp = "PUT" | "PATCH" | "DELETE";

export interface UploadOperation {
  readonly op: UploadOp;
  readonly table: string;
  readonly id: string;
  readonly data: Record<string, unknown>;
}

/** The parts of a PowerSync CrudEntry the connector needs. */
export interface CrudEntryLike {
  readonly op: string;
  readonly table: string;
  readonly id: string;
  readonly opData?: Record<string, unknown> | undefined;
}

/** The parts of the PowerSync database the connector needs, so tests can supply a fake. */
export type UploadSource = Pick<
  CommonPowerSyncDatabase,
  "getNextCrudTransaction" | "getClientId" | "execute"
>;

/** Request headers the API reads (`@harbour/contracts` and `apps/api/src/routes/care-shared.ts`). */
export { TENANT_HEADER };
export const DEVICE_HEADER = "x-harbour-device";
export const SENT_AT_HEADER = "x-harbour-sent-at";

/** The device's session was revoked (sign-out elsewhere, device reported lost, account disabled). */
export class SessionRevokedError extends Error {
  constructor() {
    super("The session is no longer valid");
    this.name = "SessionRevokedError";
  }
}

/**
 * A manager revoked this device (403 `device_revoked`; care.md section 6, Device integrity part 2).
 * An ended session all the same, so nothing is parked or retried, but the vault reacts to it as to
 * a remote wipe.
 */
export class DeviceRevokedError extends SessionRevokedError {
  constructor() {
    super();
    this.message = "This device has been withdrawn from Harbour";
    this.name = "DeviceRevokedError";
  }
}

/** The API refused the upload for good; it moves to "needs attention" on the device. */
export class UploadRejectedError extends Error {
  readonly status: number;
  readonly code: string;
  readonly reason: string | null;

  constructor(status: number, code = "rejected", reason: string | null = null) {
    super(`The server rejected queued changes (HTTP ${status})`);
    this.name = "UploadRejectedError";
    this.status = status;
    this.code = code;
    this.reason = reason;
  }
}

/**
 * How long a move's follow-up check (reading the task after a 409) may keep being refused before
 * the move is parked as "needs attention" and the queue carries on: 5 refused reads, or 30 minutes
 * from the first, whichever comes first. A move left at the head of the queue would hold back the
 * notes and charts behind it (HZ-006; #37 review round 1). Only a read the server answered with a
 * refusal that is not about the session counts (a 403 on the task list, a 404, an answer that
 * cannot be read); no network, a timeout or a 5xx neither counts nor starts the clock, because
 * nothing else in the queue can upload then either, so the move just stays queued (#37 review
 * round 2, N1). The count is kept in memory, so a restart of the app starts it again (at most 5
 * more reads), and it is cleared when the session ends, before a hold or a wipe takes the move.
 */
export const TASK_CHECK_MAX_FAILURES = 5;
export const TASK_CHECK_MAX_MS = 30 * 60 * 1000;

/**
 * Whether a failed follow-up check was a refusal the server answered, not about the session: any
 * status the upload does not retry (a 403 on the task list, a 404, an answer it cannot read). No
 * network, a timeout, a 429 or a 5xx is not, and an ended session is never counted.
 */
function isAnsweredRefusal(error: unknown): boolean {
  return error instanceof HttpError && !isRetryableStatus(error.status);
}

/** The move's follow-up check was refused past its cap: the move is parked, never dropped. */
class TaskCheckGaveUp extends Error {
  constructor() {
    super("The task could not be checked; the move is kept as needing attention");
    this.name = "TaskCheckGaveUp";
  }
}

const OPS = new Set<UploadOp>(["PUT", "PATCH", "DELETE"]);

export function toUploadOperation(entry: CrudEntryLike): UploadOperation {
  if (!OPS.has(entry.op as UploadOp)) {
    throw new Error(`Unsupported CRUD operation: ${entry.op}`);
  }
  return {
    op: entry.op as UploadOp,
    table: entry.table,
    id: entry.id,
    data: entry.op === "DELETE" ? {} : { ...(entry.opData ?? {}) },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates the `/v1/sync/token` response. */
export function parseSyncCredentials(value: unknown): PowerSyncCredentials {
  if (
    !isRecord(value) ||
    typeof value.token !== "string" ||
    value.token.length === 0 ||
    typeof value.endpoint !== "string" ||
    !/^https?:\/\//.test(value.endpoint)
  ) {
    throw new Error("Malformed sync token response");
  }
  let expiresAt: Date | undefined;
  if (typeof value.expiresAt === "string" || typeof value.expiresAt === "number") {
    const parsed = new Date(value.expiresAt);
    if (!Number.isNaN(parsed.getTime())) expiresAt = parsed;
  }
  return { endpoint: value.endpoint, token: value.token, expiresAt };
}

/** Network failures and retryable statuses are transient; everything else is not. */
export function classifyUploadError(error: unknown): RetryDecision {
  if (error instanceof SessionRevokedError || error instanceof UploadRejectedError) {
    return { retry: false };
  }
  if (error instanceof HttpError) {
    return isRetryableStatus(error.status)
      ? { retry: true, afterMs: error.retryAfterMs }
      : { retry: false };
  }
  // fetch rejects with TypeError when the network is unavailable.
  return { retry: true };
}

/**
 * Reads RFC 9457 problem details from a refusal: the code, and the API's plain-English reason
 * (the detail when there is one, otherwise the title). Never throws.
 */
export async function readProblem(
  response: Response,
): Promise<{ readonly code: string; readonly reason: string | null }> {
  try {
    const body: unknown = await response.json();
    if (!isRecord(body)) return { code: `http_${response.status}`, reason: null };
    const code = typeof body.code === "string" ? body.code : `http_${response.status}`;
    const detail = typeof body.detail === "string" && body.detail ? body.detail : null;
    const title = typeof body.title === "string" && body.title ? body.title : null;
    return { code, reason: detail ?? title };
  } catch {
    return { code: `http_${response.status}`, reason: null };
  }
}

/** An upload the API refused for good, kept on the device with its content. */
export interface UploadIssue {
  readonly id: string;
  readonly tenantId: string | null;
  readonly personId: string | null;
  readonly table: string;
  readonly httpStatus: number | null;
  readonly code: string;
  readonly message: string;
  readonly payload: Record<string, unknown>;
  readonly rejectedAt: Date;
}

/** Records a refused upload in the local-only `upload_issue` table (idempotent by record id). */
export async function recordUploadIssue(
  database: Pick<UploadSource, "execute">,
  issue: UploadIssue,
): Promise<void> {
  await database.execute("DELETE FROM upload_issue WHERE id = ?", [issue.id]);
  await database.execute(
    `INSERT INTO upload_issue (id, tenant_id, person_id, record_table, http_status, code, message,
      payload, rejected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      issue.id,
      issue.tenantId,
      issue.personId,
      issue.table,
      issue.httpStatus,
      issue.code,
      issue.message,
      JSON.stringify(issue.payload),
      issue.rejectedAt.toISOString(),
    ],
  );
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export interface HarbourConnectorOptions {
  readonly apiUrl: string;
  readonly fetch: FetchLike;
  /** Current session token, or null when signed out. */
  readonly getToken: () => Promise<string | null>;
  /** The session's organisation, sent on every request (staff may belong to more than one). */
  readonly getTenantId?: () => string | null;
  /** Called once when the API says the session is no longer valid. */
  readonly onSessionRevoked: () => void;
  /**
   * Called instead when the API says a manager revoked this device (403 `device_revoked`): the
   * device wipes, keeping unsent entries under the hold rules. Without it, an ended session.
   */
  readonly onDeviceRevoked?: () => void;
  /**
   * Called after a care entry is moved to "needs attention", so its content goes to the server's
   * copy at once (care.md section 6, Device integrity part 5; `refused-copies.ts`).
   */
  readonly onRefused?: () => void;
  /**
   * The device's opaque id (the PowerSync client id), sent with the sync token request so the
   * server knows this member has used the device: a hold report naming them as its owner counts
   * only then (security review round 7, M1).
   */
  readonly getDeviceId?: () => Promise<string | null>;
  /**
   * Called with where the phone may record, read from each new sync token (review round 2,
   * C2-M3), so the person screen offers recording only where the server would take it.
   */
  readonly onWriteScope?: (scope: WriteScope | null) => void;
  readonly backoff?: BackoffPolicy;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  /** The device clock; tests fix it. */
  readonly now?: () => Date;
}

export class HarbourConnector implements PowerSyncBackendConnector {
  private readonly options: HarbourConnectorOptions;
  /** Failed follow-up checks per move id, with when the first failed (`TASK_CHECK_MAX_*`). */
  private readonly checkFailures = new Map<string, { count: number; since: number }>();

  constructor(options: HarbourConnectorOptions) {
    this.options = options;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private tenantHeader(): Record<string, string> {
    const tenantId = this.options.getTenantId?.() ?? null;
    return tenantId ? { [TENANT_HEADER]: tenantId } : {};
  }

  private async authorisedHeaders(): Promise<Record<string, string>> {
    const token = await this.options.getToken();
    if (!token) throw new SessionRevokedError();
    return {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...this.tenantHeader(),
    };
  }

  /** Asks `GET /v1/me` whether the session stands, after a 403 that did not say (H1). */
  private async sessionState(): Promise<SessionCheck> {
    return checkSession({
      apiUrl: this.options.apiUrl,
      fetch: this.options.fetch,
      token: await this.options.getToken(),
      tenantId: this.options.getTenantId?.() ?? null,
    });
  }

  private ended(): never {
    this.checkFailures.clear();
    this.options.onSessionRevoked();
    throw new SessionRevokedError();
  }

  /** A manager revoked this device: never parked, never retried, reported as a revocation. */
  private revoked(): never {
    this.checkFailures.clear();
    (this.options.onDeviceRevoked ?? this.options.onSessionRevoked)();
    throw new DeviceRevokedError();
  }

  /**
   * A 403 (security reviews round 3 and round 4, H1). A session code ends the session. Any other
   * code from the API is the API's decision: `accessWithdrawn` says what it means here (true on
   * the token and batch uploads, where it withdraws the access Care mode needs; false on a single
   * entry, which it refuses). No body, an HTML page or the edge's `edge_blocked` asks
   * `GET /v1/me`, which ends the session only when it says so. Returns the problem when the
   * session stands, with whether that could be checked.
   */
  private async forbidden(
    response: Response,
    accessWithdrawn: boolean,
  ): Promise<{
    readonly kind: "api" | "unexplained";
    readonly session: "ok" | "unknown";
    readonly code: string | null;
    readonly reason: string | null;
  }> {
    const problem = await readProblemBody(response);
    const kind = classifyForbidden(problem.code);
    if (kind === "session") this.ended();
    if (kind === "revoked") this.revoked();
    if (kind === "api") {
      if (accessWithdrawn) this.ended();
      return { kind, session: "ok", code: problem.code, reason: problem.reason };
    }
    const session = await this.sessionState();
    if (session === "ended") this.ended();
    return { kind, session, code: problem.code, reason: problem.reason };
  }

  private retryOptions() {
    return {
      policy: this.options.backoff ?? UPLOAD_BACKOFF,
      classify: classifyUploadError,
      sleep: this.options.sleep,
      random: this.options.random,
    };
  }

  async fetchCredentials(): Promise<PowerSyncCredentials | null> {
    const token = await this.options.getToken();
    // Signed out: returning null tells PowerSync not to connect.
    if (!token) return null;
    const deviceId = await (this.options.getDeviceId?.() ?? Promise.resolve(null)).catch(
      () => null,
    );
    const response = await this.options.fetch(`${this.options.apiUrl}/v1/sync/token`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...this.tenantHeader(),
        ...(deviceId ? { [DEVICE_HEADER]: deviceId } : {}),
      },
      credentials: "omit",
    });
    if (response.status === 401) {
      this.checkFailures.clear();
      this.options.onSessionRevoked();
      return null;
    }
    if (response.status === 403) {
      try {
        // On the token, any refusal from the API withdraws the access Care mode needs.
        await this.forbidden(response, true);
      } catch (error) {
        if (error instanceof SessionRevokedError) return null;
        throw error;
      }
      // Not the API's decision, and the session stands or cannot be checked: back off and retry.
      throw new HttpError(403, "Sync credentials refused; the session still stands");
    }
    if (!response.ok) {
      // PowerSync retries the connection itself; the banner shows the failure meanwhile.
      throw new HttpError(response.status, "Could not obtain sync credentials");
    }
    const credentials = parseSyncCredentials(await response.json());
    this.options.onWriteScope?.(writeScopeFromToken(credentials.token));
    return credentials;
  }

  async uploadData(database: UploadSource): Promise<void> {
    const transaction = await database.getNextCrudTransaction();
    if (!transaction) return;

    const clientId = await database.getClientId();
    const others: CrudEntryLike[] = [];
    for (const entry of transaction.crud) {
      if (isCareEntryTable(entry.table)) {
        await this.uploadCareEntry(database, { ...entry, table: entry.table }, clientId);
      } else if (isRoundWritableTable(entry.table)) {
        await this.uploadRoundChange(database, { ...entry, table: entry.table }, clientId);
      } else {
        others.push(entry);
      }
    }
    if (others.length > 0) {
      // Lets the API ignore a replay of a transaction it already applied.
      const idempotencyKey = `${clientId}:${transaction.transactionId ?? others[0]?.id ?? "batch"}`;
      await this.uploadOperations(database, others, idempotencyKey);
    }
    await transaction.complete();
  }

  /** One care entry to its own endpoint; a refusal moves it to "needs attention". */
  private async uploadCareEntry(
    database: UploadSource,
    entry: CrudEntryLike & { readonly table: Parameters<typeof toCareUpload>[0]["table"] },
    clientId: string,
  ): Promise<void> {
    const request = toCareUpload(entry);
    if (request.kind === "refused") {
      await recordUploadIssue(database, {
        id: request.recordId,
        tenantId: request.tenantId,
        personId: request.personId,
        table: request.table,
        httpStatus: null,
        code: request.code,
        message: request.message,
        payload: { ...(entry.opData ?? {}) },
        rejectedAt: this.now(),
      });
      this.options.onRefused?.();
      return;
    }
    try {
      await this.postChange(request, clientId);
    } catch (error) {
      if (!(error instanceof UploadRejectedError)) throw error;
      await recordUploadIssue(database, {
        id: request.recordId,
        tenantId: request.tenantId,
        personId: request.personId,
        table: request.table,
        httpStatus: error.status,
        code: error.code,
        message: error.reason ?? t("mobile.issues.unknownReason"),
        payload: { ...(entry.opData ?? {}) },
        rejectedAt: this.now(),
      });
      this.options.onRefused?.();
    }
  }

  /**
   * A task's move or a handover acknowledgement to its own route (`round-upload.ts`). A refusal
   * moves it to "needs attention" with the phone's words for the two a carer must act on; the
   * server's copy then puts the task or the handover back as it is there. A move the API refuses
   * because the task changed (409 `version_conflict`) is settled by reading the task
   * (`settleConflict`).
   */
  private async uploadRoundChange(
    database: UploadSource,
    entry: CrudEntryLike & { readonly table: RoundWritableTable },
    clientId: string,
  ): Promise<void> {
    const request = toRoundUpload(entry);
    const park = (status: number | null, code: string, message: string) =>
      recordUploadIssue(database, {
        id: request.recordId,
        tenantId: request.tenantId,
        personId: request.personId,
        table: entry.table,
        httpStatus: status,
        code,
        message,
        // A move keeps its task's id with it, as a held move does, so it can be sent again.
        payload:
          entry.table === "task"
            ? { ...(entry.opData ?? {}), task_id: entry.id }
            : { ...(entry.opData ?? {}) },
        rejectedAt: this.now(),
      });
    if (request.kind === "refused") {
      await park(null, request.code, request.message);
      return;
    }
    try {
      await this.postChange(request, clientId);
    } catch (error) {
      if (!(error instanceof UploadRejectedError)) throw error;
      if (error.status === 409 && error.code === "version_conflict" && request.move) {
        await this.settleConflict(request.move, park);
        return;
      }
      await park(
        error.status,
        error.code,
        roundRefusalMessage(entry.table, error.code, error.reason) ??
          t("mobile.issues.unknownReason"),
      );
    }
  }

  /**
   * A move the API refused because the task changed (#37 review rounds 1 and 2). Reads the task as
   * the API has it, and only an answer it can read decides (`settleMove`): the carer's own move
   * already made (its response was lost, HZ-029) counts as sent; anything else moves to "needs
   * attention" in words that are true of the task, and is never sent again on its own. When the
   * task cannot be read this throws and the move stays queued, to be tried again, until the cap
   * (`TASK_CHECK_MAX_FAILURES`, `TASK_CHECK_MAX_MS`): then the move is kept as needing attention,
   * saying it could not be checked, and the queue carries on.
   */
  private async settleConflict(
    move: RoundMove,
    park: (status: number | null, code: string, message: string) => Promise<void>,
  ): Promise<void> {
    const state = await this.readTask(move);
    if (state === "unchecked") {
      await park(409, "task_unchecked", t("mobile.round.taskUnchecked"));
      return;
    }
    const settled = settleMove(state, move);
    if (settled.kind === "parked") await park(409, settled.code, settled.message);
  }

  /**
   * The task as the API has it, from the task list (`taskStatePath`): its state, or null when the
   * list the API sent does not have it. Throws, so the move stays queued, on anything else: a
   * network failure or a retryable status after backoff, any other status, or an answer it cannot
   * read; past the cap it answers "unchecked" instead, and the move is parked. A 401, a session
   * code on a 403, or `GET /v1/me` saying so after an unexplained 403 ends the session at once
   * (H1); a manager's revocation is reported as one.
   */
  private async readTask(move: RoundMove): Promise<TaskState | null | "unchecked"> {
    const read = async () => {
      try {
        return await this.fetchTaskState(move);
      } catch (error) {
        // Only a refusal the server answered counts towards the cap (N1).
        if (isAnsweredRefusal(error) && this.checkFailed(move.id)) throw new TaskCheckGaveUp();
        throw error;
      }
    };
    try {
      const state = await retryWithBackoff(read, {
        ...this.retryOptions(),
        classify: (error) =>
          error instanceof TaskCheckGaveUp ? { retry: false } : classifyUploadError(error),
      });
      this.checkFailures.delete(move.id);
      return state;
    } catch (error) {
      if (!(error instanceof TaskCheckGaveUp)) throw error;
      this.checkFailures.delete(move.id);
      return "unchecked";
    }
  }

  /** Counts a refused follow-up check; true once the move has reached the cap. */
  private checkFailed(moveId: string): boolean {
    const now = this.now().getTime();
    const before = this.checkFailures.get(moveId);
    const record = { count: (before?.count ?? 0) + 1, since: before?.since ?? now };
    this.checkFailures.set(moveId, record);
    return record.count >= TASK_CHECK_MAX_FAILURES || now - record.since >= TASK_CHECK_MAX_MS;
  }

  private async fetchTaskState(move: RoundMove): Promise<TaskState | null> {
    const headers = await this.authorisedHeaders();
    const response = await this.options.fetch(`${this.options.apiUrl}${taskStatePath(move)}`, {
      method: "GET",
      headers: { ...headers, [TENANT_HEADER]: move.tenantId },
      credentials: "omit",
    });
    if (response.status === 401) this.ended();
    if (response.status === 403) {
      await this.forbidden(response, false);
      throw new HttpError(403, "The task could not be read; the move stays queued");
    }
    if (!response.ok) {
      throw new HttpError(
        response.status,
        "The task could not be read; the move stays queued",
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }
    const state = taskStateIn(await response.json().catch(() => undefined), move.taskId);
    if (state === "unreadable") {
      throw new HttpError(
        response.status,
        "The task list could not be read; the move stays queued",
      );
    }
    return state;
  }

  /**
   * One queued change to its own endpoint, with the device's id for it, the device and the time
   * the request leaves. Transient failures retry with backoff and then stay queued; a refusal for
   * good throws `UploadRejectedError`.
   */
  private async postChange(
    request: {
      readonly path: string;
      readonly recordId: string;
      readonly tenantId: string;
      readonly body: unknown;
    },
    clientId: string,
  ): Promise<void> {
    const body = JSON.stringify(request.body);
    await retryWithBackoff(async () => {
      const headers = await this.authorisedHeaders();
      const response = await this.options.fetch(`${this.options.apiUrl}${request.path}`, {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          "Idempotency-Key": request.recordId,
          [TENANT_HEADER]: request.tenantId,
          [DEVICE_HEADER]: clientId,
          // The device clock as this request leaves, so drift is measured at send time and time
          // spent in the queue is never mistaken for drift (HZ-010).
          [SENT_AT_HEADER]: this.now().toISOString(),
        },
        credentials: "omit",
        body,
      });
      if (response.ok) return;
      if (response.status === 401) {
        this.options.onSessionRevoked();
        throw new SessionRevokedError();
      }
      if (isRetryableStatus(response.status)) {
        throw new HttpError(
          response.status,
          "Upload failed",
          parseRetryAfter(response.headers.get("retry-after")),
        );
      }
      if (response.status === 403) {
        // A session code, or `GET /v1/me` after an unexplained 403, ends the session (H1). Any
        // other code from the API refuses this change, which moves to "needs attention"; when an
        // unexplained 403 cannot be checked the change stays queued and is tried again later.
        const refusal = await this.forbidden(response, false);
        if (refusal.session === "unknown") {
          throw new HttpError(403, "Upload refused; the session could not be checked");
        }
        throw new UploadRejectedError(403, refusal.code ?? "http_403", refusal.reason);
      }
      const problem = await readProblem(response);
      throw new UploadRejectedError(response.status, problem.code, problem.reason);
    }, this.retryOptions());
  }

  /** Other tables through `POST /v1/sync/upload` (none is writable from a device yet). */
  private async uploadOperations(
    database: UploadSource,
    entries: readonly CrudEntryLike[],
    idempotencyKey: string,
  ): Promise<void> {
    const operations = entries.map(toUploadOperation);
    const park = async (
      operation: UploadOperation,
      status: number,
      code: string,
      reason: string | null,
    ) =>
      recordUploadIssue(database, {
        id: operation.id,
        tenantId: text(operation.data.tenant_id),
        personId: text(operation.data.person_id),
        table: operation.table,
        httpStatus: status,
        code,
        message: reason ?? t("mobile.issues.unknownReason"),
        payload: operation.data,
        rejectedAt: this.now(),
      });

    let rejected: ReadonlyArray<{ id: string; code: string; message: string }> = [];
    try {
      await retryWithBackoff(async () => {
        const headers = await this.authorisedHeaders();
        const deviceSentAt = this.now().toISOString();
        const response = await this.options.fetch(`${this.options.apiUrl}/v1/sync/upload`, {
          method: "POST",
          headers: {
            ...headers,
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          credentials: "omit",
          body: JSON.stringify({
            operations: operations.map((operation) => ({ ...operation, deviceSentAt })),
          }),
        });
        if (response.ok) {
          rejected = await readRejected(response);
          return;
        }
        if (response.status === 401) {
          this.options.onSessionRevoked();
          throw new SessionRevokedError();
        }
        if (response.status === 403) {
          // An API refusal of the batch withdraws access; an unexplained 403 is never parked: back
          // off and try again (H1).
          await this.forbidden(response, true);
          throw new HttpError(403, "Upload refused; the session still stands");
        }
        if (isRetryableStatus(response.status)) {
          throw new HttpError(
            response.status,
            "Upload failed",
            parseRetryAfter(response.headers.get("retry-after")),
          );
        }
        const problem = await readProblem(response);
        throw new UploadRejectedError(response.status, problem.code, problem.reason);
      }, this.retryOptions());
    } catch (error) {
      if (!(error instanceof UploadRejectedError)) throw error;
      for (const operation of operations) {
        await park(operation, error.status, error.code, error.reason);
      }
      return;
    }
    // A 200 can still refuse some operations: never complete those silently.
    for (const refusal of rejected) {
      const operation = operations.find((o) => o.id === refusal.id);
      if (operation) await park(operation, 200, refusal.code, refusal.message);
    }
  }
}

/** Reads `rejected` from a `SyncUploadResult`; an unreadable body refuses nothing. */
async function readRejected(
  response: Response,
): Promise<ReadonlyArray<{ id: string; code: string; message: string }>> {
  try {
    const body: unknown = await response.json();
    if (!isRecord(body) || !Array.isArray(body.rejected)) return [];
    return body.rejected.filter(
      (r): r is { id: string; code: string; message: string } =>
        isRecord(r) &&
        typeof r.id === "string" &&
        typeof r.code === "string" &&
        typeof r.message === "string",
    );
  } catch {
    return [];
  }
}
