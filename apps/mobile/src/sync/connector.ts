/**
 * PowerSync backend connector for the Harbour API.
 *
 * - fetchCredentials: exchanges the Better Auth session for a short-lived PowerSync token
 *   (`POST /v1/sync/token`). A 401 or 403 means the session or device was revoked elsewhere, which
 *   triggers the remote wipe of the local database.
 * - uploadData: sends the next local transaction to `POST /v1/sync/upload`, retrying transient
 *   failures with backoff. The API is authoritative; a rejected write is never discarded on the
 *   device (it stays queued and the banner shows "Sync failed"), because care records must not be
 *   lost silently (hazard HZ-006). The server turns business conflicts into review tasks.
 */
import type {
  CommonPowerSyncDatabase,
  PowerSyncBackendConnector,
  PowerSyncCredentials,
} from "@powersync/common";
import { type FetchLike, HttpError, isRetryableStatus, parseRetryAfter } from "../auth/http";
import {
  type BackoffPolicy,
  type RetryDecision,
  retryWithBackoff,
  UPLOAD_BACKOFF,
} from "./backoff";

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
export type UploadSource = Pick<CommonPowerSyncDatabase, "getNextCrudTransaction" | "getClientId">;

/** The device's session was revoked (sign-out elsewhere, device reported lost, account disabled). */
export class SessionRevokedError extends Error {
  constructor() {
    super("The session is no longer valid");
    this.name = "SessionRevokedError";
  }
}

/** The API refused the upload permanently; it stays queued and is surfaced to the user. */
export class UploadRejectedError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`The server rejected queued changes (HTTP ${status})`);
    this.name = "UploadRejectedError";
    this.status = status;
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
}

export class HarbourConnector implements PowerSyncBackendConnector {
  private readonly options: HarbourConnectorOptions;

  constructor(options: HarbourConnectorOptions) {
    this.options = options;
  }

  private async authorisedHeaders(): Promise<Record<string, string>> {
    const token = await this.options.getToken();
    if (!token) throw new SessionRevokedError();
    return { Accept: "application/json", Authorization: `Bearer ${token}` };
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
    if (response.status === 401 || response.status === 403) {
      this.options.onSessionRevoked();
      return null;
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

    const operations = transaction.crud.map(toUploadOperation);
    const clientId = await database.getClientId();
    // Lets the API ignore a replay of a transaction it already applied.
    const idempotencyKey = `${clientId}:${transaction.transactionId ?? operations[0]?.id ?? "batch"}`;
    const body = JSON.stringify({ operations });

    await retryWithBackoff(
      async () => {
        const headers = await this.authorisedHeaders();
        const response = await this.options.fetch(`${this.options.apiUrl}/v1/sync/upload`, {
          method: "POST",
          headers: {
            ...headers,
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          credentials: "omit",
          body,
        });
        if (response.ok) return;
        if (response.status === 401 || response.status === 403) {
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
        throw new UploadRejectedError(response.status);
      },
      {
        policy: this.options.backoff ?? UPLOAD_BACKOFF,
        classify: classifyUploadError,
        sleep: this.options.sleep,
        random: this.options.random,
      },
    );

    await transaction.complete();
  }
}
