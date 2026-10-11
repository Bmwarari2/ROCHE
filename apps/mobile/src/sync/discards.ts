/**
 * Sending deletions to the API (security reviews M2 and round 4 M2 and M3, clinical reviews H2 and
 * round 4 H1): every deletion of entries that never reached the server becomes audit events through
 * `POST /v1/sync/discards`, one per stage.
 *
 * 1. "requested" is put on record first, as a tombstone in the keystore (`tombstones.ts`); a
 *    tombstone that cannot be written refuses the deletion. It is sent at once. The caller's own
 *    entries may then be deleted while it waits to be sent again; anyone else's, or entries whose
 *    owner is unknown, are deleted only once the server has acknowledged it.
 * 2. After deleting, "deleted" when the file and its key are gone, otherwise "failed", which
 *    supersedes the request at the server.
 *
 * Stages the server has not acknowledged are sent again, in order, at each sync. A refusal of one
 * record (403, or a request the server will never take) skips that record for this session and
 * keeps it; a network or server failure stops until the next try. Only the coded reason is sent;
 * the person's own words never leave the device (round 4, M3).
 */

import {
  acknowledgeStage,
  type DiscardOutcome,
  type DiscardStage,
  isOpaqueId,
  type Leftover,
  readTombstone,
  readTombstones,
  recordTombstone,
  removeTombstone,
  type Tombstone,
  type TombstoneStore,
} from "../app-state/tombstones";
import type { FetchLike } from "../auth/http";
import { type MessageKey, t } from "../i18n/t";
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

/**
 * acknowledged: the server has it; retry: try again later (no network, a server error, a rate
 * limit, an ended session); forbidden: this session may not record it (403); rejected: the server
 * will never take the request as sent (400, 413, 422).
 */
export type DiscardSendResult = "acknowledged" | "retry" | "forbidden" | "rejected";

/** Mirrors `SYNC_DISCARD_MAX_ENTRY_IDS` in `@harbour/contracts`; a test keeps them equal. */
export const MAX_SENT_ENTRY_IDS = 500;
/** Mirrors the API's limit on person ids. */
export const MAX_SENT_PERSON_IDS = 200;

/**
 * The request body for one stage (`SyncDiscard` in `@harbour/contracts`). A large deletion sends
 * a sample of its ids, never more than the API takes, and never more ids than its count, so the
 * request is never refused for its size (security review round 4, low).
 */
export function discardBody(tombstone: Tombstone, stage: DiscardStage) {
  const entryIds = [...new Set(tombstone.entryIds.filter(isOpaqueId))].slice(0, MAX_SENT_ENTRY_IDS);
  const personIds = [...new Set(tombstone.personIds.filter(isOpaqueId))].slice(
    0,
    MAX_SENT_PERSON_IDS,
  );
  return {
    id: tombstone.id,
    kind: tombstone.kind,
    stage,
    reasonCode: tombstone.reasonCode,
    ownerTenantUserId: tombstone.ownerTenantUserId,
    deletedByTenantUserId: tombstone.deletedByTenantUserId,
    entryIds,
    personIds,
    count: tombstone.count === null ? null : Math.max(tombstone.count, entryIds.length),
    discardedAt: tombstone.at,
    // Why there are no ids, and what a deletion left behind (clinical review round 5, C-M1, C-M2).
    ...(tombstone.idsMissing ? { idsMissing: tombstone.idsMissing } : {}),
    ...(stage === "deleted" && tombstone.leftover && tombstone.leftover.length > 0
      ? { leftover: [...tombstone.leftover] }
      : {}),
    // The device the entries were held on, which may no longer be this one (round 6, M1).
    ...(tombstone.deviceId ? { deviceId: tombstone.deviceId } : {}),
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

/** Sends one stage of a deletion. Never throws. */
export async function sendDiscard(
  options: ApiOptions,
  tombstone: Tombstone,
  stage: DiscardStage,
): Promise<DiscardSendResult> {
  try {
    const response = await options.fetch(`${options.apiUrl}/v1/sync/discards`, {
      method: "POST",
      headers: apiHeaders(options),
      credentials: "omit",
      body: JSON.stringify(discardBody(tombstone, stage)),
    });
    if (response.ok) return "acknowledged";
    if (response.status === 403) return "forbidden";
    if ([400, 413, 422].includes(response.status)) return "rejected";
    return "retry";
  } catch {
    return "retry";
  }
}

export type DiscardSender = (
  tombstone: Tombstone,
  stage: DiscardStage,
) => Promise<DiscardSendResult>;

/** A sender for a session, or one that always waits when there is no session. */
export function senderFor(options: ApiOptions | null): DiscardSender {
  return (tombstone, stage) =>
    options ? sendDiscard(options, tombstone, stage) : Promise.resolve("retry");
}

/** True when the caller deletes their own entries: the only deletion that may wait to be sent. */
export function isOwnDeletion(tombstone: Tombstone): boolean {
  return (
    tombstone.ownerTenantUserId !== null &&
    tombstone.deletedByTenantUserId === tombstone.ownerTenantUserId
  );
}

/** Why a deletion could not be put on record at the server, so nothing was deleted. */
export type NotSentReason = "connection" | "forbidden" | "rejected";

const NOT_SENT_KEYS: Record<NotSentReason, MessageKey> = {
  connection: "mobile.discard.needsConnection",
  forbidden: "mobile.discard.notAllowed",
  rejected: "mobile.discard.notRecorded",
};

/** The deletion could not be put on record at the server, so nothing was deleted. */
export class DiscardNotSentError extends Error {
  readonly reason: NotSentReason;

  constructor(reason: NotSentReason) {
    super(t(NOT_SENT_KEYS[reason]));
    this.name = "DiscardNotSentError";
    this.reason = reason;
  }
}

export interface PutOnRecordDeps {
  readonly store: TombstoneStore;
  /** The deletion at its "requested" stage, with all its ids (the keystore keeps a sample). */
  readonly tombstone: Tombstone;
  readonly send: DiscardSender;
}

/** A new deletion, recorded as requested and not yet sent. */
export function requested(fields: Omit<Tombstone, "stage" | "unsent">): Tombstone {
  return { ...fields, stage: "requested", unsent: ["requested"] };
}

/**
 * Puts a deletion on record before anything is deleted: the tombstone first (a keystore failure
 * throws and refuses the deletion), then the request. "sent" when the server has it; "queued" when
 * the caller's own entries may be deleted while it waits. Anyone else's entries, or entries whose
 * owner is unknown, need the server's acknowledgement first (security review round 4, M2); a
 * refusal refuses the deletion too, and the record is withdrawn since nothing was deleted.
 */
export async function putDiscardOnRecord(deps: PutOnRecordDeps): Promise<"sent" | "queued"> {
  await recordTombstone(deps.store, deps.tombstone);
  const result = await deps.send(deps.tombstone, "requested");
  if (result === "acknowledged") {
    await acknowledgeStage(deps.store, deps.tombstone.id, "requested").catch(() => undefined);
    return "sent";
  }
  if (result === "retry" && isOwnDeletion(deps.tombstone)) return "queued";
  await removeTombstone(deps.store, deps.tombstone.id).catch(() => undefined);
  throw new DiscardNotSentError(result === "retry" ? "connection" : result);
}

/** Withdraws a deletion's record on the device when nothing was deleted after all. */
export async function withdrawDiscard(store: TombstoneStore, id: string): Promise<void> {
  await removeTombstone(store, id).catch(() => undefined);
}

/** Sends a tombstone's waiting stages in order; stops at the first the server does not take. */
async function sendWaitingStages(
  store: TombstoneStore,
  send: DiscardSender,
  tombstone: Tombstone,
): Promise<DiscardSendResult> {
  for (const stage of tombstone.unsent) {
    const result = await send(tombstone, stage);
    if (result !== "acknowledged") return result;
    await acknowledgeStage(store, tombstone.id, stage).catch(() => undefined);
  }
  return "acknowledged";
}

export interface FinishDeps {
  readonly store: TombstoneStore;
  /** The same deletion that was put on record, with all its ids. */
  readonly tombstone: Tombstone;
  /**
   * "failed" only while the entries can still be read (the file, its key and the rows all remain);
   * otherwise "deleted" (clinical review round 5, C-M1).
   */
  readonly outcome: DiscardOutcome;
  /** On "deleted": what was left on the device though the entries can no longer be read. */
  readonly leftover?: readonly Leftover[];
  readonly send: DiscardSender;
}

/**
 * Records how a deletion ended (clinical review round 4, H1) and sends it, after the request if
 * that is still waiting. Never throws: what cannot be sent now waits in the keystore.
 */
export async function finishDiscard(deps: FinishDeps): Promise<DiscardSendResult> {
  const current = await readTombstone(deps.store, deps.tombstone.id).catch(() => null);
  // Without the kept record, the request is sent again too (a replay is harmless).
  const before = current ? current.unsent : (["requested"] as const);
  const next: Tombstone = {
    ...deps.tombstone,
    stage: deps.outcome,
    unsent: [...before.filter((s) => s !== deps.outcome), deps.outcome],
    ...(deps.outcome === "deleted" && deps.leftover && deps.leftover.length > 0
      ? { leftover: [...deps.leftover] }
      : {}),
  };
  await recordTombstone(deps.store, next).catch(() => undefined);
  return sendWaitingStages(deps.store, deps.send, next);
}

/**
 * Sends the stages still waiting, oldest record first, for the tenant of the current session only
 * (an agency worker's other tenant waits for a session there). A record this session may not send
 * (403), or that the server will not take, is skipped and kept, and added to `skip` so it is not
 * tried again in this session; a network or server failure stops until the next try. A record is
 * never dropped before the server has it.
 */
export async function flushTombstones(
  store: TombstoneStore,
  options: ApiOptions,
  skip: Set<string> = new Set(),
): Promise<{ readonly sent: number; readonly skipped: number; readonly waiting: number }> {
  const kept = await readTombstones(store);
  const waiting = kept.filter((s) => s.unsent.length > 0);
  const send = senderFor(options);
  let sent = 0;
  let skipped = 0;
  for (const tombstone of waiting) {
    if (tombstone.tenantId !== null && tombstone.tenantId !== options.tenantId) continue;
    if (skip.has(tombstone.id)) continue;
    const result = await sendWaitingStages(store, send, tombstone);
    if (result === "acknowledged") {
      sent += 1;
    } else if (result === "retry") {
      break;
    } else {
      skip.add(tombstone.id);
      skipped += 1;
    }
  }
  return { sent, skipped, waiting: waiting.length - sent };
}
