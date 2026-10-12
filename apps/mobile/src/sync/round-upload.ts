/**
 * Turns a queued round or handover change into a request to the API's own route for it
 * (`round-actions.ts` writes them): a task's move to `POST /v1/tasks/{id}/transition` with the
 * version the carer saw, and an acknowledgement to
 * `POST /v1/locations/{locationId}/handovers/{handoverId}/acknowledgements` with its device id and
 * seen token. `POST /v1/sync/upload` writes neither.
 *
 * Pure, so the mapping is tested without a device. A change that cannot become a valid request is
 * refused here, with a reason, rather than sent; the connector keeps it as "needs attention".
 */
import type { AcknowledgeHandover, TaskTransitionRequest } from "@harbour/contracts";
import { ROUND_WRITABLE_TABLES, type RoundWritableTable } from "@harbour/sync/client";
import { parseQueuedMove, type QueuedTaskMove } from "../care/round-actions";
import { parseInstant } from "../care/time";
import { t } from "../i18n/t";
import type { CrudEntryLike } from "./connector";

export function isRoundWritableTable(table: string): table is RoundWritableTable {
  return (ROUND_WRITABLE_TABLES as readonly string[]).includes(table);
}

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
  readonly move: (QueuedTaskMove & { readonly taskId: string }) | null;
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

/** Maps one queued change to its API request, or says why it cannot be sent. */
export function toRoundUpload(
  entry: CrudEntryLike & { readonly table: RoundWritableTable },
): RoundUploadRequest | RoundUploadRefusal {
  const data = entry.opData ?? {};
  if (entry.table === "task") {
    // The device changes a task only by queuing a move on it.
    const move = entry.op === "PATCH" ? parseQueuedMove(data.queued_transition) : null;
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
    return {
      kind: "request",
      table: "task",
      recordId: move.id,
      tenantId: move.tenantId,
      personId: move.personId,
      path: `/v1/tasks/${segment(entry.id)}/transition`,
      body: {
        to: move.to,
        ...(move.reason ? { reason: move.reason } : {}),
        version: move.version,
      },
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

/**
 * Whether the API's task list shows the move as already made by the carer: the response to a move
 * it took was lost, and the move sent again met the new version (409). Anything else, or a list
 * that cannot be read, is not.
 */
export function moveAlreadyMade(
  list: unknown,
  move: QueuedTaskMove & { readonly taskId: string },
): boolean {
  if (!move.by || typeof list !== "object" || list === null) return false;
  const items = (list as { items?: unknown }).items;
  if (!Array.isArray(items)) return false;
  return items.some((item) => {
    if (typeof item !== "object" || item === null) return false;
    const i = item as Record<string, unknown>;
    return i.id === move.taskId && i.status === move.to && i.completedBy === move.by;
  });
}

/** The task list query that finds the task by its due time (the list has no single-task read). */
export function moveCheckPath(move: QueuedTaskMove & { readonly taskId: string }): string | null {
  const due = parseInstant(move.dueAt)?.getTime();
  if (due === undefined) return null;
  const from = new Date(due - 1000).toISOString();
  const to = new Date(due + 1000).toISOString();
  return `/v1/tasks?status=closed&from=${segment(from)}&to=${segment(to)}`;
}
