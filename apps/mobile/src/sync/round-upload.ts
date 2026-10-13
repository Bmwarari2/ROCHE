/**
 * Turns a queued round or handover change into a request to the API's own route for it
 * (`round-actions.ts` writes them): a task's move to `POST /v1/tasks/{id}/transition` with the
 * version the carer saw, and an acknowledgement to
 * `POST /v1/locations/{locationId}/handovers/{handoverId}/acknowledgements` with its device id and
 * seen token. `POST /v1/sync/upload` writes neither.
 *
 * When the API says the task changed before a move reached it (409 `version_conflict`), the
 * connector reads the task as the API has it (`taskStatePath`, `taskStateIn`) and decides here: the
 * carer's own move already made (a lost response, HZ-029), the task still open so the move goes
 * again once against the current version, or words that say what happened to it (#37 review
 * round 1).
 *
 * Pure, so the mapping is tested without a device. A change that cannot become a valid request is
 * refused here, with a reason, rather than sent; the connector keeps it as "needs attention".
 */
import type { AcknowledgeHandover, TaskStatus, TaskTransitionRequest } from "@harbour/contracts";
import { ROUND_WRITABLE_TABLES, type RoundWritableTable } from "@harbour/sync/client";
import { parseQueuedMove, type QueuedTaskMove } from "../care/round-actions";
import { parseInstant } from "../care/time";
import { t } from "../i18n/t";
import type { CrudEntryLike } from "./connector";

export function isRoundWritableTable(table: string): table is RoundWritableTable {
  return (ROUND_WRITABLE_TABLES as readonly string[]).includes(table);
}

/** A queued move with the task it is on. */
export type RoundMove = QueuedTaskMove & { readonly taskId: string };

export interface RoundUploadRequest {
  readonly kind: "request";
  readonly table: RoundWritableTable;
  /** The move's or the acknowledgement's own id: the idempotency key and "needs attention" id. */
  readonly recordId: string;
  readonly tenantId: string;
  readonly personId: string | null;
  readonly path: string;
  readonly body: TaskTransitionRequest | AcknowledgeHandover;
  /** For a task's move: what the carer did, to recognise it when the API says the task changed. */
  readonly move: RoundMove | null;
}

export interface RoundUploadRefusal {
  readonly kind: "refused";
  readonly table: RoundWritableTable;
  readonly recordId: string;
  readonly tenantId: string | null;
  readonly personId: string | null;
  readonly code: "round_change_unreadable";
  readonly message: string;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

const segment = encodeURIComponent;

/**
 * Maps one queued change to its API request, or says why it cannot be sent. A move is an update of
 * the synced task, or the task's row put back with it after the session that recorded it ended
 * (`held-work.ts`). The move's device time stays on the phone: the API records the completion when
 * the move arrives, which errs towards looking late, until tasks keep the time of care, the time
 * received and a late flag where people see them (STATUS item 15 follow-up; H-309).
 */
export function toRoundUpload(
  entry: CrudEntryLike & { readonly table: RoundWritableTable },
): RoundUploadRequest | RoundUploadRefusal {
  const data = entry.opData ?? {};
  if (entry.table === "task") {
    // The device changes a task only by queuing a move on it.
    const move =
      entry.op === "PATCH" || entry.op === "PUT" ? parseQueuedMove(data.queued_transition) : null;
    if (!move) {
      return {
        kind: "refused",
        table: "task",
        recordId: entry.id,
        tenantId: null,
        personId: null,
        code: "round_change_unreadable",
        message: t("mobile.round.moveUnreadable"),
      };
    }
    const body: TaskTransitionRequest = {
      to: move.to,
      ...(move.reason ? { reason: move.reason } : {}),
      version: move.version,
    };
    return {
      kind: "request",
      table: "task",
      recordId: move.id,
      tenantId: move.tenantId,
      personId: move.personId,
      path: `/v1/tasks/${segment(entry.id)}/transition`,
      body,
      move: { ...move, taskId: entry.id },
    };
  }
  const tenantId = text(data.tenant_id);
  const handoverId = text(data.handover_id);
  const locationId = text(data.location_id);
  const token = text(data.seen_token);
  // Acknowledgements are append-only: the device only inserts them.
  if (entry.op !== "PUT" || !tenantId || !handoverId || !locationId || !token) {
    return {
      kind: "refused",
      table: "handover_acknowledgement",
      recordId: entry.id,
      tenantId,
      personId: null,
      code: "round_change_unreadable",
      message: t("mobile.handover.acknowledgementUnreadable"),
    };
  }
  return {
    kind: "request",
    table: "handover_acknowledgement",
    recordId: entry.id,
    tenantId,
    personId: null,
    path: `/v1/locations/${segment(locationId)}/handovers/${segment(handoverId)}/acknowledgements`,
    body: { id: entry.id, seenToken: token },
    move: null,
  };
}

/**
 * The words kept with a refusal: the phone's own for the two refusals a carer must act on (the
 * task changed before the move reached Harbour; the handover changed before the acknowledgement
 * did), otherwise the API's reason.
 */
export function roundRefusalMessage(
  table: RoundWritableTable,
  code: string,
  reason: string | null,
): string | null {
  if (table === "task" && code === "version_conflict") return t("mobile.round.taskChanged");
  if (table === "handover_acknowledgement" && code === "handover_changed") {
    return t("mobile.handover.changed");
  }
  return reason;
}

/** The task as the API has it, read after it said the task changed. */
export interface TaskState {
  readonly status: string;
  readonly version: number;
  readonly completedBy: string | null;
  readonly statusReason: string | null;
  readonly completedAt: string | null;
}

/**
 * The task list query that finds the task (the list has no single-task read): any status, about
 * the person the move is about (or at the task's home when it is about nobody), due within a
 * second of the task's due time when it is known.
 */
export function taskStatePath(move: RoundMove): string {
  const query = ["status=any"];
  if (move.personId) query.push(`personId=${segment(move.personId)}`);
  else if (move.locationId) query.push(`locationId=${segment(move.locationId)}`);
  const due = parseInstant(move.dueAt)?.getTime();
  if (due !== undefined) {
    query.push(`from=${segment(new Date(due - 1000).toISOString())}`);
    query.push(`to=${segment(new Date(due + 1000).toISOString())}`);
  }
  return `/v1/tasks?${query.join("&")}`;
}

function textOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

/**
 * The task in the API's answer: its state, null when the answer is a list without it (deleted, or
 * no longer anywhere the carer may see), or "unreadable" when the answer is not a list or the task
 * in it cannot be read, which decides nothing.
 */
export function taskStateIn(list: unknown, taskId: string): TaskState | null | "unreadable" {
  if (typeof list !== "object" || list === null) return "unreadable";
  const items = (list as { items?: unknown }).items;
  if (!Array.isArray(items)) return "unreadable";
  const item = items.find(
    (i): i is Record<string, unknown> => typeof i === "object" && i !== null && i.id === taskId,
  );
  if (!item) return null;
  const completedBy = textOrNull(item.completedBy);
  const statusReason = textOrNull(item.statusReason);
  const completedAt = textOrNull(item.completedAt);
  if (
    typeof item.status !== "string" ||
    typeof item.version !== "number" ||
    !Number.isInteger(item.version) ||
    completedBy === undefined ||
    statusReason === undefined ||
    completedAt === undefined
  ) {
    return "unreadable";
  }
  return { status: item.status, version: item.version, completedBy, statusReason, completedAt };
}

/**
 * Whether the task shows this move as made, so its response was lost (HZ-029): the status the
 * carer chose, by them, with their reason for a task not done, at the very next version after the
 * one they saw. A move by someone else, or another move by the same carer, is not this one.
 */
export function moveMade(state: TaskState, move: RoundMove): boolean {
  if (!move.by || state.status !== move.to || state.completedBy !== move.by) return false;
  if (move.to === "skipped" && state.statusReason !== move.reason) return false;
  return state.version === move.version + 1;
}

const OPEN_STATUSES: readonly string[] = ["open", "in_progress"] satisfies TaskStatus[];

/**
 * Whether the move goes again against the task's current version: nobody closed the task (it is
 * open or in progress), only something else about it changed, such as who it is given to. The
 * API judges the move again when it arrives.
 */
export function mayResend(state: TaskState, move: RoundMove): boolean {
  return OPEN_STATUSES.includes(state.status) && state.version > move.version;
}

const CLOSED_STATUSES: readonly string[] = ["done", "skipped", "cancelled"] satisfies TaskStatus[];

/**
 * What happened to a task the move did not reach in time, in words a carer can act on: marked
 * done, marked not done, cancelled, or otherwise changed (including a task no longer in the list).
 */
export function overtakenMessage(state: TaskState | null): string {
  const status = state && CLOSED_STATUSES.includes(state.status) ? state.status : "other";
  return t("mobile.round.taskNow", { status });
}
