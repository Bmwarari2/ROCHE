/**
 * Sending deletions to the API (security review M2, clinical review H2): every deletion of entries
 * that never reached the server becomes an audit event through `POST /v1/sync/discards`.
 *
 * The deletion is put on record first, as a tombstone in the keystore (`tombstones.ts`); a
 * tombstone that cannot be written refuses the deletion. The device then sends it at once, with
 * the person's own words when they gave any, and deletes the tombstone when the server has it.
 * When the send fails, the tombstone stays, without the words, and is sent again at each sync
 * until the server acknowledges it. The words are never kept on the device, so a deletion whose
 * reason is "other" (the words are the reason) needs the server to take it before anything is
 * deleted.
 */

import {
  acknowledgeTombstone,
  readTombstones,
  recordTombstone,
  type Tombstone,
  type TombstoneStore,
} from "../app-state/tombstones";
import type { FetchLike } from "../auth/http";
import { t } from "../i18n/t";
import { DEVICE_HEADER, TENANT_HEADER } from "./connector";

export interface ApiOptions {
  readonly apiUrl: string;
  readonly fetch: FetchLike;
  readonly token: string;
  /** The tenant the session belongs to. */
  readonly tenantId: string;
  /** The device's opaque id (PowerSync client id), when known. */
  readonly deviceId: string | null;
}

/** acknowledged: the server has it; retry: try again later; rejected: it never will. */
export type DiscardSendResult = "acknowledged" | "retry" | "rejected";

/** The request body (`SyncDiscard` in `@harbour/contracts`). */
export function discardBody(tombstone: Tombstone, reason: string | null) {
  const words = reason?.trim();
  return {
    id: tombstone.id,
    kind: tombstone.kind,
    reasonCode: tombstone.reasonCode,
    ...(words ? { reason: words } : {}),
    ownerTenantUserId: tombstone.ownerTenantUserId,
    deletedByTenantUserId: tombstone.deletedByTenantUserId,
    entryIds: [...tombstone.entryIds],
    personIds: [...tombstone.personIds],
    count: tombstone.count,
    discardedAt: tombstone.at,
  };
}

export function apiHeaders(options: ApiOptions): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${options.token}`,
    [TENANT_HEADER]: options.tenantId,
    ...(options.deviceId ? { [DEVICE_HEADER]: options.deviceId } : {}),
  };
}

/** Sends one deletion. Never throws. A refusal of the request itself (400, 422) is final. */
export async function sendDiscard(
  options: ApiOptions,
  tombstone: Tombstone,
  reason: string | null = null,
): Promise<DiscardSendResult> {
  try {
    const response = await options.fetch(`${options.apiUrl}/v1/sync/discards`, {
      method: "POST",
      headers: apiHeaders(options),
      credentials: "omit",
      body: JSON.stringify(discardBody(tombstone, reason)),
    });
    if (response.ok) return "acknowledged";
    if (response.status === 400 || response.status === 422) return "rejected";
    // 401, 403 (for example a member of staff without the manager's permission sending a
    // manager's deletion again), rate limits and server errors: a later session may succeed.
    return "retry";
  } catch {
    return "retry";
  }
}

/** The deletion could not be put on record at the server, so nothing was deleted. */
export class DiscardNotSentError extends Error {
  readonly needsConnection: boolean;

  constructor(needsConnection: boolean) {
    super(t(needsConnection ? "mobile.discard.needsConnection" : "mobile.discard.notRecorded"));
    this.name = "DiscardNotSentError";
    this.needsConnection = needsConnection;
  }
}

export interface PutOnRecordDeps {
  readonly store: TombstoneStore;
  readonly tombstone: Tombstone;
  /** The person's own words, sent now and never kept. */
  readonly reason: string | null;
  /** Sends the deletion; null when there is no session to send it with. */
  readonly send:
    | ((tombstone: Tombstone, reason: string | null) => Promise<DiscardSendResult>)
    | null;
}

/**
 * Puts a deletion on record before anything is deleted: the tombstone first (a keystore failure
 * throws and refuses the deletion), then the request. "sent" when the server has it; "queued"
 * when it will be sent again later. A deletion whose reason is "other" is refused when the server
 * does not take it now, because its words are not kept; one the server rejects is refused too.
 */
export async function putDiscardOnRecord(deps: PutOnRecordDeps): Promise<"sent" | "queued"> {
  await recordTombstone(deps.store, deps.tombstone);
  const result = deps.send ? await deps.send(deps.tombstone, deps.reason) : "retry";
  if (result === "acknowledged") {
    await acknowledgeTombstone(deps.store, deps.tombstone.id).catch(() => undefined);
    return "sent";
  }
  if (result === "retry" && deps.tombstone.reasonCode !== "other") return "queued";
  // Nothing has been deleted: the deletion is refused and its record withdrawn.
  await acknowledgeTombstone(deps.store, deps.tombstone.id).catch(() => undefined);
  throw new DiscardNotSentError(result === "retry");
}

/** Withdraws a deletion's record on the device when nothing was deleted after all. */
export async function withdrawDiscard(store: TombstoneStore, id: string): Promise<void> {
  await acknowledgeTombstone(store, id).catch(() => undefined);
}

/**
 * Sends the tombstones still waiting, oldest first, for the tenant of the current session only
 * (an agency worker's other tenant waits for a session there). Stops at the first that cannot be
 * sent now; one the server will never take is deleted (it can only be a repeat of one it already
 * has, since a refused first send refuses the deletion).
 */
export async function flushTombstones(
  store: TombstoneStore,
  options: ApiOptions,
): Promise<{ readonly sent: number; readonly waiting: number }> {
  const waiting = await readTombstones(store);
  let sent = 0;
  for (const tombstone of waiting) {
    if (tombstone.tenantId !== null && tombstone.tenantId !== options.tenantId) continue;
    const result = await sendDiscard(options, tombstone);
    if (result === "retry") break;
    await acknowledgeTombstone(store, tombstone.id).catch(() => undefined);
    sent += 1;
  }
  return { sent, waiting: waiting.length - sent };
}
