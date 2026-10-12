/**
 * The server's copy of a care entry the API refused from a device (care.md section 6, Device
 * integrity part 5; HZ-006, HZ-008, HZ-011): what the device held, why it was refused and who wrote
 * it, so a refused entry is never only on one phone, and a review task for the nurse in charge.
 *
 * - The copy is written in the system's view once per entry id (a replay from the same author
 *   returns it; another author is refused), with the person's location, or with no person and the
 *   author's location when the device named no person known here. It is append-only and read like
 *   the care record it would have been.
 * - Each copy joins the person's one open review task (`care.refused_entry_review`: the nurse in
 *   charge, `care.plan.write`, due at once; urgent when any copy is an observation, because it may
 *   belong in the day's totals), whose details list the copies by kind, entry id, copy id, refusal
 *   code, time, device and author, never content. A copy about nobody joins its author's one open
 *   task at that location. The open-task index keeps one task per source.
 */
import type { RefusedEntryItem, SyncRefusedEntry } from "@harbour/contracts";
import { person, refusedEntry, type Transaction, task } from "@harbour/db";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { auditInTx } from "../http/audit";
import type { TenantAccess } from "../http/context";
import { problems } from "../http/problem";
import { appendTaskDetail } from "./care";
import { inSystemView, memberLocations } from "./devices";

type Db = Parameters<typeof inSystemView>[0];

export const REFUSED_REVIEW_TASK_KIND = "care.refused_entry_review";
/** The audit action of a copy received. */
export const REFUSED_COPY_ACTION = "sync.refused_entry.copied";
/** The audit action of a copy read. */
export const REFUSED_READ_ACTION = "care.refused_entry.read";

const OPEN = ["open", "in_progress"];

/** Copies about nobody known wait on their author's task at a location. */
const AUTHOR_SOURCE = "tenant_user";

function iso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/**
 * The review task a copy joins (the person's, or the author's at a location), raised when none is
 * open and brought to urgent when an observation joins it. Returns its id.
 */
async function reviewTask(
  tx: Transaction,
  input: {
    readonly personId: string | null;
    readonly locationId: string | null;
    readonly author: string;
    readonly observation: boolean;
    readonly now: Date;
  },
): Promise<string | null> {
  const source = input.personId
    ? { sourceType: "person", sourceId: input.personId }
    : { sourceType: AUTHOR_SOURCE, sourceId: input.author };
  const find = () =>
    tx
      .select({ id: task.id, priority: task.priority })
      .from(task)
      .where(
        and(
          eq(task.kind, REFUSED_REVIEW_TASK_KIND),
          eq(task.sourceType, source.sourceType),
          eq(task.sourceId, source.sourceId),
          input.locationId ? eq(task.locationId, input.locationId) : isNull(task.locationId),
          inArray(task.status, OPEN),
          isNull(task.deletedAt),
        ),
      )
      .limit(1);
  let [open] = await find();
  if (!open) {
    await tx
      .insert(task)
      .values({
        kind: REFUSED_REVIEW_TASK_KIND,
        title: "Review entries a device could not save",
        requiredPermission: "care.plan.write",
        personId: input.personId,
        locationId: input.locationId,
        ...source,
        assigneeRoleKey: "clinical_lead",
        dueAt: input.now,
        priority: input.observation ? "urgent" : "routine",
      })
      // One open review per source (the open-task index, part 4): a racing copy joins it.
      .onConflictDoNothing();
    [open] = await find();
  }
  if (!open) return null;
  if (input.observation && open.priority !== "urgent") {
    await tx.update(task).set({ priority: "urgent" }).where(eq(task.id, open.id));
  }
  return open.id;
}

/**
 * Keeps the server's copy of a refused entry and adds it to its review task (see the module
 * comment). `author` is who wrote the entry: the caller, or the owner of handed-over entries.
 */
export async function copyRefusedEntry(
  db: Db,
  access: TenantAccess,
  body: SyncRefusedEntry,
  input: {
    readonly author: string;
    readonly deviceId: string | null;
    readonly now: Date;
    readonly requestId: string | undefined;
    readonly handoverId?: string | undefined;
  },
): Promise<{ id: string; taskId: string | null; replay: boolean }> {
  const entryId = body.entryId.toLowerCase();
  const claimedId = body.payload.id;
  if (claimedId !== undefined && String(claimedId).toLowerCase() !== entryId) {
    throw problems.invalid("The entry's content names another entry.");
  }
  const claimedPerson = body.payload.person_id;
  if (
    claimedPerson !== undefined &&
    claimedPerson !== null &&
    String(claimedPerson).toLowerCase() !== (body.personId ?? "").toLowerCase()
  ) {
    throw problems.invalid("The entry's content names another person.");
  }
  return inSystemView(db, access, async (tx) => {
    const [existing] = await tx
      .select({
        id: refusedEntry.id,
        author: refusedEntry.authorTenantUserId,
        taskId: refusedEntry.reviewTaskId,
      })
      .from(refusedEntry)
      .where(eq(refusedEntry.entryId, entryId));
    if (existing) {
      if (existing.author !== input.author) throw problems.invalid("That id is already used.");
      return { id: existing.id, taskId: existing.taskId, replay: true };
    }
    const [who] = body.personId
      ? await tx
          .select({ id: person.id, locationId: person.locationId })
          .from(person)
          .where(eq(person.id, body.personId))
      : [];
    const locationId =
      who?.locationId ??
      (await memberLocations(tx, [input.author], input.now)).get(input.author)?.[0] ??
      null;
    const refusedAt = new Date(Math.min(new Date(body.refusedAt).getTime(), input.now.getTime()));
    const taskId = await reviewTask(tx, {
      personId: who?.id ?? null,
      locationId,
      author: input.author,
      observation: body.table === "observation",
      now: input.now,
    });
    const [created] = await tx
      .insert(refusedEntry)
      .values({
        entryId,
        recordTable: body.table,
        personId: who?.id ?? null,
        locationId,
        payload: body.payload,
        httpStatus: body.httpStatus,
        refusalCode: body.code,
        refusalMessage: body.message,
        refusedAt,
        authorTenantUserId: input.author,
        deviceId: input.deviceId,
        reviewTaskId: taskId,
      })
      .onConflictDoNothing()
      .returning({ id: refusedEntry.id });
    if (!created) throw problems.invalid("That id is already used.");
    if (taskId) {
      await appendTaskDetail(tx, taskId, "entries", [
        {
          kind: body.table,
          clientId: entryId,
          refusedEntryId: created.id,
          refusalCode: body.code,
          occurredAt: iso(body.payload.occurred_at),
          deviceId: input.deviceId,
          recordedBy: input.author,
          at: input.now.toISOString(),
        },
      ]);
    }
    await auditInTx(tx, access, {
      action: REFUSED_COPY_ACTION,
      resourceType: "refused_entry",
      resourceId: created.id,
      scope: {
        entryId,
        table: body.table,
        personId: who?.id ?? null,
        code: body.code,
        httpStatus: body.httpStatus,
        authorTenantUserId: input.author,
        taskId,
        ...(input.handoverId ? { handoverId: input.handoverId } : {}),
      },
      requestId: input.requestId,
    });
    return { id: created.id, taskId, replay: false };
  });
}

/** A copy as the API returns it. */
export function refusedEntryOut(row: typeof refusedEntry.$inferSelect): RefusedEntryItem {
  return {
    id: row.id,
    entryId: row.entryId,
    table: row.recordTable as RefusedEntryItem["table"],
    personId: row.personId,
    locationId: row.locationId,
    payload: row.payload as Record<string, unknown>,
    httpStatus: row.httpStatus,
    code: row.refusalCode,
    message: row.refusalMessage,
    refusedAt: row.refusedAt.toISOString(),
    receivedAt: row.createdAt.toISOString(),
    authorTenantUserId: row.authorTenantUserId,
    sentByTenantUserId: row.createdBy,
    deviceId: row.deviceId,
    reviewTaskId: row.reviewTaskId,
  };
}

/** The copies about a person, newest first, under the reader's row-level security. */
export async function refusedEntriesFor(tx: Transaction, personId: string) {
  return tx
    .select()
    .from(refusedEntry)
    .where(eq(refusedEntry.personId, personId))
    .orderBy(desc(refusedEntry.refusedAt))
    .limit(200);
}
