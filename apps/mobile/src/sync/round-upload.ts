/**
 * Turns a queued round or handover change into a request to the API's own route for it
 * (`round-actions.ts` writes them): a task's move to `POST /v1/tasks/{id}/transition` with the
 * version the carer saw, and an acknowledgement to
 * `POST /v1/locations/{locationId}/handovers/{handoverId}/acknowledgements` with its device id and
 * seen token. `POST /v1/sync/upload` writes neither.
 *
 * When the API says the task changed before a move reached it (409 `version_conflict`), the
 * connector reads the task as the API has it (`taskStatePath`, `taskStateIn`) and decides here
 * (`settleMove`): the carer's own move already made (a lost response, HZ-029), or words that say
 * what happened to the task. A move the API refused is never sent again on its own, even to a task
 * still open: a stale "done" could close what was added to the task since (#37 review round 2).
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

/** What can still be read of a move that is not a valid one: its id, tenant and person. */
function readableParts(value: unknown): {
  readonly id: string | null;
  readonly tenantId: string | null;
  readonly personId: string | null;
} {
  if (typeof value !== "string") return { id: null, tenantId: null, personId: null };
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) {
      return { id: null, tenantId: null, personId: null };
    }
    const m = parsed as Record<string, unknown>;
    return { id: text(m.id), tenantId: text(m.tenantId), personId: text(m.personId) };
  } catch {
    return { id: null, tenantId: null, personId: null };
  }
}

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
      // Kept under the move's own id and tenant when they can still be read, so it never replaces
      // another record for the task; otherwise under the task's id (STATUS item 15 follow-up).
      const partial = readableParts(data.queued_transition);
      return {
        kind: "refused",
        table: "task",
        recordId: partial.id ?? entry.id,
        tenantId: partial.tenantId ?? text(data.tenant_id),
        personId: partial.personId ?? text(data.person_id),
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
 * The words kept with a refusal: the phone's own for a handover that changed before the
 * acknowledgement reached Harbour, otherwise the API's reason. A move refused because its task
 * changed is worded from the task as it now is (`settleMove`).
 */
export function roundRefusalMessage(
  table: RoundWritableTable,
  code: string,
  reason: string | null,
): string | null {
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
const CLOSED_STATUSES: readonly string[] = ["done", "skipped", "cancelled"] satisfies TaskStatus[];

/** What becomes of a move the API refused because its task changed. */
export type SettledMove =
  | { readonly kind: "made" }
  | { readonly kind: "parked"; readonly code: string; readonly message: string };

const parked = (code: string, message: string): SettledMove => ({ kind: "parked", code, message });

/**
 * Settles a move the API refused because its task changed (409), from the task as the API now has
 * it (null when the list it sent does not have the task). Only the carer's own move, already made,
 * counts as sent (HZ-029). Anything else is kept as needing attention and never sent again, with
 * words that are true of the task (#37 review round 2):
 *
 * - not in the list: it could not be found;
 * - still open or in progress: it changed after the carer marked it (a new assignee, an
 *   escalation, or more added to it), so they check it and mark it again;
 * - done or not done by someone else, or cancelled: what happened to it, and that the carer's
 *   change was not recorded;
 * - done or not done in the carer's own name, but not as this move: whether it was saved cannot
 *   be told.
 */
export function settleMove(state: TaskState | null, move: RoundMove): SettledMove {
  if (state === null) return parked("task_not_found", t("mobile.round.taskNotFound"));
  if (moveMade(state, move)) return { kind: "made" };
  if (OPEN_STATUSES.includes(state.status)) {
    return parked("task_changed", t("mobile.round.taskChanged"));
  }
  if (
    (state.status === "done" || state.status === "skipped") &&
    move.by !== null &&
    state.completedBy === move.by
  ) {
    return parked("task_unchecked", t("mobile.round.taskUnchecked"));
  }
  const status = CLOSED_STATUSES.includes(state.status) ? state.status : "other";
  return parked("version_conflict", t("mobile.round.taskNow", { status }));
}
