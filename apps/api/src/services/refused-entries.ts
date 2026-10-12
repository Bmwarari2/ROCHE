/**
 * The server's copy of a care entry the API refused from a device (care.md section 6, Device
 * integrity part 5; HZ-006, HZ-008, HZ-011): what the device held, why it was refused and who wrote
 * it, so a refused entry is never only on one phone, and a review task for the nurse in charge.
 *
 * - The content is the request the device made for the entry, checked against that kind's own
 *   contract (#25 review round 2, M2). A copy about a person is taken only when its author cared
 *   for them within the offline window (`personReachedBy`); otherwise, as for an id unknown here,
 *   it is refused the same way, so a copy never says whether a person exists. A handed-over copy is
 *   planned against the device's hold like the entry it is (its owner's care judged from the
 *   entry's own time) and admitted in the copy's transaction (#25 review round 3, low).
 * - The copy is written in the system's view once per entry id (a replay from the same author
 *   returns it; another author is refused), with the person's location, or with no person and the
 *   author's location when the device named no person. It is append-only and read like the care
 *   record it would have been. The author's daily limit is counted after the replay check and the
 *   checks above, in the author's own view (a hand-over's copies count against their owner).
 * - Each copy joins the person's one open review task (`care.refused_entry_review`: the nurse in
 *   charge, `care.plan.write`, due at once; urgent when any copy is an observation, because it may
 *   belong in the day's totals, or a body-map mark that may be harm (a pressure ulcer of category
 *   2 or worse, a bruise, a skin tear, laceration, burn or wound; #26 review round 2, C4), and the
 *   nurse in charge is told when it becomes urgent), whose
 *   details list the copies by kind, entry id, copy id, refusal code, time, device and author,
 *   never content. A copy about nobody joins its author's one open task at that location. The
 *   open-task index keeps one task per source; overdue, the task escalates like the sync tasks,
 *   with a fallback when no one at the location can act (#25 review round 2, M3). With no nurse in
 *   charge at the location, the urgent notice goes to that fallback (round 3, low).
 */
import type { RefusedEntryItem, SyncRefusedEntry } from "@harbour/contracts";
import {
  notification,
  person,
  refusedEntry,
  type Transaction,
  task,
  withRequestContext,
} from "@harbour/db";
import type { Permission } from "@harbour/domain";
import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { auditInTx } from "../http/audit";
import type { TenantAccess } from "../http/context";
import { problems } from "../http/problem";
import type { PerUserQuota } from "../http/quota";
import { appendTaskDetail, nurseInCharge } from "./care";
import { fallbackRecipients, REFUSED_REVIEW_TASK_KIND } from "./device-holds";
import {
  ENTRY_PERMISSION,
  inSystemView,
  memberLocations,
  offlineWindowDaysOf,
  personReachedBy,
} from "./devices";
import { type HandedOverAdmission, recordHandedOverEntry } from "./held-handover";
import type { StaffLookup } from "./staff";
import { membersSeeingPerson } from "./staff-views";

type Db = Parameters<typeof inSystemView>[0];

export { REFUSED_REVIEW_TASK_KIND };
/** The audit action of a copy received. */
export const REFUSED_COPY_ACTION = "sync.refused_entry.copied";
/** The audit action of a copy read. */
export const REFUSED_READ_ACTION = "care.refused_entry.read";

const OPEN = ["open", "in_progress"];
/** Who may act on a review: the nurse in charge, or the fallback when there is none. */
const REVIEW_PERMISSION: Permission = "care.plan.write";

/** Copies about nobody known wait on their author's task at a location. */
const AUTHOR_SOURCE = "tenant_user";
/** The notice the nurse in charge gets when a review becomes urgent (an urgent copy joined it). */
export const REFUSED_URGENT_NOTICE_KIND = "care.refused_entry_urgent";
const DAY_MS = 86_400_000;

/** Marks that may be harm to the person, read on the copy's own request (HZ-019, HZ-006). */
const INJURY_MARK_TYPES: ReadonlySet<string> = new Set([
  "bruise",
  "skin_tear",
  "laceration",
  "burn",
  "wound",
]);

/**
 * Whether a refused entry's review must be urgent: an observation (it may belong in the day's
 * totals), or a body-map mark that may be harm and must not wait on the device unseen (#26 review
 * round 2, C4): a pressure ulcer of category 2 or worse, or with no category readable (it may be
 * worse; #26 review round 3), a bruise, a skin tear, a laceration, a burn or a wound. Only a
 * pressure ulcer recorded as category 1 waits as routine.
 */
export function urgentRefusedCopy(body: Pick<SyncRefusedEntry, "table" | "payload">): boolean {
  if (body.table === "observation") return true;
  if (body.table !== "body_map_mark") return false;
  const mark = body.payload as { markType?: unknown; pressureCategory?: unknown };
  if (mark.markType === "pressure_ulcer") {
    // Category 2 or worse is urgent (`CATEGORY_2_OR_WORSE`); so is a category missing or
    // unreadable, which may be worse. Only category 1 waits as routine.
    return mark.pressureCategory !== "category_1";
  }
  return typeof mark.markType === "string" && INJURY_MARK_TYPES.has(mark.markType);
}

/**
 * The review task a copy joins (the person's, or the author's at a location), raised when none is
 * open and brought to urgent when an urgent copy joins it. Returns its id, and whether it has just
 * become urgent.
 */
async function reviewTask(
  tx: Transaction,
  input: {
    readonly personId: string | null;
    readonly locationId: string | null;
    readonly author: string;
    /** Urgent: an observation, or a body-map mark that may be harm (`urgentRefusedCopy`). */
    readonly urgent: boolean;
    readonly now: Date;
  },
): Promise<{ id: string; becameUrgent: boolean } | null> {
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
  let raised = false;
  if (!open) {
    const made = await tx
      .insert(task)
      .values({
        kind: REFUSED_REVIEW_TASK_KIND,
        title: "Review entries a device could not save",
        requiredPermission: REVIEW_PERMISSION,
        personId: input.personId,
        locationId: input.locationId,
        ...source,
        assigneeRoleKey: "clinical_lead",
        dueAt: input.now,
        priority: input.urgent ? "urgent" : "routine",
      })
      // One open review per source (the open-task index, part 4): a racing copy joins it.
      .onConflictDoNothing()
      .returning({ id: task.id });
    raised = made.length > 0;
    [open] = await find();
  }
  if (!open) return null;
  if (input.urgent && open.priority !== "urgent") {
    await tx.update(task).set({ priority: "urgent" }).where(eq(task.id, open.id));
    return { id: open.id, becameUrgent: true };
  }
  return { id: open.id, becameUrgent: raised && open.priority === "urgent" };
}

/**
 * Tells the nurse in charge at the review's location that it has become urgent (#25 review round
 * 2, M3): an observation a device could not save may belong in the day's totals, and a mark that
 * may be harm must not wait (#26 review round 2, C4); with none at the location, the
 * escalation's fallback (round 3, low). For a review about a person, only those who can open it:
 * `people.person.read` and the review's permission reach the person (ADR-0071 review round 1,
 * C-M4). The notice names no one; the link opens the tasks.
 */
async function noticeUrgentReview(
  tx: Transaction,
  input: {
    readonly taskId: string;
    readonly personId: string | null;
    readonly locationId: string;
    readonly now: Date;
  },
): Promise<void> {
  const inCharge = await nurseInCharge(tx, input.locationId);
  const nurses =
    input.personId === null
      ? inCharge
      : await membersSeeingPerson(tx, inCharge, input.personId, REVIEW_PERMISSION, input.now);
  const recipients =
    nurses.length > 0
      ? nurses
      : await fallbackRecipients(tx, REVIEW_PERMISSION, input.now, input.personId);
  for (const recipient of recipients) {
    await tx
      .insert(notification)
      .values({
        recipientTenantUserId: recipient,
        kind: REFUSED_URGENT_NOTICE_KIND,
        severity: "urgent",
        title: "An entry a device could not save needs review",
        body: "Open the review task to see the entry and why it was not saved.",
        link: "/tasks",
        channels: ["in_app", "push"],
        sourceType: "task",
        sourceId: input.taskId,
        personId: input.personId,
        locationId: input.locationId,
        dedupeKey: `${REFUSED_URGENT_NOTICE_KIND}:${input.taskId}`,
      })
      .onConflictDoNothing();
  }
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
    /** A hand-over's copy, planned against the device's hold (`planHandedOverEntry`). */
    readonly admission?: HandedOverAdmission | null;
    /** The author's daily limit on copies. */
    readonly quota: PerUserQuota;
  },
): Promise<{ id: string; taskId: string | null; replay: boolean }> {
  const entryId = body.entryId.toLowerCase();
  const claimedId = body.payload.id;
  if (claimedId !== undefined && claimedId.toLowerCase() !== entryId) {
    throw problems.invalid("The entry's content names another entry.");
  }
  const existing = () =>
    inSystemView(db, access, async (tx) => {
      const [row] = await tx
        .select({
          id: refusedEntry.id,
          author: refusedEntry.authorTenantUserId,
          taskId: refusedEntry.reviewTaskId,
        })
        .from(refusedEntry)
        .where(eq(refusedEntry.entryId, entryId));
      return row ?? null;
    });
  const replayOf = (row: { id: string; author: string; taskId: string | null }) => {
    if (row.author !== input.author) throw problems.invalid("That id is already used.");
    return { id: row.id, taskId: row.taskId, replay: true };
  };
  const earlier = await existing();
  if (earlier) return replayOf(earlier);
  // Only about someone the author cared for here within the offline window; a person unknown here
  // reads the same (#25 review round 2, M2). A hand-over's plan judged that from the entry's time.
  const personId = body.personId?.toLowerCase() ?? null;
  const handoverId = input.admission?.handover.handoverId;
  if (personId && !input.admission) {
    const reached = await inSystemView(db, access, async (tx) => {
      const days = await offlineWindowDaysOf(tx, access.tenantId);
      const since = new Date(input.now.getTime() - days * DAY_MS);
      return personReachedBy(tx, input.author, personId, since, input.now, ENTRY_PERMISSION);
    });
    if (!reached) {
      throw problems.invalid("This copy names someone the entry's author has not cared for here.");
    }
  }
  // Counted against the author, in their own view, once the copy is known to be new and valid.
  await withRequestContext(
    db,
    { tenantId: access.tenantId, userId: input.author, scope: "none", locationIds: [] },
    (tx) => input.quota.take(tx, input.author),
  );
  const kept = await inSystemView(db, access, async (tx) => {
    const [who] = personId
      ? await tx
          .select({ id: person.id, locationId: person.locationId })
          .from(person)
          .where(eq(person.id, personId))
      : [];
    const locationId =
      who?.locationId ??
      (await memberLocations(tx, [input.author], input.now)).get(input.author)?.[0] ??
      null;
    const refusedAt = new Date(Math.min(new Date(body.refusedAt).getTime(), input.now.getTime()));
    const review = await reviewTask(tx, {
      personId: who?.id ?? null,
      locationId,
      author: input.author,
      urgent: urgentRefusedCopy(body),
      now: input.now,
    });
    const taskId = review?.id ?? null;
    if (input.admission) await recordHandedOverEntry(tx, input.admission);
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
    // A racing copy of the same entry won: answered as a replay below.
    if (!created) return null;
    if (taskId) {
      await appendTaskDetail(tx, taskId, "entries", [
        {
          kind: body.table,
          clientId: entryId,
          refusedEntryId: created.id,
          refusalCode: body.code,
          occurredAt: new Date(body.payload.occurredAt).toISOString(),
          deviceId: input.deviceId,
          recordedBy: input.author,
          at: input.now.toISOString(),
        },
      ]);
      if (review?.becameUrgent && locationId) {
        await noticeUrgentReview(tx, {
          taskId,
          personId: who?.id ?? null,
          locationId,
          now: input.now,
        });
      }
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
        ...(handoverId ? { handoverId } : {}),
      },
      requestId: input.requestId,
    });
    return { id: created.id, taskId, replay: false };
  });
  if (kept) return kept;
  const raced = await existing();
  if (!raced) throw problems.invalid("That id is already used.");
  return replayOf(raced);
}

/** A copy as the API returns it. */
export function refusedEntryOut(
  row: typeof refusedEntry.$inferSelect,
  staff: StaffLookup,
): RefusedEntryItem {
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
    authorStaff: staff(row.authorTenantUserId),
    sentByTenantUserId: row.createdBy,
    sentByStaff: staff(row.createdBy),
    deviceId: row.deviceId,
    reviewTaskId: row.reviewTaskId,
  };
}

/**
 * A page of the copies about a person, newest first (refusal time, then id), under the reader's
 * row-level security: those before the copy `before` names, when it does. `next` is the last
 * copy's id when another page may follow.
 */
export async function refusedEntriesFor(
  tx: Transaction,
  personId: string,
  page: { readonly before?: string | undefined; readonly limit: number },
): Promise<{ rows: (typeof refusedEntry.$inferSelect)[]; next: string | null }> {
  const [cursor] = page.before
    ? await tx
        .select({ refusedAt: refusedEntry.refusedAt, id: refusedEntry.id })
        .from(refusedEntry)
        .where(and(eq(refusedEntry.id, page.before), eq(refusedEntry.personId, personId)))
    : [];
  if (page.before && !cursor) return { rows: [], next: null };
  const rows = await tx
    .select()
    .from(refusedEntry)
    .where(
      and(
        eq(refusedEntry.personId, personId),
        cursor
          ? or(
              lt(refusedEntry.refusedAt, cursor.refusedAt),
              and(eq(refusedEntry.refusedAt, cursor.refusedAt), lt(refusedEntry.id, cursor.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(refusedEntry.refusedAt), desc(refusedEntry.id))
    .limit(page.limit);
  return { rows, next: rows.length === page.limit ? (rows.at(-1)?.id ?? null) : null };
}
