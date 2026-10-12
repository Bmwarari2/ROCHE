/**
 * The hand-over of held entries (care.md section 6, Device integrity part 6; HZ-006, HZ-040).
 *
 * Entries held on a device belong to the member of staff who wrote them, and only they resume
 * sending them by signing in. When they cannot (off shift, left, or a manager revoked the device),
 * a manager signs in on the device for this alone and sends them to Harbour in the owner's name; on
 * a revoked device the owner may do the same. The sign-in is the step-up the API asks for, and
 * device authentication opens the held database.
 *
 * The device first sends its report from the signer's session, so the server binds the signer to
 * the device and knows the hold's count (#25 review round 2, H1). Then each held entry goes, in the
 * order it was written, to its own endpoint with the hand-over headers (the owner, an id for the
 * hand-over, and the device that held it): sent ones leave `held_entry`; one the API refuses for
 * what it is moves to "needs attention" (`upload_issue`), and every needs-attention entry's content
 * then goes to the server's copy in the owner's name. A session refusal or any other 403, a 404 (a
 * person outside the signer's scope), a hand-over the server will not take (`handover_refused`) or a
 * network failure stops the hand-over with the entry and the rest still held, never parked as
 * refused (#25 review round 2, H2). The hold is over, and the caller wipes the device, only when
 * nothing is left: no held entry and no needs-attention entry, whether or not the server has a copy,
 * until a screen shows the copies and the CSO closes H-134; otherwise the hold stays with its count
 * brought up to date.
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
  /**
   * Sends the device's report from the signer's session, naming the owner; true when the server
   * has it. The server takes a hand-over only from someone bound to the device, and counts it
   * against the hold the device reported.
   */
  readonly sendReport: () => Promise<boolean>;
}

export interface HandOverResult {
  /** Held entries the server now has. */
  readonly sent: number;
  /** Held entries the server refused, moved to needs attention. */
  readonly parked: number;
  /** Needs-attention entries whose copy the server now has. */
  readonly copied: number;
  /** Entries still on this device: held, or needing attention (with a server copy or not). */
  readonly remaining: number;
  /**
   * Why sending stopped early, when it did: the signer's session or permission, the network, or
   * the server not taking the hand-over (a 404, or `handover_refused`).
   */
  readonly stopped: "session" | "offline" | "not_taken" | null;
  /** The server's reason when it did not take the hand-over. */
  readonly reason?: string;
}

/** The problem code of a hand-over the server will not take (`HANDOVER_REFUSED_CODE`). */
export const HANDOVER_REFUSED_CODE = "handover_refused";

type Sent =
  | "sent"
  | { readonly refused: number; readonly code: string; readonly reason: string }
  | "session"
  | "offline"
  | { readonly notTaken: string };

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
  // The signer's session, permission or step-up, or any other 403: nothing more can go with this
  // sign-in, and the entry stays held (#25 review round 2, H2).
  if (response.status === 401 || response.status === 403) return "session";
  if (isRetryableStatus(response.status)) return "offline";
  const problem = await readProblem(response);
  // Not found (a person outside the signer's scope) or a hand-over the server will not take: the
  // entry may be perfectly good, so it stays held, never parked as refused (H2).
  if (response.status === 404 || problem.code === HANDOVER_REFUSED_CODE) {
    return { notTaken: problem.reason ?? t("mobile.issues.unknownReason") };
  }
  return {
    refused: response.status,
    code: problem.code,
    reason: problem.reason ?? t("mobile.issues.unknownReason"),
  };
}

/**
 * Counts what is still on this device: held entries, and every needs-attention entry, copied to the
 * server or not. A server copy is not yet something anyone reads (no screen shows it, H-134), so a
 * refused entry keeps the database (#25 review round 2, H2).
 */
async function stillOnDevice(db: HandOverDb): Promise<number> {
  const held = await db.getOptional<{ n: number }>("SELECT COUNT(*) AS n FROM held_entry");
  const refused = await db.getOptional<{ n: number }>("SELECT COUNT(*) AS n FROM upload_issue");
  return Number(held?.n ?? 0) + Number(refused?.n ?? 0);
}

/**
 * Sends the held entries in their owner's name, then their refusals' copies (see the module
 * comment). The caller has checked `handOverRefusal` and opened the held database.
 */
export async function handOverHeldWork(deps: HandOverDeps): Promise<HandOverResult> {
  const owner = deps.held.tenantUserId;
  if (!owner || !deps.held.tenantId) throw new HandOverNotAllowedError("unknown_owner");
  // The signer's report first: the server binds them to the device and learns the hold's count.
  if (!(await deps.sendReport().catch(() => false))) {
    return {
      sent: 0,
      parked: 0,
      copied: 0,
      remaining: await stillOnDevice(deps.db),
      stopped: "offline",
    };
  }
  const rows = await deps.db.getAll<HeldEntryRow>(
    "SELECT id, tenant_id, person_id, record_table, op, payload FROM held_entry ORDER BY position, id",
  );
  let sent = 0;
  let parked = 0;
  let stopped: HandOverResult["stopped"] = null;
  let reason: string | undefined;
  for (const row of rows) {
    const outcome = await sendEntry(deps, row, owner);
    if (outcome === "session" || outcome === "offline") {
      stopped = outcome;
      break;
    }
    if (typeof outcome === "object" && "notTaken" in outcome) {
      stopped = "not_taken";
      reason = outcome.notTaken;
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
  return {
    sent,
    parked,
    copied,
    remaining: await stillOnDevice(deps.db),
    stopped,
    ...(reason ? { reason } : {}),
  };
}

/** What the person sees when the hand-over ends. */
export function handOverMessage(result: HandOverResult): string {
  if (result.remaining === 0) return t("mobile.held.handOverDone", { count: result.sent });
  if (result.stopped === "not_taken") {
    return t("mobile.held.handOverNotTaken", {
      sent: result.sent,
      reason: result.reason ?? t("mobile.issues.unknownReason"),
    });
  }
  return t("mobile.held.handOverPartial", { sent: result.sent, remaining: result.remaining });
}
