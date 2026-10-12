import {
  accessGrant,
  auditEvent,
  bodyMapMark,
  careNote,
  handover,
  handoverAcknowledgement,
  incident,
  location,
  notification,
  observation,
  person,
  role,
  roleAssignment,
  type Transaction,
  task,
} from "@harbour/db";
import {
  type AccessGrantInput,
  type AlertNotification,
  alertConditions,
  checkHandoverKeepsItems,
  compileHandover,
  HANDOVER_NOTIFICATION_KIND,
  HANDOVER_RATE_KEYS,
  type HandoverItem,
  type HandoverSources,
  lateAdditionRecipients,
  lateAdditionSeverity,
  type News2Band,
  nextShift,
  observationIsRefusal,
  previousShift,
  type RoleAssignmentInput,
  refreshHandover,
  resolveAccess,
  type ScopeKind,
  type ShiftPattern,
  type ShiftWindow,
  shiftAt,
  type TaskStatus,
  twoShiftPattern,
  viewerAcknowledgement,
} from "@harbour/domain";
import { and, eq, gt, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { nurseInCharge } from "./care";
import { rateNumber } from "./rates";

/**
 * The shift handover (care.md rule 8 as built in slice 5; COMMS-006; hazard HZ-018). Compiled by
 * rule from the shift's records at the location, always in the system's view of the organisation
 * (every caller passes a transaction with tenant scope), so nothing is missed because of who asked.
 * The domain rules decide the items (`compileHandover`, `refreshHandover`); this file reads the
 * sources, stores the handover and announces late additions.
 */

type Nation = "england" | "wales" | "scotland" | "northern_ireland";
export type HandoverRow = typeof handover.$inferSelect;

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

/** Stored items, with their instants as dates again. */
export function storedItems(row: HandoverRow): HandoverItem[] {
  return (
    row.items as (Omit<HandoverItem, "at" | "addedAt"> & { at: string; addedAt: string })[]
  ).map((i) => ({ ...i, at: new Date(i.at), addedAt: new Date(i.addedAt) }));
}

const toStored = (items: readonly HandoverItem[]) =>
  items.map((i) => ({ ...i, at: i.at.toISOString(), addedAt: i.addedAt.toISOString() }));

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
        sql`${notification.kind} <> ${HANDOVER_NOTIFICATION_KIND}`,
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
  action: "care.handover.compile" | "care.handover.refresh" | "care.handover.lock",
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
        items: toStored(items),
        compiledAt: now,
        refreshedAt: now,
        lockedAt: input.lock ? now : null,
      })
      .onConflictDoNothing()
      .returning();
    if (created) {
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
  const before = storedItems(existing);
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
  const [updated] = await tx
    .update(handover)
    .set({
      items: toStored(items),
      refreshedAt: now,
      ...(lock ? { lockedAt: now } : {}),
    })
    .where(eq(handover.id, existing.id))
    .returning();
  if (!updated) throw new Error("Handover vanished while refreshing");
  await input.audit(lock ? "care.handover.lock" : "care.handover.refresh", updated.id, {
    locationId,
    added: added.length,
    items: items.length,
  });
  await announceLateAdditions(tx, updated, added, now);
  return { row: updated, created: false, added };
}

/**
 * Which of these people each member of staff may see now, by the database's own person-scope
 * policy (`app.person_in_scope`): each member's scope is resolved from their roles and grants as
 * the API does at sign-in, set on the transaction while their view is read, and the caller's
 * context is put back afterwards. Used, in the system's view of the organisation, to say who still
 * has to acknowledge a handover and who hears about a late addition, so nobody is asked about, or
 * told of, items about people outside their scope (HZ-011, HZ-008).
 */
export async function peopleVisibleTo(
  tx: Transaction,
  tenantUserIds: readonly string[],
  personIds: readonly string[],
  now: Date,
): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>(tenantUserIds.map((id) => [id, new Set<string>()]));
  const people = [...new Set(personIds)];
  if (tenantUserIds.length === 0 || people.length === 0) return result;
  const assignments = await tx
    .select({
      tenantUserId: roleAssignment.tenantUserId,
      roleKey: role.key,
      scopeKind: role.scopeKind,
      permissions: role.permissions,
      locationId: roleAssignment.locationId,
      validFrom: roleAssignment.validFrom,
      validTo: roleAssignment.validTo,
    })
    .from(roleAssignment)
    .innerJoin(role, eq(role.id, roleAssignment.roleId))
    .where(
      and(
        inArray(roleAssignment.tenantUserId, [...tenantUserIds]),
        isNull(roleAssignment.deletedAt),
        isNull(role.archivedAt),
      ),
    );
  const grants = await tx
    .select({
      tenantUserId: accessGrant.tenantUserId,
      permissions: accessGrant.permissions,
      locationId: accessGrant.locationId,
      validFrom: accessGrant.validFrom,
      validTo: accessGrant.validTo,
      revokedAt: accessGrant.revokedAt,
    })
    .from(accessGrant)
    .where(
      and(inArray(accessGrant.tenantUserId, [...tenantUserIds]), isNull(accessGrant.deletedAt)),
    );
  const saved = await tx.execute<{ user_id: string; scope: string; location_ids: string }>(
    sql`SELECT current_setting('app.user_id', true) AS user_id,
               current_setting('app.scope', true) AS scope,
               current_setting('app.location_ids', true) AS location_ids`,
  );
  const before = saved.rows[0];
  try {
    for (const userId of tenantUserIds) {
      const access = resolveAccess(
        assignments
          .filter((a) => a.tenantUserId === userId)
          .map((a): RoleAssignmentInput => ({ ...a, scopeKind: a.scopeKind as ScopeKind })),
        grants.filter((g) => g.tenantUserId === userId) as AccessGrantInput[],
        now,
      );
      await tx.execute(
        sql`SELECT set_config('app.user_id', ${userId}, true),
                   set_config('app.scope', ${access.scope}, true),
                   set_config('app.location_ids', ${access.locationIds.join(",")}, true)`,
      );
      const seen = await tx
        .select({ id: person.id })
        .from(person)
        .where(and(inArray(person.id, people), isNull(person.deletedAt)));
      result.set(userId, new Set(seen.map((r) => r.id)));
    }
  } finally {
    await tx.execute(
      sql`SELECT set_config('app.user_id', ${before?.user_id ?? ""}, true),
                 set_config('app.scope', ${before?.scope ?? "none"}, true),
                 set_config('app.location_ids', ${before?.location_ids ?? ""}, true)`,
    );
  }
  return result;
}

type AckRow = typeof handoverAcknowledgement.$inferSelect;

/**
 * Who has acknowledged a handover and, of them, who still has items to acknowledge that they can
 * see (`viewerAcknowledgement` over each member's own scope). Runs in the system's view.
 */
export async function acknowledgementSummary(
  tx: Transaction,
  rows: readonly HandoverRow[],
  acks: readonly AckRow[],
  now: Date,
): Promise<Map<string, { readonly acknowledgedBy: string[]; readonly pending: string[] }>> {
  const staff = [...new Set(acks.map((a) => a.tenantUserId))];
  const people = rows.flatMap((r) =>
    storedItems(r)
      .map((i) => i.personId)
      .filter((p): p is string => p !== null),
  );
  const visible = await peopleVisibleTo(tx, staff, people, now);
  const out = new Map<string, { acknowledgedBy: string[]; pending: string[] }>();
  for (const row of rows) {
    const items = storedItems(row);
    const own = acks
      .filter((a) => a.handoverId === row.id)
      .map((a) => ({ tenantUserId: a.tenantUserId, at: a.acknowledgedAt, itemsSeen: a.itemsSeen }));
    const acknowledgedBy = [...new Set(own.map((a) => a.tenantUserId))];
    const pending = acknowledgedBy.filter((userId) => {
      const sees = visible.get(userId) ?? new Set<string>();
      return !viewerAcknowledgement(
        items,
        (i) => i.personId === null || sees.has(i.personId),
        own,
        userId,
      ).acknowledged;
    });
    out.set(row.id, { acknowledgedBy, pending });
  }
  return out;
}

/**
 * Tells people about items added after a handover was first compiled (care.md rule 8; HZ-018,
 * HZ-008): the staff who acknowledged it while the receiving shift runs, otherwise the nurse in
 * charge on duty. One generic notice per recipient for each refresh that adds items; urgent with
 * push only for a fall, a raised NEWS2, an incident or an urgent alert.
 */
async function announceLateAdditions(
  tx: Transaction,
  row: HandoverRow,
  added: readonly HandoverItem[],
  now: Date,
): Promise<number> {
  if (added.length === 0) return 0;
  const acks = await tx
    .selectDistinct({ id: handoverAcknowledgement.tenantUserId })
    .from(handoverAcknowledgement)
    .where(eq(handoverAcknowledgement.handoverId, row.id));
  // The staff who acknowledged, told only about additions they can see (HZ-011, HZ-008).
  const visible = await peopleVisibleTo(
    tx,
    acks.map((a) => a.id),
    added.map((i) => i.personId).filter((p): p is string => p !== null),
    now,
  );
  const [loc] = await tx
    .select({ nation: location.nation })
    .from(location)
    .where(eq(location.id, row.locationId));
  const pattern = await shiftPatternFor(tx, row.tenantId, (loc?.nation ?? "england") as Nation);
  const receiving = nextShift(rowShift(row), pattern);
  const told = lateAdditionRecipients(
    receiving,
    now,
    acks.map((a) => a.id),
    await nurseInCharge(tx, row.locationId),
  );
  const items = (row.items as unknown[]).length;
  for (const recipient of told.recipients) {
    const theirs =
      told.to === "incoming_staff"
        ? added.filter(
            (i) => i.personId === null || (visible.get(recipient)?.has(i.personId) ?? false),
          )
        : added;
    const severity = lateAdditionSeverity(theirs);
    if (!severity) continue;
    await tx
      .insert(notification)
      .values({
        recipientTenantUserId: recipient,
        kind: HANDOVER_NOTIFICATION_KIND,
        severity,
        title: "A handover has new items",
        body: "Open the handover to see what was added.",
        link: `/locations/${row.locationId}/handovers/${row.id}`,
        channels: severity === "urgent" ? ["in_app", "push"] : ["in_app"],
        sourceType: "handover",
        sourceId: row.id,
        locationId: row.locationId,
        dedupeKey: `handover_late:${row.id}:${items}:${recipient}`,
      })
      .onConflictDoNothing();
  }
  return told.recipients.length;
}

/**
 * The worker's pass over one organisation (every `HANDOVER_SWEEP_MINUTES`): each location's last
 * shift is compiled if nobody has, refreshed and locked; handovers still open are refreshed, and
 * locked if their shift has ended; locked ones from the offline window are refreshed when an entry
 * that happened in their shift has arrived since their last refresh.
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
    const last = previousShift(shiftAt(now, pattern), pattern);
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
    const [lastRow] = await tx
      .select({ lockedAt: handover.lockedAt })
      .from(handover)
      .where(and(eq(handover.locationId, loc.id), eq(handover.shiftStart, last.start)));
    if (!lastRow || lastRow.lockedAt === null) await run(last, { lock: true });
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
  }
  return changed;
}
