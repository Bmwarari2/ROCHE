/**
 * The hand-over of held entries (care.md section 6, Device integrity part 6; HZ-006, HZ-040).
 *
 * Entries held on a device belong to the member of staff who wrote them, and only they resume
 * sending them by signing in. When they cannot (off shift, left, or a manager revoked the device),
 * a manager signs in on the device for this alone and sends them to Harbour in the owner's name; on
 * a revoked device the owner may do the same. The sign-in is the step-up the API asks for, and
 * device authentication opens the held database.
 *
 * Each held entry goes, in the order it was written, to its own endpoint with the hand-over headers
 * (the owner, an id for the hand-over, and the device that held it): sent ones leave `held_entry`;
 * one the API refuses moves to "needs attention" (`upload_issue`), and every needs-attention entry's
 * content then goes to the server's copy in the owner's name. A session refusal, a missing
 * permission or a network failure stops the hand-over with the rest still held. When everything is
 * on the server (sent, or copied), the hold is over and the caller wipes the device; otherwise the
 * hold stays with its count brought up to date.
 *
 * Pure apart from the injected dependencies, so the rules are unit-tested.
 */
import type { Me } from "../auth/auth-client";
import { isRetryableStatus } from "../auth/http";
import { t } from "../i18n/t";
import { isCareEntryTable, toCareUpload } from "../sync/care-upload";
import { readProblem, recordUploadIssue, SENT_AT_HEADER } from "../sync/connector";
import type { ApiOptions } from "../sync/discards";
import { flushRefusedCopies } from "../sync/refused-copies";
import { type HeldEntryRow, type HeldWork, isHeldWorkOwner } from "./held-work";

/** The hand-over headers (`HANDOVER_OWNER_HEADER`, `HANDOVER_ID_HEADER` in `@harbour/contracts`). */
export const HANDOVER_OWNER_HEADER = "x-harbour-handover-owner";
export const HANDOVER_ID_HEADER = "x-harbour-handover";

/** The permission a manager needs to send someone else's held entries (as the API asks). */
export const HANDOVER_PERMISSION = "care.held_entry.hand_over";

export type HandOverRefusal = "unknown_owner" | "blocked" | "not_allowed";

/**
 * Who may hand over held entries (care.md section 6, Device integrity part 6): a manager holding
 * the hand-over permission in the entries' organisation; or, on a device a manager revoked, the
 * owner. Entries whose owner is unknown cannot be sent in anyone's name, and entries a deletion
 * that did not finish left are never sent. Null when allowed.
 */
export function handOverRefusal(held: HeldWork, signer: Me): HandOverRefusal | null {
  if (!held.tenantId || !held.tenantUserId) return "unknown_owner";
  if (held.uploadBlocked) return "blocked";
  if (isHeldWorkOwner(held, signer)) return held.revoked ? null : "not_allowed";
  if (held.tenantId !== signer.tenant.id) return "not_allowed";
  return signer.permissions.includes(HANDOVER_PERMISSION) ? null : "not_allowed";
}

/** The person signed in may not hand over these entries; their session is ended. */
export class HandOverNotAllowedError extends Error {
  readonly refusal: HandOverRefusal;

  constructor(refusal: HandOverRefusal) {
    super(
      t(
        refusal === "unknown_owner"
          ? "mobile.held.handOverUnknownOwner"
          : refusal === "blocked"
            ? "mobile.held.handOverBlocked"
            : "mobile.held.handOverNotAllowed",
      ),
    );
    this.name = "HandOverNotAllowedError";
    this.refusal = refusal;
  }
}

type HandOverDb = {
  getAll<T>(sql: string, params?: unknown[]): Promise<T[]>;
  getOptional<T>(sql: string, params?: unknown[]): Promise<T | null>;
  execute(sql: string, params?: unknown[]): Promise<unknown>;
};

export interface HandOverDeps {
  readonly held: HeldWork;
  readonly db: HandOverDb;
  /** The signer's session, in the entries' organisation, naming the device that held them. */
  readonly api: ApiOptions & { readonly deviceId: string };
  readonly handoverId: string;
  readonly now: () => Date;
}

export interface HandOverResult {
  /** Held entries the server now has. */
  readonly sent: number;
  /** Held entries the server refused, moved to needs attention. */
  readonly parked: number;
  /** Needs-attention entries whose copy the server now has. */
  readonly copied: number;
  /** Entries still only on this device (held, or needing attention without a copy). */
  readonly remaining: number;
  /** Why sending stopped early, when it did. */
  readonly stopped: "session" | "offline" | null;
}

type Sent =
  | "sent"
  | { readonly refused: number; readonly code: string; readonly reason: string }
  | "session"
  | "offline";

async function sendEntry(
  deps: HandOverDeps,
  row: HeldEntryRow,
  owner: string,
): Promise<Sent | "local"> {
  const table = row.record_table ?? "";
  if (row.op !== "PUT" || !isCareEntryTable(table)) return "local";
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.payload ?? "{}");
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    data = {};
  }
  const request = toCareUpload({ op: "PUT", table, id: row.id, opData: data });
  if (request.kind === "refused") {
    return { refused: 0, code: request.code, reason: request.message };
  }
  const { api } = deps;
  let response: Response;
  try {
    response = await api.fetch(`${api.apiUrl}${request.path}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${api.token}`,
        "x-harbour-tenant": request.tenantId,
        "x-harbour-device": api.deviceId,
        "Idempotency-Key": request.recordId,
        [SENT_AT_HEADER]: deps.now().toISOString(),
        [HANDOVER_OWNER_HEADER]: owner,
        [HANDOVER_ID_HEADER]: deps.handoverId,
      },
      credentials: "omit",
      body: JSON.stringify(request.body),
    });
  } catch {
    return "offline";
  }
  if (response.ok) return "sent";
  // The signer's session, permission or step-up: nothing more can go with this sign-in.
  if (response.status === 401 || response.status === 403) return "session";
  if (isRetryableStatus(response.status)) return "offline";
  const problem = await readProblem(response);
  return {
    refused: response.status,
    code: problem.code,
    reason: problem.reason ?? t("mobile.issues.unknownReason"),
  };
}

/** Counts what is still only on this device: held entries, and refusals without a server copy. */
async function stillOnDevice(db: HandOverDb): Promise<number> {
  const held = await db.getOptional<{ n: number }>("SELECT COUNT(*) AS n FROM held_entry");
  const refused = await db.getOptional<{ n: number }>(
    "SELECT COUNT(*) AS n FROM upload_issue WHERE server_copy IS NULL OR server_copy <> 'copied'",
  );
  return Number(held?.n ?? 0) + Number(refused?.n ?? 0);
}

/**
 * Sends the held entries in their owner's name, then their refusals' copies (see the module
 * comment). The caller has checked `handOverRefusal` and opened the held database.
 */
export async function handOverHeldWork(deps: HandOverDeps): Promise<HandOverResult> {
  const owner = deps.held.tenantUserId;
  if (!owner || !deps.held.tenantId) throw new HandOverNotAllowedError("unknown_owner");
  const rows = await deps.db.getAll<HeldEntryRow>(
    "SELECT id, tenant_id, person_id, record_table, op, payload FROM held_entry ORDER BY position, id",
  );
  let sent = 0;
  let parked = 0;
  let stopped: HandOverResult["stopped"] = null;
  for (const row of rows) {
    const outcome = await sendEntry(deps, row, owner);
    if (outcome === "session" || outcome === "offline") {
      stopped = outcome;
      break;
    }
    if (outcome === "sent") {
      await deps.db.execute("DELETE FROM held_entry WHERE id = ?", [row.id]);
      sent += 1;
      continue;
    }
    // Refused, by the API or before sending (or a change that is not a care entry): it moves to
    // needs attention with its content, and its copy goes to the server below.
    const refused =
      outcome === "local"
        ? { refused: 0, code: "held_not_restored", reason: t("mobile.held.notRestored") }
        : outcome;
    let payload: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(row.payload ?? "{}");
      if (typeof parsed === "object" && parsed !== null)
        payload = parsed as Record<string, unknown>;
    } catch {
      payload = {};
    }
    await recordUploadIssue(deps.db as Parameters<typeof recordUploadIssue>[0], {
      id: row.id,
      tenantId: row.tenant_id,
      personId: row.person_id,
      table: row.record_table ?? "",
      httpStatus: refused.refused === 0 ? null : refused.refused,
      code: refused.code,
      message: refused.reason,
      payload,
      rejectedAt: deps.now(),
    });
    await deps.db.execute("DELETE FROM held_entry WHERE id = ?", [row.id]);
    parked += 1;
  }
  const copied = stopped
    ? 0
    : await flushRefusedCopies(deps.db, { ...deps.api, tenantId: deps.held.tenantId }, deps.now(), {
        [HANDOVER_OWNER_HEADER]: owner,
        [HANDOVER_ID_HEADER]: deps.handoverId,
      });
  return { sent, parked, copied, remaining: await stillOnDevice(deps.db), stopped };
}

/** What the person sees when the hand-over ends. */
export function handOverMessage(result: HandOverResult): string {
  if (result.remaining === 0) {
    return t("mobile.held.handOverDone", { count: result.sent, parked: result.parked });
  }
  return t("mobile.held.handOverPartial", { sent: result.sent, remaining: result.remaining });
}
