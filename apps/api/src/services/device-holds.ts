/**
 * What the server does with a device's reports about unsent work and with deletions of it
 * (HZ-006, HZ-008, HZ-040; clinical reviews round 4 H1 and H2, rounds 5 and 6; security reviews
 * rounds 5 and 6). Built on the existing task engine and audit trail, with no table of its own.
 *
 * Device-hold tasks:
 * - A device report showing held, unsent or blocked entries raises the device's task for the
 *   Registered Manager, due when the hold escalates (the hold's start plus
 *   `mobile.held_entries_max_days`). The report names the hold's owner and the locations of the
 *   device's sync scope; the task is raised at each of those locations where the owner or the
 *   reporter works or last worked (one task per location, closed together), else at the
 *   reporter's live locations, else at their most recent one. With no location at all, each
 *   Registered Manager gets one, assigned to them. Overdue, it escalates only to holders of its
 *   permission at its location (`services/tasks.ts`).
 * - A report's times are never later than the server received it; a hold's start is never earlier
 *   than the device's last report for that hold said; a later report never moves the due time
 *   later.
 * - A report with nothing waiting, or a recorded deletion of the device's held entries, closes the
 *   task when it comes from the hold's owner, from whoever raised the task, or from someone holding
 *   `safety.incident.manage` at one of its locations. A refused close followed by a new hold resets
 *   the task's escalation once a day, so the new hold signals.
 * - A task closed less than a day ago is reopened, keeping its escalation, rather than raised again
 *   (HZ-008: one escalation). Each reporter raises tasks for at most 3 devices in a rolling day;
 *   past that, the location's Registered Managers get one notice a day about the reporter, so a hold
 *   is never dropped silently. Every raise, reopen, move, reset, close and cap is audited.
 *
 * Flagged-entry tasks (one per deletion record, never one per entry):
 * - An entry uploaded after its own owner's device recorded deleting it ("deleted", not failed), and
 *   an entry a deletion lists that had already reached the server, are each audited and counted on
 *   one review task for the deletion record, carrying the count and up to 20 opaque entry ids in
 *   its audit events. An entry already flagged is not flagged again under a new record. Each owner
 *   has at most 5 such tasks open; past that, the same daily notice. The task is due within a day.
 */
import type { SyncDeviceReport } from "@harbour/contracts";
import {
  activityRecord,
  auditEvent,
  bodyMapMark,
  careNote,
  location,
  notification,
  observation,
  role,
  roleAssignment,
  type Transaction,
  task,
  visitLog,
  withRequestContext,
} from "@harbour/db";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { auditInTx } from "../http/audit";
import type { TenantAccess } from "../http/context";
import { rateNumber } from "./rates";
import { withTenantWideScope } from "./safety";

/** Who resolves held entries and is told when a deleted entry arrives: Registered Manager, deputy and nurse. */
export const DISCARD_OTHERS_PERMISSION = "safety.incident.manage" as const;

export const HELD_MAX_DAYS_RATE_KEY = "mobile.held_entries_max_days";
const HELD_FAIL_SAFE_DAYS = 1;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export const DEVICE_HOLD_TASK_KIND = "sync.device_hold";
export const DEVICE_HOLD_SOURCE = "device_hold";
export const REPORTED_DELETED_TASK_KIND = "sync.entry_reported_deleted";
export const UPLOADED_BEFORE_DELETION_TASK_KIND = "sync.entry_deleted_after_upload";
/** A flagged-entry task points at the deletion record it comes from. */
export const FLAGGED_ENTRY_SOURCE = "device_discard";
const FLAGGED_ENTRY_TASK_KINDS = [REPORTED_DELETED_TASK_KIND, UPLOADED_BEFORE_DELETION_TASK_KIND];
type FlaggedEntryKind = (typeof FLAGGED_ENTRY_TASK_KINDS)[number];

/**
 * Task kinds that escalate only to holders of their required permission at their location (clinical
 * review round 5, C-H1): the people who can act on them.
 */
export const PERMISSION_ESCALATED_TASK_KINDS: readonly string[] = [
  DEVICE_HOLD_TASK_KIND,
  ...FLAGGED_ENTRY_TASK_KINDS,
];

/** Devices one reporter may raise a task for in a rolling day, whatever became of them (HZ-008). */
export const DEVICE_HOLD_TASKS_PER_REPORTER = 3;
/** A device's task closed this recently is reopened rather than raised again (HZ-008). */
export const DEVICE_HOLD_REOPEN_HOURS = 24;
/** A refused close resets a task's escalation at most once in this many hours. */
const DEVICE_HOLD_RESET_HOURS = 24;
/** Opaque entry ids a flagged-entry task's audit events list; its count covers the rest. */
export const FLAGGED_ENTRY_IDS_PER_TASK = 20;
/** Flagged-entry tasks one owner's deletions may have open at once (HZ-008). */
export const FLAGGED_ENTRY_TASKS_PER_OWNER = 5;
/** A flagged entry is a record to check within the day, not an alarm (HZ-008). */
export const FLAGGED_ENTRY_REVIEW_HOURS = 24;
/** The notice the location's Registered Managers get when a cap stops a task (HZ-008). */
export const CAPPED_NOTICE_KIND = "sync.reporter_capped";
/** One notice per person and source in this many hours. */
const CAPPED_NOTICE_HOURS = 24;

/** The audit actions of a deletion's stages (clinical review round 4, H1). */
export const DISCARD_ACTIONS = {
  requested: "sync.entries.discard_requested",
  deleted: "sync.entries.discarded",
  failed: "sync.entries.discard_failed",
} as const;

/** A device's report of its unsent work; its resource is the device. */
export const DEVICE_REPORT_ACTION = "sync.device.report";

/** The audit actions of a device's task (security reviews rounds 5 and 6). */
export const DEVICE_HOLD_ACTIONS = {
  raised: "sync.device_hold.raised",
  reopened: "sync.device_hold.reopened",
  moved: "sync.device_hold.moved",
  reset: "sync.device_hold.reset",
  closed: "sync.device_hold.closed",
  closeRefused: "sync.device_hold.close_refused",
  capped: "sync.device_hold.capped",
} as const;

/** The audit actions of flagged entries and their tasks (security review round 6, N1). */
export const ENTRY_FLAG_ACTIONS = {
  afterDeletion: "sync.entry.after_discard",
  beforeDeletion: "sync.entry.before_discard",
  raised: "sync.entry_flag.raised",
  added: "sync.entry_flag.added",
  capped: "sync.entry_flag.capped",
} as const;

/** A notice to the Registered Managers that a cap stopped a task; its resource is the person. */
export const CAPPED_NOTICE_ACTION = "sync.capped_notice.sent";

const OPEN_STATUSES = ["open", "in_progress"];

type Db = Parameters<typeof withRequestContext>[0];
type TaskRow = typeof task.$inferSelect;

async function heldMaxDays(tx: Transaction, tenantId: string): Promise<number> {
  const days = await rateNumber(tx, tenantId, HELD_MAX_DAYS_RATE_KEY).catch(() => null);
  return typeof days === "number" && Number.isInteger(days) && days >= 1 && days <= 31
    ? days
    : HELD_FAIL_SAFE_DAYS;
}

/** A transaction-scoped lock on a name within the tenant, so racing requests take turns. */
async function lock(tx: Transaction, tenantId: string, name: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}:${name}`}))`);
}

/**
 * The report's times as the server takes them: never later than it received the report (security
 * review round 5, S-M1; HZ-010). A device clock running fast can bring a due time earlier, never
 * push it later.
 */
export function clampReportTimes(
  report: SyncDeviceReport,
  receivedAt: Date,
): { readonly reportedAt: Date; readonly heldSince: Date | null; readonly clamped: boolean } {
  const sent = new Date(report.reportedAt);
  const reportedAt = sent.getTime() > receivedAt.getTime() ? receivedAt : sent;
  const held = report.heldSince ? new Date(report.heldSince) : null;
  const heldSince = held && held.getTime() > reportedAt.getTime() ? reportedAt : held;
  return {
    reportedAt,
    heldSince,
    clamped: reportedAt !== sent || (held !== null && heldSince !== held),
  };
}

/**
 * When the device's waiting work began: the hold's start, else the oldest entry's age. Never
 * earlier than `floor`, the start the device's last report for the same hold gave (security review
 * round 6, N2), and never later than the report.
 */
export function waitingSince(
  report: SyncDeviceReport,
  receivedAt: Date,
  floor: Date | null = null,
): Date {
  const { reportedAt, heldSince } = clampReportTimes(report, receivedAt);
  const since =
    heldSince ??
    (report.oldestAgeSeconds === null
      ? reportedAt
      : new Date(reportedAt.getTime() - report.oldestAgeSeconds * 1000));
  if (!floor || floor.getTime() <= since.getTime()) return since;
  return floor.getTime() > reportedAt.getTime() ? reportedAt : floor;
}

/** Entries the device still has to deal with: held, unsent, and left by a deletion that failed. */
export function waitingCount(report: SyncDeviceReport): number {
  return report.held + report.unsent + report.blocked;
}

/** The system's view of the tenant, acting for the person whose request this is. */
const systemFor = (access: TenantAccess) => ({
  tenantId: access.tenantId,
  userId: access.tenantUserId,
  scope: "tenant" as const,
  locationIds: [] as string[],
});

/** Live role assignments now: not deleted, started, and not expired. */
const liveAssignment = (now: Date) =>
  and(
    isNull(roleAssignment.deletedAt),
    lte(roleAssignment.validFrom, now),
    or(isNull(roleAssignment.validTo), gt(roleAssignment.validTo, now)),
  );

/**
 * Registered Managers by tenant_user id: those at any of `locationIds` (or across the
 * organisation), or every one when no location is given.
 */
async function registeredManagers(
  tx: Transaction,
  now: Date,
  locationIds: readonly string[] = [],
): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ id: roleAssignment.tenantUserId })
    .from(roleAssignment)
    .innerJoin(role, eq(role.id, roleAssignment.roleId))
    .where(
      and(
        eq(role.key, "registered_manager"),
        liveAssignment(now),
        locationIds.length > 0
          ? or(
              isNull(roleAssignment.locationId),
              inArray(roleAssignment.locationId, [...locationIds]),
            )
          : undefined,
      ),
    );
  return rows.map((r) => r.id).sort();
}

/**
 * Who holds `permission` at a location (or anywhere, for a task with no location), through a live
 * role assignment there or across the organisation. Used to escalate the tasks above.
 */
export async function permissionHolders(
  tx: Transaction,
  permission: string,
  locationId: string | null,
  now: Date,
): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ id: roleAssignment.tenantUserId })
    .from(roleAssignment)
    .innerJoin(role, eq(role.id, roleAssignment.roleId))
    .where(
      and(
        sql`${permission} = ANY(${role.permissions})`,
        isNull(role.archivedAt),
        liveAssignment(now),
        locationId
          ? or(isNull(roleAssignment.locationId), eq(roleAssignment.locationId, locationId))
          : undefined,
      ),
    );
  return rows.map((r) => r.id);
}

/**
 * True when the member holds `permission` at one of the locations, through a live role assignment
 * there or across the organisation (security review round 6: the manager check is location-aware).
 * A null location (a task with none) is matched by any live assignment holding it.
 */
export async function holdsPermissionAt(
  tx: Transaction,
  tenantUserId: string,
  permission: string,
  locationIds: ReadonlyArray<string | null>,
  now: Date,
): Promise<boolean> {
  const anywhere = locationIds.length === 0 || locationIds.some((l) => l === null);
  const located = [...new Set(locationIds.filter((l): l is string => l !== null))];
  const [row] = await tx
    .select({ id: roleAssignment.id })
    .from(roleAssignment)
    .innerJoin(role, eq(role.id, roleAssignment.roleId))
    .where(
      and(
        eq(roleAssignment.tenantUserId, tenantUserId),
        sql`${permission} = ANY(${role.permissions})`,
        isNull(role.archivedAt),
        liveAssignment(now),
        anywhere
          ? undefined
          : or(isNull(roleAssignment.locationId), inArray(roleAssignment.locationId, located)),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Where a hold's task goes (clinical review round 6, M2): the locations the device names that are
 * among the live or most recent assignment locations of the owner or the reporter (all of the
 * organisation's for someone assigned across it); with none left, the reporter's live locations;
 * then their most recent one (an agency worker's role ends with the shift). Empty when no location
 * is known.
 */
export async function holdLocations(
  tx: Transaction,
  people: { readonly reporter: string; readonly owner: string },
  reported: readonly string[],
  now: Date,
): Promise<string[]> {
  const who = [...new Set([people.reporter, people.owner])];
  const rows = await tx
    .select({
      tenantUserId: roleAssignment.tenantUserId,
      locationId: roleAssignment.locationId,
      validFrom: roleAssignment.validFrom,
      validTo: roleAssignment.validTo,
      deletedAt: roleAssignment.deletedAt,
      updatedAt: roleAssignment.updatedAt,
    })
    .from(roleAssignment)
    .where(inArray(roleAssignment.tenantUserId, who));
  type Row = (typeof rows)[number];
  const isLive = (r: Row) =>
    r.deletedAt === null &&
    r.validFrom.getTime() <= now.getTime() &&
    (r.validTo === null || r.validTo.getTime() > now.getTime());
  const changed = (r: Row) => (r.deletedAt ?? r.updatedAt).getTime();
  const liveLocated = (id: string) =>
    rows
      .filter((r) => r.tenantUserId === id && isLive(r) && r.locationId !== null)
      .map((r) => r.locationId as string);
  const mostRecent = (id: string) =>
    rows
      .filter((r) => r.tenantUserId === id && r.locationId !== null)
      .sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || changed(b) - changed(a))[0]
      ?.locationId ?? null;

  const asked = [...new Set(reported.map((id) => id.toLowerCase()))];
  if (asked.length > 0) {
    const everywhere = rows.some((r) => isLive(r) && r.locationId === null);
    let kept: string[];
    if (everywhere) {
      const known = await tx
        .select({ id: location.id })
        .from(location)
        .where(and(inArray(location.id, asked), isNull(location.deletedAt)));
      kept = known.map((l) => l.id);
    } else {
      const allowed = new Set<string>();
      for (const id of who) {
        for (const l of liveLocated(id)) allowed.add(l);
        const recent = mostRecent(id);
        if (recent) allowed.add(recent);
      }
      kept = asked.filter((id) => allowed.has(id));
    }
    if (kept.length > 0) return [...new Set(kept)].sort();
  }
  const live = [...new Set(liveLocated(people.reporter))].sort();
  if (live.length > 0) return live;
  const recent = mostRecent(people.reporter);
  return recent ? [recent] : [];
}

/** The latest of `actions` recorded against any of the tasks, newest first. */
async function latestTaskEvent(
  tx: Transaction,
  taskIds: readonly string[],
  actions: readonly string[],
): Promise<{ action: string; scope: unknown; occurredAt: Date } | undefined> {
  if (taskIds.length === 0) return undefined;
  const [row] = await tx
    .select({
      action: auditEvent.action,
      scope: auditEvent.scope,
      occurredAt: auditEvent.occurredAt,
    })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.resourceType, "task"),
        inArray(auditEvent.resourceId, [...taskIds]),
        inArray(auditEvent.action, [...actions]),
      ),
    )
    .orderBy(desc(auditEvent.seq))
    .limit(1);
  return row;
}

const scopeText = (scope: unknown, key: string): string | null => {
  const value = (scope as Record<string, unknown> | null)?.[key];
  return typeof value === "string" ? value : null;
};

const scopeNumber = (scope: unknown, key: string): number | null => {
  const value = (scope as Record<string, unknown> | null)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

/** No personal data: the notice's source id is the member's opaque id. */
const CAPPED_NOTICE_TEXT = {
  device_hold: {
    title: "A member of staff reached today's limit on device tasks",
    body: "More of their devices reported unsent entries today. These are in the audit trail but raised no task. Check with them which devices still hold entries.",
  },
  entry_flag: {
    title: "A member of staff reached the limit on entries to check",
    body: `More of their deleted entries reached Harbour. These are in the audit trail but raised no task while ${FLAGGED_ENTRY_TASKS_PER_OWNER} are open. Finish the open tasks, then check the audit trail.`,
  },
} as const;

/**
 * The notice the location's Registered Managers get when a cap stops a task (clinical review round
 * 6, M1; security review round 6): at most one per person and source a day, audited, with no
 * personal data. Without a Registered Manager there (or anywhere), the holders of
 * `safety.incident.manage` get it. True when a notice was sent.
 */
async function noticeCapped(
  tx: Transaction,
  access: TenantAccess,
  input: {
    readonly subject: string;
    readonly source: "device_hold" | "entry_flag";
    readonly locationIds: readonly string[];
    readonly now: Date;
    readonly requestId: string | undefined;
  },
): Promise<boolean> {
  await lock(tx, access.tenantId, `capped_notice:${input.source}:${input.subject}`);
  const since = new Date(input.now.getTime() - CAPPED_NOTICE_HOURS * HOUR_MS);
  const [recent] = await tx
    .select({ id: auditEvent.id })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.resourceType, "tenant_user"),
        eq(auditEvent.resourceId, input.subject),
        eq(auditEvent.action, CAPPED_NOTICE_ACTION),
        sql`${auditEvent.scope} ->> 'source' = ${input.source}`,
        gt(auditEvent.occurredAt, since),
      ),
    )
    .limit(1);
  if (recent) return false;
  let recipients =
    input.locationIds.length > 0 ? await registeredManagers(tx, input.now, input.locationIds) : [];
  if (recipients.length === 0) recipients = await registeredManagers(tx, input.now);
  if (recipients.length === 0) {
    recipients = await permissionHolders(tx, DISCARD_OTHERS_PERMISSION, null, input.now);
  }
  const text = CAPPED_NOTICE_TEXT[input.source];
  for (const recipient of recipients) {
    await tx
      .insert(notification)
      .values({
        recipientTenantUserId: recipient,
        kind: CAPPED_NOTICE_KIND,
        severity: "warning",
        title: text.title,
        body: text.body,
        link: "/tasks",
        channels: ["in_app"],
        sourceType: "tenant_user",
        sourceId: input.subject,
        dedupeKey: `${CAPPED_NOTICE_KIND}:${input.source}:${input.subject}:${input.now.toISOString()}`,
      })
      .onConflictDoNothing();
  }
  await auditInTx(tx, access, {
    action: CAPPED_NOTICE_ACTION,
    resourceType: "tenant_user",
    resourceId: input.subject,
    scope: {
      source: input.source,
      recipients: recipients.length,
      locationIds: [...input.locationIds],
    },
    requestId: input.requestId,
  });
  return true;
}

// -------------------------------------------------------------------------------------------------
// Device-hold tasks
// -------------------------------------------------------------------------------------------------

export type DeviceHoldOutcome =
  | "raised"
  | "reopened"
  | "moved"
  | "reset"
  | "kept"
  | "closed"
  | "close_refused"
  | "capped"
  | "none";

const deviceTasks = (deviceId: string) =>
  and(
    eq(task.kind, DEVICE_HOLD_TASK_KIND),
    eq(task.sourceType, DEVICE_HOLD_SOURCE),
    eq(task.sourceId, deviceId),
    isNull(task.deletedAt),
  );

const openDeviceTasks = (deviceId: string) =>
  and(deviceTasks(deviceId), inArray(task.status, OPEN_STATUSES));

/** The device's last report before this one: how much waited, since when, and whose. */
async function previousReport(
  tx: Transaction,
  deviceId: string,
): Promise<{ waiting: number; waitingSince: Date | null; owner: string | null } | null> {
  const [row] = await tx
    .select({ scope: auditEvent.scope, actor: auditEvent.actorTenantUserId })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.resourceType, "device"),
        eq(auditEvent.resourceId, deviceId),
        eq(auditEvent.action, DEVICE_REPORT_ACTION),
      ),
    )
    .orderBy(desc(auditEvent.seq))
    .limit(1);
  if (!row) return null;
  const since = scopeText(row.scope, "waitingSince");
  const at = since ? new Date(since) : null;
  return {
    waiting: scopeNumber(row.scope, "waiting") ?? 0,
    waitingSince: at && !Number.isNaN(at.getTime()) ? at : null,
    owner: scopeText(row.scope, "ownerTenantUserId") ?? row.actor,
  };
}

/**
 * Whether the member may close the device's task (clinical review round 6, M1; security review
 * round 6): the hold's owner (named when the task was raised or reopened, even when someone else
 * sent that report), whoever raised it, or a holder of `safety.incident.manage` at one of its
 * locations. Null when none of these.
 */
async function closingRight(
  tx: Transaction,
  access: TenantAccess,
  open: readonly TaskRow[],
  now: Date,
): Promise<"owner" | "creator" | "manager" | null> {
  const raise = await latestTaskEvent(
    tx,
    open.map((t) => t.id),
    [DEVICE_HOLD_ACTIONS.raised, DEVICE_HOLD_ACTIONS.reopened],
  );
  if (raise && scopeText(raise.scope, "ownerTenantUserId") === access.tenantUserId) return "owner";
  if (open.some((t) => t.createdBy === access.tenantUserId)) return "creator";
  const locations = open.map((t) => t.locationId);
  if (await holdsPermissionAt(tx, access.tenantUserId, DISCARD_OTHERS_PERMISSION, locations, now)) {
    return "manager";
  }
  return null;
}

async function closeTasks(
  tx: Transaction,
  access: TenantAccess,
  rows: readonly TaskRow[],
  input: {
    readonly deviceId: string;
    readonly reason: string;
    readonly because: "report" | "deletion";
    readonly as: "owner" | "creator" | "manager";
    readonly now: Date;
    readonly requestId: string | undefined;
  },
): Promise<void> {
  for (const row of rows) {
    await tx
      .update(task)
      .set({
        status: "done",
        statusReason: input.reason,
        completedAt: input.now,
        completedBy: access.tenantUserId,
      })
      .where(eq(task.id, row.id));
    await auditInTx(tx, access, {
      action: DEVICE_HOLD_ACTIONS.closed,
      resourceType: "task",
      resourceId: row.id,
      scope: { deviceId: input.deviceId, because: input.because, as: input.as },
      requestId: input.requestId,
    });
  }
}

/**
 * Closes all of the device's open tasks when the member may (see `closingRight`); a refusal is
 * audited and leaves them open.
 */
async function closeIfEntitled(
  tx: Transaction,
  access: TenantAccess,
  deviceId: string,
  because: "report" | "deletion",
  now: Date,
  requestId: string | undefined,
): Promise<"closed" | "close_refused" | "none"> {
  const open = await tx.select().from(task).where(openDeviceTasks(deviceId));
  if (open.length === 0) return "none";
  const as = await closingRight(tx, access, open, now);
  if (!as) {
    await auditInTx(tx, access, {
      action: DEVICE_HOLD_ACTIONS.closeRefused,
      outcome: "denied",
      resourceType: "task",
      resourceId: open[0]?.id,
      scope: { deviceId, because },
      requestId,
    });
    return "close_refused";
  }
  await closeTasks(tx, access, open, {
    deviceId,
    reason:
      because === "report"
        ? "The device reported nothing waiting to upload."
        : "The device's held entries were deleted, with the deletion recorded.",
    because,
    as,
    now,
    requestId,
  });
  return "closed";
}

/**
 * Records a device's report (an audit event whose resource is the device) and raises, reopens,
 * moves, resets or closes the device's tasks (see the module comment). Runs as the system (tenant
 * scope) acting for the reporter, because the person reporting may not see the location's tasks;
 * the tasks hold no personal data. `report.ownerTenantUserId` must already be checked as a member.
 */
export async function recordDeviceHold(
  db: Db,
  access: TenantAccess,
  deviceId: string | null,
  report: SyncDeviceReport,
  receivedAt: Date,
  requestId?: string,
): Promise<DeviceHoldOutcome> {
  return withRequestContext(db, systemFor(access), async (tx) => {
    const times = clampReportTimes(report, receivedAt);
    const owner = report.ownerTenantUserId ?? access.tenantUserId;
    const waiting = waitingCount(report);
    if (deviceId) await lock(tx, access.tenantId, `device_hold:${deviceId}`);
    // A hold never started earlier than the device's last report for it said (round 6, N2).
    const previous = deviceId ? await previousReport(tx, deviceId) : null;
    const floor =
      waiting > 0 && previous && previous.waiting > 0 && previous.owner === owner
        ? previous.waitingSince
        : null;
    const unfloored = waitingSince(report, receivedAt);
    const since = waitingSince(report, receivedAt, floor);
    await auditInTx(tx, access, {
      action: DEVICE_REPORT_ACTION,
      ...(deviceId ? { resourceType: "device", resourceId: deviceId } : {}),
      scope: {
        unsent: report.unsent,
        refused: report.refused,
        held: report.held,
        blocked: report.blocked,
        oldestAgeSeconds: report.oldestAgeSeconds,
        heldSince: times.heldSince?.toISOString() ?? null,
        reportedAt: times.reportedAt.toISOString(),
        deviceClockAhead: times.clamped,
        waiting,
        waitingSince: waiting > 0 ? since.toISOString() : null,
        startFromEarlierReport: since.getTime() !== unfloored.getTime(),
        ownerTenantUserId: owner,
        locationIds: [...new Set(report.locationIds ?? [])],
      },
      requestId,
    });
    if (!deviceId) return "none";

    if (waiting === 0) {
      return closeIfEntitled(tx, access, deviceId, "report", receivedAt, requestId);
    }

    const dueAt = new Date(since.getTime() + (await heldMaxDays(tx, access.tenantId)) * DAY_MS);
    const open = await tx.select().from(task).where(openDeviceTasks(deviceId));
    if (open.length > 0) return keepOpen(tx, access, open, deviceId, dueAt, receivedAt, requestId);

    // Closed less than a day ago: the same task again, keeping its escalation (round 6, N2).
    const reopenAfter = new Date(receivedAt.getTime() - DEVICE_HOLD_REOPEN_HOURS * HOUR_MS);
    const recent = await tx
      .select()
      .from(task)
      .where(
        and(deviceTasks(deviceId), eq(task.status, "done"), gt(task.completedAt, reopenAfter)),
      );
    if (recent.length > 0) {
      for (const row of recent) {
        await tx
          .update(task)
          .set({ status: "open", statusReason: null, completedAt: null, completedBy: null, dueAt })
          .where(eq(task.id, row.id));
        await auditInTx(tx, access, {
          action: DEVICE_HOLD_ACTIONS.reopened,
          resourceType: "task",
          resourceId: row.id,
          scope: {
            deviceId,
            ownerTenantUserId: owner,
            dueAt: dueAt.toISOString(),
            escalationLevel: row.escalationLevel,
          },
          requestId,
        });
      }
      return "reopened";
    }

    const locations = await holdLocations(
      tx,
      { reporter: access.tenantUserId, owner },
      report.locationIds ?? [],
      receivedAt,
    );

    // A few devices per reporter in a rolling day, whatever became of their tasks (round 6, N2).
    const dayAgo = new Date(receivedAt.getTime() - DAY_MS);
    const raised = await tx
      .selectDistinct({ sourceId: task.sourceId })
      .from(task)
      .where(
        and(
          eq(task.kind, DEVICE_HOLD_TASK_KIND),
          eq(task.sourceType, DEVICE_HOLD_SOURCE),
          eq(task.createdBy, access.tenantUserId),
          isNull(task.deletedAt),
          or(gt(task.createdAt, dayAgo), inArray(task.status, OPEN_STATUSES)),
        ),
      );
    if (raised.length >= DEVICE_HOLD_TASKS_PER_REPORTER) {
      await auditInTx(tx, access, {
        action: DEVICE_HOLD_ACTIONS.capped,
        outcome: "denied",
        resourceType: "device",
        resourceId: deviceId,
        scope: {
          deviceId,
          raised: raised.length,
          ownerTenantUserId: owner,
          locationIds: locations,
          dueAt: dueAt.toISOString(),
        },
        requestId,
      });
      // Never silently: the location's Registered Managers hear once a day (clinical round 6, M1).
      await noticeCapped(tx, access, {
        subject: access.tenantUserId,
        source: "device_hold",
        locationIds: locations,
        now: receivedAt,
        requestId,
      });
      return "capped";
    }

    // One task per location, closed together (clinical review round 6, M2). No location known:
    // each Registered Manager gets one, assigned to them, so it is never visible only to
    // tenant-wide roles (C-H1). With no Registered Manager, tenant-wide roles see it.
    const targets: ReadonlyArray<{ locationId: string | null; assignee: string | null }> =
      locations.length > 0
        ? locations.map((locationId) => ({ locationId, assignee: null }))
        : await registeredManagers(tx, receivedAt).then((ids) =>
            ids.length > 0
              ? ids.map((assignee) => ({ locationId: null, assignee }))
              : [{ locationId: null, assignee: null }],
          );
    for (const target of targets) {
      const [created] = await tx
        .insert(task)
        .values({
          locationId: target.locationId,
          kind: DEVICE_HOLD_TASK_KIND,
          title: "Unsent care entries are waiting on a device",
          requiredPermission: DISCARD_OTHERS_PERMISSION,
          sourceType: DEVICE_HOLD_SOURCE,
          sourceId: deviceId,
          assigneeTenantUserId: target.assignee,
          assigneeRoleKey: "registered_manager",
          dueAt,
          priority: "routine",
        })
        .returning({ id: task.id });
      await auditInTx(tx, access, {
        action: DEVICE_HOLD_ACTIONS.raised,
        resourceType: "task",
        resourceId: created?.id,
        scope: {
          deviceId,
          ownerTenantUserId: owner,
          locationId: target.locationId,
          assigneeTenantUserId: target.assignee,
          dueAt: dueAt.toISOString(),
        },
        requestId,
      });
    }
    return "raised";
  });
}

/**
 * A device whose tasks are open reports entries waiting. After a refused close, the new hold resets
 * the tasks' escalation (once a day at most) so it signals again, with the due time never later
 * (clinical review round 6, M1). Otherwise the due time may only move earlier (S-M1).
 */
async function keepOpen(
  tx: Transaction,
  access: TenantAccess,
  open: readonly TaskRow[],
  deviceId: string,
  dueAt: Date,
  now: Date,
  requestId: string | undefined,
): Promise<DeviceHoldOutcome> {
  const ids = open.map((t) => t.id);
  const last = await latestTaskEvent(tx, ids, [
    DEVICE_HOLD_ACTIONS.raised,
    DEVICE_HOLD_ACTIONS.reopened,
    DEVICE_HOLD_ACTIONS.moved,
    DEVICE_HOLD_ACTIONS.reset,
    DEVICE_HOLD_ACTIONS.closeRefused,
  ]);
  if (last?.action === DEVICE_HOLD_ACTIONS.closeRefused) {
    const lastReset = await latestTaskEvent(tx, ids, [DEVICE_HOLD_ACTIONS.reset]);
    const resetAfter = now.getTime() - DEVICE_HOLD_RESET_HOURS * HOUR_MS;
    if (!lastReset || lastReset.occurredAt.getTime() <= resetAfter) {
      for (const row of open) {
        const due = dueAt.getTime() < row.dueAt.getTime() ? dueAt : row.dueAt;
        await tx
          .update(task)
          .set({ escalationLevel: 0, escalatedAt: null, dueAt: due })
          .where(eq(task.id, row.id));
        await auditInTx(tx, access, {
          action: DEVICE_HOLD_ACTIONS.reset,
          resourceType: "task",
          resourceId: row.id,
          scope: {
            deviceId,
            dueAt: due.toISOString(),
            escalationLevel: row.escalationLevel,
          },
          requestId,
        });
      }
      return "reset";
    }
  }
  let moved = false;
  for (const row of open) {
    if (dueAt.getTime() < row.dueAt.getTime()) {
      await tx.update(task).set({ dueAt }).where(eq(task.id, row.id));
      await auditInTx(tx, access, {
        action: DEVICE_HOLD_ACTIONS.moved,
        resourceType: "task",
        resourceId: row.id,
        scope: { deviceId, dueAt: dueAt.toISOString() },
        requestId,
      });
      moved = true;
    }
  }
  return moved ? "moved" : "kept";
}

/**
 * A deletion of the device's held entries, or of its unsent entries at sign-out, was recorded as
 * done: the device's tasks close (clinical review round 5, C-M3) when the sender may close them
 * (`closingRight`). `deviceId` is the device the entries were held on, which the deletion record
 * names, because the device's id changes with its next database.
 */
export async function closeDeviceHoldOnDeletion(
  db: Db,
  access: TenantAccess,
  deviceId: string | null,
  now: Date,
  requestId?: string,
): Promise<"closed" | "close_refused" | "none"> {
  if (!deviceId) return "none";
  return withRequestContext(db, systemFor(access), async (tx) => {
    await lock(tx, access.tenantId, `device_hold:${deviceId}`);
    return closeIfEntitled(tx, access, deviceId, "deletion", now, requestId);
  });
}

// -------------------------------------------------------------------------------------------------
// Flagged-entry tasks
// -------------------------------------------------------------------------------------------------

/**
 * The deletion record that says the uploader's own device deleted this entry: the earliest recorded
 * as "deleted" and not later as failed (security reviews round 5, S-M2 and L1, and round 6, N1).
 * Only deletions whose owner is the uploader count, so another member of staff cannot mark
 * someone's entries; the audit trail's resource index narrows the read to the tenant's deletion
 * records. Null when there is none.
 */
export async function reportedDeletedBy(
  tx: Transaction,
  entryId: string,
  uploaderTenantUserId: string,
): Promise<string | null> {
  const rows = await tx
    .select({ action: auditEvent.action, resourceId: auditEvent.resourceId })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.resourceType, "device_discard"),
        isNotNull(auditEvent.resourceId),
        inArray(auditEvent.action, [DISCARD_ACTIONS.deleted, DISCARD_ACTIONS.failed]),
        sql`${auditEvent.scope} ->> 'ownerTenantUserId' = ${uploaderTenantUserId}`,
        sql`${auditEvent.scope} -> 'entryIds' ? ${entryId}`,
      ),
    )
    .orderBy(asc(auditEvent.seq));
  const failed = new Set(
    rows.filter((r) => r.action === DISCARD_ACTIONS.failed).map((r) => r.resourceId),
  );
  return (
    rows.find((r) => r.action === DISCARD_ACTIONS.deleted && !failed.has(r.resourceId))
      ?.resourceId ?? null
  );
}

const FLAGGED_ENTRY_TITLES: Record<FlaggedEntryKind, string> = {
  [REPORTED_DELETED_TASK_KIND]: "Check entries uploaded after their device reported deleting them",
  [UPLOADED_BEFORE_DELETION_TASK_KIND]: "Check entries a device deleted after they reached Harbour",
};

/** The task's title with its count, which grows as further entries of the deletion arrive. */
const flaggedTitle = (kind: FlaggedEntryKind, count: number) =>
  `${FLAGGED_ENTRY_TITLES[kind]}: ${count}`;

/** The most frequent location among the entries, or null when none has one. */
function mostCommonLocation(entries: ReadonlyArray<{ readonly locationId: string | null }>) {
  const counts = new Map<string, number>();
  for (const { locationId } of entries) {
    if (locationId) counts.set(locationId, (counts.get(locationId) ?? 0) + 1);
  }
  return (
    [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null
  );
}

/** Open flagged-entry tasks raised for deletions of this owner's entries. */
async function openFlaggedTasksOf(tx: Transaction, owner: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(task)
    .where(
      and(
        inArray(task.kind, [...FLAGGED_ENTRY_TASK_KINDS]),
        eq(task.sourceType, FLAGGED_ENTRY_SOURCE),
        inArray(task.status, OPEN_STATUSES),
        isNull(task.deletedAt),
        sql`EXISTS (
          SELECT 1 FROM audit_event a
          WHERE a.tenant_id = ${task.tenantId} AND a.resource_type = 'task'
            AND a.resource_id = ${task.id}::text AND a.action = ${ENTRY_FLAG_ACTIONS.raised}
            AND a.scope ->> 'ownerTenantUserId' = ${owner})`,
      ),
    );
  return row?.n ?? 0;
}

interface FlaggedEntry {
  readonly id: string;
  readonly resourceType: string;
  readonly locationId: string | null;
}

/**
 * One review task per deletion record and kind (security review round 6, N1): the first flagged
 * entry raises it, due within a day; later ones add to its count. Takes a lock on (tenant, kind,
 * record) first, so racing uploads raise one. Each owner has a few open at most; past that, the
 * cap is audited and the location's Registered Managers get the daily notice. Call with
 * tenant-wide scope.
 */
async function raiseFlaggedTask(
  tx: Transaction,
  access: TenantAccess,
  input: {
    readonly kind: FlaggedEntryKind;
    readonly discardId: string;
    readonly ownerTenantUserId: string;
    readonly entries: readonly FlaggedEntry[];
    readonly now: Date;
    readonly requestId: string | undefined;
  },
): Promise<{ readonly outcome: "raised" | "added" | "capped"; readonly taskId: string | null }> {
  await lock(tx, access.tenantId, `${input.kind}:${input.discardId}`);
  const [open] = await tx
    .select({ id: task.id })
    .from(task)
    .where(
      and(
        eq(task.kind, input.kind),
        eq(task.sourceType, FLAGGED_ENTRY_SOURCE),
        eq(task.sourceId, input.discardId),
        inArray(task.status, OPEN_STATUSES),
        isNull(task.deletedAt),
      ),
    )
    .limit(1);
  if (open) {
    const last = await latestTaskEvent(
      tx,
      [open.id],
      [ENTRY_FLAG_ACTIONS.raised, ENTRY_FLAG_ACTIONS.added],
    );
    const count = (scopeNumber(last?.scope, "count") ?? 0) + input.entries.length;
    const listedBefore = scopeNumber(last?.scope, "listed") ?? 0;
    const entryIds = input.entries
      .slice(0, Math.max(0, FLAGGED_ENTRY_IDS_PER_TASK - listedBefore))
      .map((e) => e.id);
    await tx
      .update(task)
      .set({ title: flaggedTitle(input.kind, count) })
      .where(eq(task.id, open.id));
    await auditInTx(tx, access, {
      action: ENTRY_FLAG_ACTIONS.added,
      resourceType: "task",
      resourceId: open.id,
      scope: {
        discardId: input.discardId,
        count,
        listed: listedBefore + entryIds.length,
        entryIds,
      },
      requestId: input.requestId,
    });
    return { outcome: "added", taskId: open.id };
  }

  const locationId = mostCommonLocation(input.entries);
  const entryIds = input.entries.slice(0, FLAGGED_ENTRY_IDS_PER_TASK).map((e) => e.id);
  const openForOwner = await openFlaggedTasksOf(tx, input.ownerTenantUserId);
  if (openForOwner >= FLAGGED_ENTRY_TASKS_PER_OWNER) {
    await auditInTx(tx, access, {
      action: ENTRY_FLAG_ACTIONS.capped,
      outcome: "denied",
      resourceType: "device_discard",
      resourceId: input.discardId,
      scope: {
        kind: input.kind,
        ownerTenantUserId: input.ownerTenantUserId,
        open: openForOwner,
        count: input.entries.length,
        entryIds,
      },
      requestId: input.requestId,
    });
    await noticeCapped(tx, access, {
      subject: input.ownerTenantUserId,
      source: "entry_flag",
      locationIds: locationId ? [locationId] : [],
      now: input.now,
      requestId: input.requestId,
    });
    return { outcome: "capped", taskId: null };
  }

  // A record to check within the day, not an alarm: the care was given and the entry is kept
  // (HZ-008). Overdue, it escalates once to the holders of its permission at its location.
  const due = new Date(input.now.getTime() + FLAGGED_ENTRY_REVIEW_HOURS * HOUR_MS);
  const [created] = await tx
    .insert(task)
    .values({
      locationId,
      kind: input.kind,
      title: flaggedTitle(input.kind, input.entries.length),
      requiredPermission: DISCARD_OTHERS_PERMISSION,
      sourceType: FLAGGED_ENTRY_SOURCE,
      sourceId: input.discardId,
      assigneeRoleKey: "registered_manager",
      dueAt: due,
      windowStart: input.now,
      windowEnd: due,
      priority: "routine",
    })
    .returning({ id: task.id });
  await auditInTx(tx, access, {
    action: ENTRY_FLAG_ACTIONS.raised,
    resourceType: "task",
    resourceId: created?.id,
    scope: {
      discardId: input.discardId,
      ownerTenantUserId: input.ownerTenantUserId,
      count: input.entries.length,
      listed: entryIds.length,
      entryIds,
      locationId,
      dueAt: due.toISOString(),
    },
    requestId: input.requestId,
  });
  return { outcome: "raised", taskId: created?.id ?? null };
}

/**
 * Flags an entry uploaded after its owner's device recorded deleting it (clinical review round 4,
 * H1; security review round 6, N1): kept, as every upload is, with an audit event on the entry and
 * a count on the deletion record's review task. Call inside the upload's transaction, once the
 * entry is new; the task part runs with tenant-wide scope there (ADR-0033), because the uploader
 * may not see the location's tasks.
 */
export async function flagIfReportedDeleted(
  tx: Transaction,
  access: TenantAccess,
  entry: {
    readonly resourceType: string;
    readonly id: string;
    readonly locationId: string | null;
    readonly requestId: string | undefined;
  },
): Promise<boolean> {
  const discardId = await reportedDeletedBy(tx, entry.id, access.tenantUserId);
  if (!discardId) return false;
  const flagged = await withTenantWideScope(tx, () =>
    raiseFlaggedTask(tx, access, {
      kind: REPORTED_DELETED_TASK_KIND,
      discardId,
      ownerTenantUserId: access.tenantUserId,
      entries: [entry],
      now: new Date(),
      requestId: entry.requestId,
    }),
  );
  await auditInTx(tx, access, {
    action: ENTRY_FLAG_ACTIONS.afterDeletion,
    resourceType: entry.resourceType,
    resourceId: entry.id,
    scope: { reportedDeleted: true, discardId, taskId: flagged.taskId, task: flagged.outcome },
    requestId: entry.requestId,
  });
  return true;
}

/** The tables a device writes care entries to, with their resource names. */
const CARE_ENTRY_TABLES = [
  { resourceType: "care_note", table: careNote },
  { resourceType: "observation", table: observation },
  { resourceType: "body_map_mark", table: bodyMapMark },
  { resourceType: "activity_record", table: activityRecord },
  { resourceType: "visit_log", table: visitLog },
] as const;

/**
 * Entries a deletion recorded as "deleted" lists that had already reached the server, written by
 * the deletion's owner (clinical review round 5, C-L2): a response lost on the way back leaves the
 * device thinking an entry unsent, so its deletion would mislead. Each is kept and audited, and
 * counted on one review task for the deletion record (security review round 6, N1). An entry
 * flagged before, under an earlier record or on its upload, is not flagged again. Runs as the
 * system acting for the sender. Returns how many entries were newly flagged.
 */
export async function flagEntriesAlreadyUploaded(
  db: Db,
  access: TenantAccess,
  discard: {
    readonly id: string;
    readonly ownerTenantUserId: string | null;
    readonly entryIds: readonly string[];
  },
  requestId?: string,
): Promise<number> {
  if (!discard.ownerTenantUserId || discard.entryIds.length === 0) return 0;
  const owner = discard.ownerTenantUserId;
  return withRequestContext(db, systemFor(access), async (tx) => {
    // One owner's deletions are flagged in turn, so two records listing an entry flag it once.
    await lock(tx, access.tenantId, `entry_flag_owner:${owner}`);
    const found: FlaggedEntry[] = [];
    for (const { resourceType, table } of CARE_ENTRY_TABLES) {
      const rows = await tx
        .select({ id: table.id, locationId: table.locationId })
        .from(table)
        .where(and(inArray(table.id, [...discard.entryIds]), eq(table.createdBy, owner)));
      for (const row of rows) found.push({ id: row.id, resourceType, locationId: row.locationId });
    }
    if (found.length === 0) return 0;
    const seen = await tx
      .selectDistinct({ id: auditEvent.resourceId })
      .from(auditEvent)
      .where(
        and(
          inArray(auditEvent.resourceType, [...new Set(found.map((e) => e.resourceType))]),
          inArray(
            auditEvent.resourceId,
            found.map((e) => e.id),
          ),
          inArray(auditEvent.action, [
            ENTRY_FLAG_ACTIONS.beforeDeletion,
            ENTRY_FLAG_ACTIONS.afterDeletion,
          ]),
        ),
      );
    const seenIds = new Set(seen.map((s) => s.id));
    const fresh = found.filter((e) => !seenIds.has(e.id));
    if (fresh.length === 0) return 0;
    const flagged = await raiseFlaggedTask(tx, access, {
      kind: UPLOADED_BEFORE_DELETION_TASK_KIND,
      discardId: discard.id,
      ownerTenantUserId: owner,
      entries: fresh,
      now: new Date(),
      requestId,
    });
    for (const entry of fresh) {
      await auditInTx(tx, access, {
        action: ENTRY_FLAG_ACTIONS.beforeDeletion,
        resourceType: entry.resourceType,
        resourceId: entry.id,
        scope: { discardId: discard.id, taskId: flagged.taskId, task: flagged.outcome },
        requestId,
      });
    }
    return fresh.length;
  });
}
