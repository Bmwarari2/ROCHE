/**
 * PowerSync backend connector for the Harbour API.
 *
 * - fetchCredentials: exchanges the Better Auth session for a short-lived PowerSync token
 *   (`POST /v1/sync/token`). A 401 means the session expired or was revoked elsewhere; a 403 means
 *   so only with a session problem code or when `GET /v1/me` agrees (`session-signals.ts`). The
 *   connector reports it and the vault decides (HZ-006, `held-work.ts`): wipe when nothing is
 *   waiting to upload, otherwise hold the unsent entries for their owner. Any other 403 (an edge
 *   block, an HTML page, an unknown code) only backs off and tries again.
 * - uploadData: sends the next local transaction. Care entries (notes, chart observations,
 *   body-map marks, activities and visits) go one by one to the API's own endpoints for them
 *   (`care-upload.ts`) with the device's UUIDv7, the device id, the tenant and the time the device
 *   sent the request (`x-harbour-sent-at`), so the server computes late-entry and clock-drift flags
 *   correctly (HZ-010, HZ-017) and ignores a replay. Anything else goes to `POST /v1/sync/upload`.
 *
 * Transient failures (no network, 408, 425, 429, 5xx) are retried with backoff and then left
 * queued for PowerSync to retry. The API is authoritative: when it refuses an entry for good (for
 * example the person's record closed while the device was offline) the entry moves, with its
 * content, to the local-only `upload_issue` table and the queue moves on, so one refusal never
 * blocks later entries and nothing is lost silently (HZ-006). Screens show those entries as "not
 * saved: needs attention" until someone deals with them.
 */
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
  checkSession,
  isSessionProblem,
  readProblemBody,
  type SessionCheck,
} from "./session-signals";

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
export const TENANT_HEADER = "x-harbour-tenant";
export const DEVICE_HEADER = "x-harbour-device";
export const SENT_AT_HEADER = "x-harbour-sent-at";

/** The device's session was revoked (sign-out elsewhere, device reported lost, account disabled). */
export class SessionRevokedError extends Error {
  constructor() {
    super("The session is no longer valid");
    this.name = "SessionRevokedError";
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
  /** Called once when the API says the session is no longer valid. */
  readonly onSessionRevoked: () => void;
  readonly backoff?: BackoffPolicy;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  /** The device clock; tests fix it. */
  readonly now?: () => Date;
}

export class HarbourConnector implements PowerSyncBackendConnector {
  private readonly options: HarbourConnectorOptions;

  constructor(options: HarbourConnectorOptions) {
    this.options = options;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private async authorisedHeaders(): Promise<Record<string, string>> {
    const token = await this.options.getToken();
    if (!token) throw new SessionRevokedError();
    return { Accept: "application/json", Authorization: `Bearer ${token}` };
  }

  /** Asks `GET /v1/me` whether the session stands, after a 403 that did not say (H1). */
  private async sessionState(): Promise<SessionCheck> {
    return checkSession({
      apiUrl: this.options.apiUrl,
      fetch: this.options.fetch,
      token: await this.options.getToken(),
    });
  }

  /**
   * A 403: the session has ended only when the API says so in a problem body, or `GET /v1/me`
   * says so; a block at the edge, an empty or HTML body, or an unknown code never ends it (H1).
   * Returns the problem when the session stands, so the caller can refuse the entry or retry.
   */
  private async forbidden(response: Response): Promise<{
    readonly session: "ok" | "unknown";
    readonly code: string | null;
    readonly reason: string | null;
  }> {
    const problem = await readProblemBody(response);
    const session = isSessionProblem(problem.code) ? "ended" : await this.sessionState();
    if (session === "ended") {
      this.options.onSessionRevoked();
      throw new SessionRevokedError();
    }
    return { session, code: problem.code, reason: problem.reason };
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
    const response = await this.options.fetch(`${this.options.apiUrl}/v1/sync/token`, {
      method: "POST",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      credentials: "omit",
    });
    if (response.status === 401) {
      this.options.onSessionRevoked();
      return null;
    }
    if (response.status === 403) {
      try {
        await this.forbidden(response);
      } catch (error) {
        if (error instanceof SessionRevokedError) return null;
        throw error;
      }
      // The session stands (or cannot be checked): back off and let PowerSync try again.
      throw new HttpError(403, "Sync credentials refused; the session still stands");
    }
    if (!response.ok) {
      // PowerSync retries the connection itself; the banner shows the failure meanwhile.
      throw new HttpError(response.status, "Could not obtain sync credentials");
    }
    return parseSyncCredentials(await response.json());
  }

  async uploadData(database: UploadSource): Promise<void> {
    const transaction = await database.getNextCrudTransaction();
    if (!transaction) return;

    const clientId = await database.getClientId();
    const others: CrudEntryLike[] = [];
    for (const entry of transaction.crud) {
      if (isCareEntryTable(entry.table)) {
        await this.uploadCareEntry(database, { ...entry, table: entry.table }, clientId);
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
      return;
    }
    const body = JSON.stringify(request.body);
    try {
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
          // Only a session code or `GET /v1/me` ends the session (H1). With the session standing
          // the entry itself was refused and moves to "needs attention"; when the session cannot
          // be checked the entry stays queued and is tried again later.
          const refusal = await this.forbidden(response);
          if (refusal.session === "unknown") {
            throw new HttpError(403, "Upload refused; the session could not be checked");
          }
          throw new UploadRejectedError(403, refusal.code ?? "http_403", refusal.reason);
        }
        const problem = await readProblem(response);
        throw new UploadRejectedError(response.status, problem.code, problem.reason);
      }, this.retryOptions());
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
    }
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
          // A batch is never parked on an unexplained 403: back off and try again (H1).
          await this.forbidden(response);
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
