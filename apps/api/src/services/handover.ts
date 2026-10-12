import {
  auditEvent,
  bodyMapMark,
  careNote,
  handover,
  handoverAcknowledgement,
  handoverItem,
  incident,
  location,
  notification,
  observation,
  type Transaction,
  task,
} from "@harbour/db";
import {
  type AlertNotification,
  alertConditions,
  checkHandoverKeepsItems,
  compileHandover,
  HANDOVER_NOTICE_KIND_PREFIX,
  HANDOVER_NOTIFICATION_KIND,
  HANDOVER_RATE_KEYS,
  HANDOVER_UNACKNOWLEDGED_KIND,
  type HandoverAcknowledgement,
  type HandoverItem,
  type HandoverItemKind,
  type HandoverSources,
  type HandoverSourceType,
  incomingAcknowledged,
  lateAdditionNotices,
  type News2Band,
  nextShift,
  observationIsRefusal,
  previousShift,
  refreshHandover,
  type ShiftPattern,
  type ShiftWindow,
  shiftAt,
  type TaskStatus,
  twoShiftPattern,
  UNACKNOWLEDGED_ALERT_WINDOW_HOURS,
  unacknowledgedAlertDue,
  viewerAcknowledgement,
} from "@harbour/domain";
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { nurseInCharge } from "./care";
import { fallbackRecipients } from "./device-holds";
import { rateNumber } from "./rates";
import { type StaffView, staffViews } from "./staff-views";

/**
 * The shift handover (care.md rule 8 as built in slice 5; COMMS-006; hazard HZ-018). Compiled by
 * rule from the shift's records at the location, always in the system's view of the organisation
 * (every caller passes a transaction with tenant scope), so nothing is missed because of who asked.
 * The domain rules decide the items (`compileHandover`, `refreshHandover`); this file reads the
 * sources, stores the handover and its items (one append-only row each, so row-level security
 * shows each reader only the items about people they may see; HZ-011), announces late additions
 * and alerts the nurse in charge when nobody on the incoming shift has acknowledged.
 */

type Nation = "england" | "wales" | "scotland" | "northern_ireland";
export type HandoverRow = typeof handover.$inferSelect;
type ItemRow = typeof handoverItem.$inferSelect;
type AckRow = typeof handoverAcknowledgement.$inferSelect;

/** How often the worker compiles, locks and refreshes handovers (apps/api/src/jobs/worker.ts). */
export const HANDOVER_SWEEP_MINUTES = 5;
/** Locked handovers take late additions for this long after the shift (the offline window). */
export const OFFLINE_WINDOW_RATE_KEY = "mobile.offline_window_days";
/**
 * Entries recorded this long before a handover's last refresh are read again: an entry's recorded
 * time is when its transaction began, so one that committed just after a refresh it began before is
 * never missed. Twice the sweep interval; reading an entry twice adds nothing (items have keys).
 */
export const LATE_ENTRY_MARGIN_MINUTES = 2 * HANDOVER_SWEEP_MINUTES;

/**
 * The handover permission: a handover is read under its scope (ADR-0071), so what each member of
 * staff can see of one is worked out in it (`staffViews`); and its holders take the alert when a
 * location has no nurse in charge.
 */
const HANDOVER_PERMISSION = "care.handover.manage";

/** The location's shift pattern: the rate table's two shifts until rotas define them (Phase 2). */
export async function shiftPatternFor(
  tx: Transaction,
  tenantId: string,
  nation: Nation,
): Promise<ShiftPattern> {
  return twoShiftPattern(
    await rateNumber(tx, tenantId, HANDOVER_RATE_KEYS.dayShiftStartMinute, nation),
    await rateNumber(tx, tenantId, HANDOVER_RATE_KEYS.nightShiftStartMinute, nation),
  );
}

/**
 * The location, when it is in the caller's scope: tenant-wide roles, location roles there, and
 * anyone who can see a person living there (`app.handover_location_visible`, which runs under the
 * caller's row-level security). Otherwise null, so the route answers not found.
 */
export async function locationInScope(
  tx: Transaction,
  locationId: string,
): Promise<{ readonly id: string; readonly nation: Nation } | null> {
  const [row] = await tx
    .select({
      id: location.id,
      nation: location.nation,
      visible: sql<boolean>`app.handover_location_visible(${location.id})`,
    })
    .from(location)
    .where(and(eq(location.id, locationId), isNull(location.deletedAt)));
  return row?.visible ? { id: row.id, nation: row.nation as Nation } : null;
}

export function rowShift(row: HandoverRow): ShiftWindow {
  return { name: row.shiftName, start: row.shiftStart, end: row.shiftEnd };
}

const toItem = (r: ItemRow): HandoverItem => ({
  key: r.key,
  kind: r.kind as HandoverItemKind,
  personId: r.personId,
  sourceType: r.sourceType as HandoverSourceType,
  sourceId: r.sourceId,
  at: r.at,
  lateAddition: r.lateAddition,
  addedAt: r.addedAt,
});

/**
 * The items of these handovers that the transaction's view may see, in the order they were
 * compiled and added: all of them in the system's view, only those about people the reader may
 * see in theirs (row-level security, HZ-011).
 */
export async function itemsOf(
  tx: Transaction,
  handoverIds: readonly string[],
): Promise<Map<string, HandoverItem[]>> {
  const out = new Map<string, HandoverItem[]>(handoverIds.map((id) => [id, []]));
  if (handoverIds.length === 0) return out;
  const rows = await tx
    .select()
    .from(handoverItem)
    .where(inArray(handoverItem.handoverId, [...handoverIds]))
    .orderBy(asc(handoverItem.handoverId), asc(handoverItem.position));
  for (const r of rows) out.get(r.handoverId)?.push(toItem(r));
  return out;
}

/** The acknowledgements of these handovers the transaction's view may see, oldest first. */
export async function acknowledgementsOf(
  tx: Transaction,
  handoverIds: readonly string[],
): Promise<AckRow[]> {
  if (handoverIds.length === 0) return [];
  return tx
    .select()
    .from(handoverAcknowledgement)
    .where(inArray(handoverAcknowledgement.handoverId, [...handoverIds]))
    .orderBy(asc(handoverAcknowledgement.acknowledgedAt), asc(handoverAcknowledgement.id));
}

export const toAcknowledgement = (a: AckRow): HandoverAcknowledgement => ({
  tenantUserId: a.tenantUserId,
  at: a.acknowledgedAt,
  itemKeys: a.itemKeys,
});

/** Appends items to a handover after the ones it holds (positions are never reused). */
async function appendItems(
  tx: Transaction,
  handoverId: string,
  items: readonly HandoverItem[],
  from: number,
): Promise<void> {
  if (items.length === 0) return;
  await tx.insert(handoverItem).values(
    items.map((i, n) => ({
      handoverId,
      key: i.key,
      position: from + n,
      kind: i.kind,
      personId: i.personId,
      sourceType: i.sourceType,
      sourceId: i.sourceId,
      at: i.at,
      lateAddition: i.lateAddition,
      addedAt: i.addedAt,
    })),
  );
}

const inShift = (column: Parameters<typeof gte>[0], shift: ShiftWindow) =>
  and(gte(column, shift.start), lt(column, shift.end));

/**
 * Everything at the location the handover of a shift reads (care.md rule 8): open tasks due by the
 * end of the shift and those raised in it, tasks staff skipped or cancelled in it, the entries that
 * happened or arrived in it, and the urgent alerts raised by its end that were raised in it or
 * still unacknowledged when it ended.
 */
export async function handoverSources(
  tx: Transaction,
  locationId: string,
  shift: ShiftWindow,
): Promise<HandoverSources> {
  const tasks = await tx
    .select({
      id: task.id,
      personId: task.personId,
      kind: task.kind,
      status: task.status,
      priority: task.priority,
      evidenceRequired: task.evidenceRequired,
      dueAt: task.dueAt,
      windowEnd: task.windowEnd,
      createdAt: task.createdAt,
      completedAt: task.completedAt,
    })
    .from(task)
    .where(
      and(
        eq(task.locationId, locationId),
        isNull(task.deletedAt),
        or(
          and(
            inArray(task.status, ["open", "in_progress"]),
            lt(task.createdAt, shift.end),
            or(lt(task.dueAt, shift.end), gte(task.createdAt, shift.start)),
          ),
          // Skipped or cancelled by staff (with a completion time); not by the lifecycle or a plan.
          and(inArray(task.status, ["skipped", "cancelled"]), inShift(task.completedAt, shift)),
        ),
      ),
    );
  const entryInShift = (occurred: Parameters<typeof gte>[0], recorded: Parameters<typeof gte>[0]) =>
    or(inShift(occurred, shift), inShift(recorded, shift));
  const observations = await tx
    .select({
      id: observation.id,
      personId: observation.personId,
      occurredAt: observation.occurredAt,
      recordedAt: observation.recordedAt,
      values: observation.values,
      flags: observation.flags,
    })
    .from(observation)
    .where(
      and(
        eq(observation.locationId, locationId),
        entryInShift(observation.occurredAt, observation.recordedAt),
      ),
    );
  const incidents = await tx
    .select({
      id: incident.id,
      personIds: incident.personIds,
      type: incident.type,
      occurredAt: incident.occurredAt,
      recordedAt: incident.recordedAt,
    })
    .from(incident)
    .where(
      and(
        eq(incident.locationId, locationId),
        isNull(incident.deletedAt),
        entryInShift(incident.occurredAt, incident.recordedAt),
      ),
    );
  const marks = await tx
    .select({
      id: bodyMapMark.id,
      personId: bodyMapMark.personId,
      occurredAt: bodyMapMark.occurredAt,
      recordedAt: bodyMapMark.recordedAt,
    })
    .from(bodyMapMark)
    .where(
      and(
        eq(bodyMapMark.locationId, locationId),
        entryInShift(bodyMapMark.occurredAt, bodyMapMark.recordedAt),
      ),
    );
  const notes = await tx
    .select({
      id: careNote.id,
      personId: careNote.personId,
      occurredAt: careNote.occurredAt,
      recordedAt: careNote.recordedAt,
      tags: careNote.tags,
    })
    .from(careNote)
    .where(
      and(
        eq(careNote.locationId, locationId),
        entryInShift(careNote.occurredAt, careNote.recordedAt),
      ),
    );
  // Each alert as a whole (every recipient's copy), so it counts as acknowledged once anyone has.
  const conditionKey = sql`(${notification.kind}, coalesce(${notification.sourceType}, ''), coalesce(${notification.sourceId}, ${notification.id}::text))`;
  const alerts = await tx
    .select({
      id: notification.id,
      kind: notification.kind,
      severity: notification.severity,
      sourceType: notification.sourceType,
      sourceId: notification.sourceId,
      personId: notification.personId,
      createdAt: notification.createdAt,
      acknowledgedAt: notification.acknowledgedAt,
    })
    .from(notification)
    .where(
      and(
        eq(notification.locationId, locationId),
        eq(notification.severity, "urgent"),
        lt(notification.createdAt, shift.end),
        sql`${notification.sourceType} IS DISTINCT FROM 'notification'`,
        sql`${notification.kind} NOT LIKE ${`${HANDOVER_NOTICE_KIND_PREFIX}%`}`,
        sql`${conditionKey} IN (
          SELECT m.kind, coalesce(m.source_type, ''), coalesce(m.source_id, m.id::text)
          FROM notification m
          WHERE m.tenant_id = ${notification.tenantId} AND m.location_id = ${locationId}
            AND m.severity = 'urgent' AND m.created_at < ${shift.end}
          GROUP BY 1, 2, 3
          HAVING max(m.created_at) >= ${shift.start}
            OR bool_and(m.acknowledged_at IS NULL OR m.acknowledged_at >= ${shift.end}))`,
      ),
    );

  return {
    tasks: tasks.map((t) => ({
      id: t.id,
      personId: t.personId,
      kind: t.kind,
      status: t.status as TaskStatus,
      priority: t.priority === "urgent" ? "urgent" : "routine",
      evidenceRequired: t.evidenceRequired,
      dueAt: t.dueAt,
      windowEnd: t.windowEnd,
      createdAt: t.createdAt,
      closedAt: ["done", "skipped", "cancelled"].includes(t.status) ? t.completedAt : null,
    })),
    observations: observations.map((o) => {
      const news2 = (o.flags as { news2?: { band?: string } } | null)?.news2;
      return {
        id: o.id,
        personId: o.personId,
        occurredAt: o.occurredAt,
        recordedAt: o.recordedAt,
        news2Band: (news2?.band ?? null) as News2Band | null,
        refused: observationIsRefusal(
          o.values as { chart: string; refused?: boolean; declined?: boolean },
        ),
      };
    }),
    incidents: incidents.map((i) => ({ ...i, personIds: i.personIds ?? [] })),
    bodyMapMarks: marks,
    notes,
    alerts: alertConditions(alerts as AlertNotification[]),
  };
}

/** Records a handover write: as the requester through the API, as the system in the worker. */
export type HandoverAudit = (
  action:
    | "care.handover.compile"
    | "care.handover.refresh"
    | "care.handover.lock"
    | "care.handover.alert.unacknowledged",
  handoverId: string,
  scope: Record<string, unknown>,
) => Promise<void>;

/** The worker's audit: a write the system made, with no actor. */
export function systemAudit(tx: Transaction, tenantId: string): HandoverAudit {
  return async (action, handoverId, scope) => {
    await tx.insert(auditEvent).values({
      tenantId,
      action,
      resourceType: "handover",
      resourceId: handoverId,
      scope,
    });
  };
}

export interface CompileOutcome {
  readonly row: HandoverRow;
  readonly created: boolean;
  readonly added: readonly HandoverItem[];
}

/**
 * Compiles the handover of a shift at a location, or refreshes the one that exists by appending
 * what has appeared since (never removing anything; HZ-018). Locks it when asked. A refresh that
 * adds nothing is written only when it locks or when `advance` asks for the refresh time to move
 * (late entries were read), so an open handover is not versioned every few minutes.
 */
export async function compileOrRefresh(
  tx: Transaction,
  input: {
    readonly tenantId: string;
    readonly locationId: string;
    readonly shift: ShiftWindow;
    readonly now: Date;
    readonly lock?: boolean;
    readonly advance?: boolean;
    readonly audit: HandoverAudit;
  },
): Promise<CompileOutcome> {
  const { locationId, shift, now } = input;
  const find = async () => {
    const [row] = await tx
      .select()
      .from(handover)
      .where(
        and(
          eq(handover.locationId, locationId),
          eq(handover.shiftStart, shift.start),
          isNull(handover.deletedAt),
        ),
      )
      .for("update");
    return row;
  };
  let existing = await find();
  const sources = await handoverSources(tx, locationId, shift);
  if (!existing) {
    const items = compileHandover(shift, sources, now);
    const [created] = await tx
      .insert(handover)
      .values({
        locationId,
        shiftName: shift.name,
        shiftStart: shift.start,
        shiftEnd: shift.end,
        compiledAt: now,
        refreshedAt: now,
        lockedAt: input.lock ? now : null,
      })
      .onConflictDoNothing()
      .returning();
    if (created) {
      await appendItems(tx, created.id, items, 0);
      await input.audit("care.handover.compile", created.id, {
        locationId,
        items: items.length,
        locked: input.lock === true,
      });
      return { row: created, created: true, added: [] };
    }
    // Compiled by someone else a moment ago: refresh theirs.
    existing = await find();
    if (!existing) throw new Error("Handover vanished while compiling");
  }
  const before = (await itemsOf(tx, [existing.id])).get(existing.id) ?? [];
  const { items, added } = refreshHandover(before, shift, sources, now);
  const kept = checkHandoverKeepsItems(
    before,
    items.map((i) => i.key),
  );
  if (!kept.ok) throw new Error(kept.message);
  const lock = input.lock === true && existing.lockedAt === null;
  // The refresh time moves on only once it is older than the margin the late-entry check reads
  // back over, so a late entry costs at most one write that adds nothing.
  const advance =
    input.advance === true &&
    existing.refreshedAt.getTime() < now.getTime() - LATE_ENTRY_MARGIN_MINUTES * 60_000;
  if (added.length === 0 && !lock && !advance) {
    return { row: existing, created: false, added: [] };
  }
  await appendItems(tx, existing.id, added, before.length);
  const [updated] = await tx
    .update(handover)
    .set({ refreshedAt: now, ...(lock ? { lockedAt: now } : {}) })
    .where(eq(handover.id, existing.id))
    .returning();
  if (!updated) throw new Error("Handover vanished while refreshing");
  const heard = await announceLateAdditions(tx, updated, added, now);
  await input.audit(lock ? "care.handover.lock" : "care.handover.refresh", updated.id, {
    locationId,
    added: added.length,
    items: items.length,
    told: heard.told,
    // Additions nobody on duty can see: recorded so they are looked into (HZ-008).
    unheard: heard.unheard,
  });
  return { row: updated, created: false, added };
}

/**
 * Whether a member of staff can see an item of a handover at a location, as row-level security
 * decides for them (`handover_item_scope`) under their scope for `care.handover.manage`, the
 * permission a handover is read with (`staffViews`, ADR-0071): an item about a person when that
 * scope reaches the person (their location, or the people they are assigned to only when a role
 * scoped to assigned people carries the permission; never a break-glass record), an item about
 * nobody only when it sees the handover whole (the scope is the organisation's, or includes that
 * location; `app.handover_whole`). Another role's wider reach never counts.
 */
export function staffCanSee(
  view: StaffView | undefined,
  locationId: string,
  item: HandoverItem,
): boolean {
  if (!view) return false;
  if (item.personId !== null) return view.people.has(item.personId);
  return (
    view.scope === "tenant" || (view.scope === "locations" && view.locationIds.includes(locationId))
  );
}

export interface AcknowledgementState {
  /** Everyone who has acknowledged it at least once. */
  readonly acknowledgedBy: string[];
  /** Of them, who has items they can see still to acknowledge. */
  readonly pending: string[];
  /**
   * The shift has ended and the incoming shift's acknowledgements do not cover every item
   * (`incomingAcknowledged`).
   */
  readonly unacknowledged: boolean;
}

/**
 * Where each handover stands with its acknowledgements, worked out over each member of staff's own
 * scope (`viewerAcknowledgement`): nobody is pending for items they cannot see. The incoming shift
 * has acknowledged only when its acknowledgements together cover every item, by the keys each
 * recorded (`incomingAcknowledged`). Runs in the system's view, so it reads every item and
 * acknowledgement.
 */
export async function acknowledgementSummary(
  tx: Transaction,
  rows: readonly HandoverRow[],
  now: Date,
): Promise<Map<string, AcknowledgementState>> {
  const items = await itemsOf(
    tx,
    rows.map((r) => r.id),
  );
  const acks = await acknowledgementsOf(
    tx,
    rows.map((r) => r.id),
  );
  const staff = [...new Set(acks.map((a) => a.tenantUserId))];
  const people = [...items.values()].flatMap((list) =>
    list.map((i) => i.personId).filter((p): p is string => p !== null),
  );
  const views = await staffViews(tx, staff, people, now, HANDOVER_PERMISSION);
  const out = new Map<string, AcknowledgementState>();
  for (const row of rows) {
    const list = items.get(row.id) ?? [];
    const own = acks.filter((a) => a.handoverId === row.id).map(toAcknowledgement);
    const acknowledgedBy = [...new Set(own.map((a) => a.tenantUserId))];
    const pending = acknowledgedBy.filter(
      (userId) =>
        !viewerAcknowledgement(
          list,
          (i) => staffCanSee(views.get(userId), row.locationId, i),
          own,
          userId,
        ).acknowledged,
    );
    const ended = now.getTime() >= row.shiftEnd.getTime();
    out.set(row.id, {
      acknowledgedBy,
      pending,
      unacknowledged: ended && !incomingAcknowledged(rowShift(row), list, own),
    });
  }
  return out;
}

/**
 * Tells people about items added after a handover was first compiled (care.md rule 8; HZ-018,
 * HZ-008, HZ-011), by `lateAdditionNotices`: nobody before the receiving shift starts; while it
 * runs, the staff who acknowledged it on that shift about the additions they can see, and the nurse
 * in charge on duty about anything none of them can see and always about a fall, a raised NEWS2,
 * an incident or an urgent alert; after it, the nurse in charge about everything. Each notice is generic and urgent with
 * push only when an item the recipient can see cannot wait. Returns how many were told and how
 * many additions nobody on duty can see.
 */
async function announceLateAdditions(
  tx: Transaction,
  row: HandoverRow,
  added: readonly HandoverItem[],
  now: Date,
): Promise<{ readonly told: number; readonly unheard: number }> {
  if (added.length === 0) return { told: 0, unheard: 0 };
  const acks = await tx
    .select({
      tenantUserId: handoverAcknowledgement.tenantUserId,
      at: handoverAcknowledgement.acknowledgedAt,
    })
    .from(handoverAcknowledgement)
    .where(eq(handoverAcknowledgement.handoverId, row.id));
  const nurses = await nurseInCharge(tx, row.locationId);
  const views = await staffViews(
    tx,
    [...new Set([...acks.map((a) => a.tenantUserId), ...nurses])],
    added.map((i) => i.personId).filter((p): p is string => p !== null),
    now,
    HANDOVER_PERMISSION,
  );
  const [loc] = await tx
    .select({ nation: location.nation })
    .from(location)
    .where(eq(location.id, row.locationId));
  const pattern = await shiftPatternFor(tx, row.tenantId, (loc?.nation ?? "england") as Nation);
  const { notices, unheard } = lateAdditionNotices({
    receivingShift: nextShift(rowShift(row), pattern),
    now,
    added,
    acknowledgements: acks,
    nurseInCharge: nurses,
    canSee: (userId, i) => staffCanSee(views.get(userId), row.locationId, i),
  });
  for (const notice of notices) {
    await tx
      .insert(notification)
      .values({
        recipientTenantUserId: notice.recipient,
        kind: HANDOVER_NOTIFICATION_KIND,
        severity: notice.severity,
        title: "A handover has new items",
        body: "Open the handover to see what was added.",
        link: `/locations/${row.locationId}/handovers/${row.id}`,
        channels: notice.severity === "urgent" ? ["in_app", "push"] : ["in_app"],
        sourceType: "handover",
        sourceId: row.id,
        locationId: row.locationId,
        dedupeKey: `handover_late:${row.id}:${now.getTime()}:${notice.recipient}`,
      })
      .onConflictDoNothing();
  }
  return { told: notices.length, unheard: unheard.length };
}

/**
 * Alerts the nurse in charge on duty, once, when the incoming shift has not acknowledged a handover
 * by the rate table's grace period after its shift ended (COMMS-006; HZ-018, H-153). The alert can
 * be acknowledged like any other, and each recipient has one copy per handover. With no nurse in
 * charge at the location it goes, as H-142 does for sync tasks, to the longest-serving Registered
 * Manager anywhere in the organisation, else the longest-serving holder of
 * `care.handover.manage`; with no one at all, the gap is audited once (`told: 0`).
 */
async function alertUnacknowledged(
  tx: Transaction,
  tenantId: string,
  locationId: string,
  graceMinutes: number,
  now: Date,
): Promise<number> {
  const latest = new Date(now.getTime() - graceMinutes * 60_000);
  const earliest = new Date(latest.getTime() - UNACKNOWLEDGED_ALERT_WINDOW_HOURS * 3_600_000);
  const rows = await tx
    .select()
    .from(handover)
    .where(
      and(
        eq(handover.locationId, locationId),
        isNull(handover.deletedAt),
        lte(handover.shiftEnd, latest),
        gt(handover.shiftEnd, earliest),
      ),
    );
  if (rows.length === 0) return 0;
  const states = await acknowledgementSummary(tx, rows, now);
  let raised = 0;
  for (const row of rows) {
    const due = unacknowledgedAlertDue({
      shift: rowShift(row),
      now,
      graceMinutes,
      acknowledged: !(states.get(row.id)?.unacknowledged ?? true),
    });
    if (!due) continue;
    const nurses = await nurseInCharge(tx, locationId);
    const recipients =
      nurses.length > 0
        ? nurses
        : (await fallbackRecipients(tx, HANDOVER_PERMISSION, now, null, locationId)).slice(0, 1);
    if (recipients.length === 0) {
      const [recorded] = await tx
        .select({ id: auditEvent.id })
        .from(auditEvent)
        .where(
          and(
            eq(auditEvent.resourceId, row.id),
            eq(auditEvent.action, "care.handover.alert.unacknowledged"),
          ),
        )
        .limit(1);
      if (!recorded) {
        await systemAudit(tx, tenantId)("care.handover.alert.unacknowledged", row.id, {
          locationId,
          told: 0,
        });
      }
      continue;
    }
    let inserted = 0;
    for (const recipient of recipients) {
      const made = await tx
        .insert(notification)
        .values({
          recipientTenantUserId: recipient,
          kind: HANDOVER_UNACKNOWLEDGED_KIND,
          severity: "warning",
          title: "A handover has not been acknowledged",
          body: "Nobody on the incoming shift has acknowledged the handover yet. Make sure it is read.",
          link: `/locations/${locationId}/handovers/${row.id}`,
          channels: ["in_app"],
          sourceType: "handover",
          sourceId: row.id,
          locationId,
          dedupeKey: `handover_unacknowledged:${row.id}`,
        })
        .onConflictDoNothing()
        .returning({ id: notification.id });
      inserted += made.length;
    }
    if (inserted === 0) continue;
    raised += inserted;
    await systemAudit(tx, tenantId)("care.handover.alert.unacknowledged", row.id, {
      locationId,
      told: inserted,
    });
  }
  return raised;
}

/** At most this many earlier shifts are looked at for a missed handover (bounds the loop). */
const MAX_MISSED_SHIFTS = 200;

/**
 * The worker's pass over one organisation (every `HANDOVER_SWEEP_MINUTES`): at each location,
 * every shift that ended within the offline window has its handover compiled and locked if nobody
 * has, so a missed run or a worker outage loses none;
 * handovers still open are refreshed, and locked if their shift has ended; locked ones from the
 * offline window are refreshed when an entry that happened in their shift has arrived since their
 * last refresh; and the nurse in charge is alerted once about any handover nobody on the incoming
 * shift has acknowledged by the grace period (H-153).
 */
export async function sweepHandovers(
  tx: Transaction,
  tenantId: string,
  now: Date,
): Promise<number> {
  const locations = await tx
    .select({ id: location.id, nation: location.nation })
    .from(location)
    .where(and(eq(location.status, "active"), isNull(location.deletedAt)));
  const offlineDays = await rateNumber(tx, tenantId, OFFLINE_WINDOW_RATE_KEY);
  const since = new Date(now.getTime() - (offlineDays + 1) * 86_400_000);
  // An entry's recorded time is when its transaction began; one that committed after a refresh
  // it began before is still found (HZ-018).
  const margin = `${LATE_ENTRY_MARGIN_MINUTES} minutes`;
  let changed = 0;
  for (const loc of locations) {
    const pattern = await shiftPatternFor(tx, tenantId, loc.nation as Nation);
    const grace = await rateNumber(
      tx,
      tenantId,
      HANDOVER_RATE_KEYS.acknowledgementGraceMinutes,
      loc.nation as Nation,
    );
    const done = new Set<string>();
    const run = async (shift: ShiftWindow, options: { lock?: boolean; advance?: boolean }) => {
      const outcome = await compileOrRefresh(tx, {
        tenantId,
        locationId: loc.id,
        shift,
        now,
        audit: systemAudit(tx, tenantId),
        ...options,
      });
      done.add(outcome.row.id);
      if (outcome.created || outcome.added.length > 0 || options.lock) changed++;
    };
    // The shifts that ended in the offline window, oldest first.
    const ended: ShiftWindow[] = [];
    for (
      let s = previousShift(shiftAt(now, pattern), pattern);
      s.end.getTime() > since.getTime() && ended.length < MAX_MISSED_SHIFTS;
      s = previousShift(s, pattern)
    ) {
      ended.unshift(s);
    }
    const first = ended[0];
    const stored = first
      ? await tx
          .select({ shiftStart: handover.shiftStart, lockedAt: handover.lockedAt })
          .from(handover)
          .where(and(eq(handover.locationId, loc.id), gte(handover.shiftStart, first.start)))
      : [];
    const locked = new Set(
      stored.filter((r) => r.lockedAt !== null).map((r) => r.shiftStart.getTime()),
    );
    for (const shift of ended) {
      if (!locked.has(shift.start.getTime())) await run(shift, { lock: true });
    }
    const open = await tx
      .select()
      .from(handover)
      .where(
        and(eq(handover.locationId, loc.id), isNull(handover.lockedAt), isNull(handover.deletedAt)),
      );
    for (const row of open) {
      if (done.has(row.id)) continue;
      await run(rowShift(row), { lock: row.shiftEnd.getTime() <= now.getTime() });
    }
    const late = await tx
      .select()
      .from(handover)
      .where(
        and(
          eq(handover.locationId, loc.id),
          isNotNull(handover.lockedAt),
          isNull(handover.deletedAt),
          gt(handover.shiftEnd, since),
          sql`(
            EXISTS (SELECT 1 FROM care_note e WHERE e.location_id = ${handover.locationId}
              AND e.recorded_at > ${handover.refreshedAt} - ${margin}::interval
              AND e.occurred_at >= ${handover.shiftStart} AND e.occurred_at < ${handover.shiftEnd})
            OR EXISTS (SELECT 1 FROM observation e WHERE e.location_id = ${handover.locationId}
              AND e.recorded_at > ${handover.refreshedAt} - ${margin}::interval
              AND e.occurred_at >= ${handover.shiftStart} AND e.occurred_at < ${handover.shiftEnd})
            OR EXISTS (SELECT 1 FROM body_map_mark e WHERE e.location_id = ${handover.locationId}
              AND e.recorded_at > ${handover.refreshedAt} - ${margin}::interval
              AND e.occurred_at >= ${handover.shiftStart} AND e.occurred_at < ${handover.shiftEnd})
            OR EXISTS (SELECT 1 FROM incident e WHERE e.location_id = ${handover.locationId}
              AND e.deleted_at IS NULL AND e.recorded_at > ${handover.refreshedAt} - ${margin}::interval
              AND e.occurred_at >= ${handover.shiftStart} AND e.occurred_at < ${handover.shiftEnd})
          )`,
        ),
      );
    for (const row of late) {
      if (done.has(row.id)) continue;
      await run(rowShift(row), { advance: true });
    }
    changed += await alertUnacknowledged(tx, tenantId, loc.id, grace, now);
  }
  return changed;
}
