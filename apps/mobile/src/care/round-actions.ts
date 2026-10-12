/**
 * Moving a task and acknowledging a handover on the phone, offline (care.md rule 8 and section 6;
 * CARE-013, COMMS-006). Both are written to the encrypted database in their own transaction, so
 * they join PowerSync's upload queue and survive a restart, and the connector sends each to the
 * API's own route (`round-upload.ts`):
 *
 * - A task marked done or not done (skipped, with a reason) is an update of the synced row that
 *   carries the move in `queued_transition`: its own id, the version the carer saw (the API refuses
 *   a stale move), who and when. A task that needs evidence is done by recording the entry it asks
 *   for (`EntryContext.taskId`), never by a tap. If the API refuses the move, the server's copy
 *   puts the task back as it is there, and the move shows as "needs attention" (HZ-006).
 * - An acknowledgement is a new row (append-only, a UUIDv7 from the device) with the seen token
 *   worked out, as the API does, over the keys of the items the reader was shown. The API records
 *   the items it shows them and refuses the token when they differ (409), so nobody acknowledges
 *   an item the phone did not show (HZ-018).
 *
 * Pure apart from the injected database and digest, so the rules are unit-tested.
 */
import { checkTaskTransition, MIN_TASK_REASON_LENGTH, type TaskStatus } from "@harbour/domain";
import type { MessageKey } from "../i18n/t";
import { type FieldError, flag, type SqlValue } from "./entries";

/** API limit from `@harbour/contracts` (`TaskTransitionRequest.reason`); a test keeps them equal. */
export const TASK_REASON_MAX = 500;

export type TaskMoveTo = "done" | "skipped";

/** A move waiting to upload, kept as JSON in `task.queued_transition`. */
export interface QueuedTaskMove {
  /** UUIDv7 from the device: the upload's idempotency key and its "needs attention" id. */
  readonly id: string;
  readonly to: TaskMoveTo;
  readonly reason: string | null;
  /** The task's version when the carer moved it. */
  readonly version: number;
  /** The tenant_user id of the carer, to recognise their own move when the API says it changed. */
  readonly by: string | null;
  /** Device time of the move. */
  readonly at: string;
  readonly tenantId: string;
  readonly personId: string | null;
  readonly dueAt: string | null;
  /** The task's title (free text, as the round shows it), so "needs attention" can say which. */
  readonly title: string;
}

/** The synced task row, as the round reads it. */
export interface TaskToMove {
  readonly id: string;
  readonly tenant_id: string;
  readonly person_id: string | null;
  readonly title: string | null;
  readonly status: string | null;
  readonly due_at: string | null;
  readonly evidence_required: number | null;
  readonly version: number | null;
  readonly queued_transition: string | null;
}

export interface MoveContext {
  readonly userId: string | null;
  readonly newId: () => string;
}

export type TaskMoveCheck =
  | {
      readonly ok: true;
      readonly taskId: string;
      readonly move: QueuedTaskMove;
      readonly sql: string;
      readonly params: SqlValue[];
    }
  | { readonly ok: false; readonly error: FieldError };

/**
 * Moves the row only while it is still the open task the carer saw, with nothing queued on it, so
 * a second tap or a stale screen changes nothing.
 */
export const QUEUE_TASK_MOVE_SQL = `UPDATE task SET status = ?, queued_transition = ?
  WHERE id = ? AND tenant_id = ? AND version = ? AND queued_transition IS NULL
    AND status IN ('open', 'in_progress')`;

const STATUS_KEYS: Record<string, MessageKey> = {
  terminal: "mobile.round.notOpen",
  not_allowed: "mobile.round.notOpen",
  reason_required: "mobile.round.reasonRequired",
  evidence_required: "mobile.round.evidenceRequired",
};

/** Checks a move against the API's own rules (`checkTaskTransition`) and builds its update. */
export function checkTaskMove(
  task: TaskToMove,
  draft: { readonly to: TaskMoveTo; readonly reason: string },
  context: MoveContext,
  now: Date,
): TaskMoveCheck {
  if (task.queued_transition) return { ok: false, error: { key: "mobile.round.alreadyQueued" } };
  if (task.version === null || (task.status !== "open" && task.status !== "in_progress")) {
    return { ok: false, error: { key: "mobile.round.notOpen" } };
  }
  const reason = draft.to === "skipped" ? draft.reason.trim() : "";
  const check = checkTaskTransition(task.status as TaskStatus, {
    to: draft.to,
    reason,
    evidenceRequired: flag(task.evidence_required),
  });
  if (!check.ok) {
    const key = STATUS_KEYS[check.problem] ?? "mobile.round.notOpen";
    return {
      ok: false,
      error:
        check.problem === "reason_required"
          ? { key, values: { min: MIN_TASK_REASON_LENGTH } }
          : { key },
    };
  }
  if (reason.length > TASK_REASON_MAX) {
    return {
      ok: false,
      error: { key: "mobile.round.reasonTooLong", values: { max: TASK_REASON_MAX } },
    };
  }
  const move: QueuedTaskMove = {
    id: context.newId(),
    to: draft.to,
    reason: reason || null,
    version: task.version,
    by: context.userId,
    at: now.toISOString(),
    tenantId: task.tenant_id,
    personId: task.person_id,
    dueAt: task.due_at,
    title: task.title ?? "",
  };
  return {
    ok: true,
    taskId: task.id,
    move,
    sql: QUEUE_TASK_MOVE_SQL,
    params: [draft.to, JSON.stringify(move), task.id, task.tenant_id, task.version],
  };
}

/** Reads a queued move back; null when it is missing or unreadable. */
export function parseQueuedMove(value: unknown): QueuedTaskMove | null {
  if (typeof value !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const m = parsed as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  const id = text(m.id);
  const tenantId = text(m.tenantId);
  const at = text(m.at);
  if (
    !id ||
    !tenantId ||
    !at ||
    (m.to !== "done" && m.to !== "skipped") ||
    typeof m.version !== "number" ||
    !Number.isInteger(m.version) ||
    m.version < 1
  ) {
    return null;
  }
  return {
    id,
    to: m.to,
    reason: text(m.reason),
    version: m.version,
    by: text(m.by),
    at,
    tenantId,
    personId: text(m.personId),
    dueAt: text(m.dueAt),
    title: text(m.title) ?? "",
  };
}

/** The handover being acknowledged, as synced. */
export interface HandoverToAcknowledge {
  readonly id: string;
  readonly tenant_id: string;
  readonly location_id: string;
}

/** An item the reader was shown. */
export interface ShownItem {
  readonly item_key: string;
  readonly position: number;
}

/** SHA-256 of the text as standard base64 (expo-crypto on the device). */
export type Sha256Base64 = (text: string) => Promise<string>;

/**
 * The API's seen token (`seenToken` in apps/api/src/routes/handovers.ts): SHA-256 over the
 * handover id and the item keys in order, one per line, as base64url, 43 characters.
 */
export async function seenToken(
  handoverId: string,
  keys: readonly string[],
  sha256Base64: Sha256Base64,
): Promise<string> {
  const base64 = await sha256Base64([handoverId, ...keys].join("\n"));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 43);
}

/** The new acknowledgement row and its insert, over the items shown in their compiled order. */
export async function acknowledgementInsert(
  handover: HandoverToAcknowledge,
  shown: readonly ShownItem[],
  context: MoveContext & { readonly sha256Base64: Sha256Base64 },
  now: Date,
): Promise<{ readonly id: string; readonly sql: string; readonly params: SqlValue[] }> {
  const keys = [...shown].sort((a, b) => a.position - b.position).map((i) => i.item_key);
  const row: Record<string, SqlValue> = {
    id: context.newId(),
    tenant_id: handover.tenant_id,
    handover_id: handover.id,
    tenant_user_id: context.userId,
    // Shown until the server's copy, with the keys it recorded, replaces it.
    item_keys: JSON.stringify(keys),
    acknowledged_at: now.toISOString(),
    location_id: handover.location_id,
    seen_token: await seenToken(handover.id, keys, context.sha256Base64),
  };
  const columns = Object.keys(row);
  return {
    id: String(row.id),
    sql: `INSERT INTO handover_acknowledgement (${columns.join(", ")}) VALUES (${columns
      .map(() => "?")
      .join(", ")})`,
    params: columns.map((c) => row[c] ?? null),
  };
}

/** The part of the PowerSync database the writes need. */
export interface WriteDb {
  writeTransaction<T>(
    fn: (tx: {
      execute(sql: string, params?: SqlValue[]): Promise<unknown>;
      getOptional<R>(sql: string, params?: SqlValue[]): Promise<R | null>;
    }) => Promise<T>,
  ): Promise<T>;
}

/** The task changed on the device before the move was written (synced, or moved already). */
export class TaskMoveNotWritten extends Error {
  constructor() {
    super("The task changed before the move was written");
    this.name = "TaskMoveNotWritten";
  }
}

/**
 * Writes a checked move in its own transaction, and rolls it back when the row was no longer the
 * one seen. Read back rather than counted: SQLite does not count changes made through PowerSync's
 * views.
 */
export async function writeTaskMove(
  db: WriteDb,
  check: Extract<TaskMoveCheck, { ok: true }>,
): Promise<void> {
  await db.writeTransaction(async (tx) => {
    await tx.execute(check.sql, check.params);
    const row = await tx.getOptional<{ queued_transition: string | null }>(
      "SELECT queued_transition FROM task WHERE id = ?",
      [check.taskId],
    );
    if (parseQueuedMove(row?.queued_transition)?.id !== check.move.id) {
      throw new TaskMoveNotWritten();
    }
  });
}

/** Writes an acknowledgement in its own transaction: one acknowledgement, one upload. */
export async function writeAcknowledgement(
  db: WriteDb,
  insert: { readonly sql: string; readonly params: SqlValue[] },
): Promise<void> {
  await db.writeTransaction(async (tx) => {
    await tx.execute(insert.sql, insert.params);
  });
}
