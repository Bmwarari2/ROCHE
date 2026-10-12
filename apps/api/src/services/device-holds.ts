/**
 * What the server does with a device's reports about unsent work and with deletions of it
 * (HZ-006, HZ-008, HZ-040; clinical reviews round 4 H1 and H2, rounds 5 and 6; security reviews
 * rounds 5 and 6). Built on the task engine, the audit trail and the device integrity tables
 * (`device_binding`, care.md section 6).
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
 * - The report's named owner counts only when bound to the device (`device_binding`: a sync token
 *   issued to it or a report sent from it). An owner who is not bound is recorded as a claim and
 *   changes nothing: the task is routed by the reporter's assignments and the claim gives no right
 *   to close it (security review round 7, M1). A hold's start is never earlier than the server first
 *   saw the device (its earliest binding).
 * - A report with nothing waiting, or a recorded deletion of the device's held entries, closes the
 *   task when it comes from the hold's owner, from whoever raised the task, or from someone holding
 *   `safety.incident.manage` at one of its locations. A refused close followed by a new hold resets
 *   the task's escalation, and so does a reopen, at most once a day (`DEVICE_HOLD_RESET_HOURS`), so
 *   a new hold always signals: a reopen that finds the day's reset used is reset once it is due.
 * - A task closed less than a day ago is reopened rather than raised again. Each reporter raises
 *   tasks for at most 3 devices in a rolling day; past that, the hold joins the reporter's one
 *   capped-holds task, due at the earliest capped hold's time, so no cap stops a task (clinical
 *   review round 7, M2), and the location's Registered Managers get one notice a day about the
 *   reporter. Every raise, reopen, move, reset, merge, close and cap is audited.
 *
 * Flagged-entry tasks (one per deletion record and location, never one per entry):
 * - An entry uploaded after its own owner's device recorded deleting it ("deleted", not failed), and
 *   an entry a deletion lists that had already reached the server, are each audited and counted on
 *   one review task for the deletion record at the entry's location, carrying its owner, the count
 *   and up to 50 entries by kind and opaque id in `task.details` (care.md section 6, Device
 *   integrity part 4). An entry already flagged is not flagged again under a new record. Each owner
 *   has at most 5 such tasks open at a location; past that, the entries join the oldest of them.
 *   The task is due at once when any entry is an observation (a chart), otherwise within a day
 *   (clinical review round 7, M3). A partial unique index keeps one open task per source.
 */
import type { SyncDeviceReport } from "@harbour/contracts";
import {
  activityRecord,
  auditEvent,
  bodyMapMark,
  careNote,
  deviceDiscardEntry,
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
import { and, asc, desc, eq, gt, inArray, isNull, lte, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { auditInTx } from "../http/audit";
import type { TenantAccess } from "../http/context";
import { bindDevice, boundToDevice, deviceFirstSeen } from "./devices";
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
/** The reporter's one task for holds past their daily cap; its source id is the reporter. */
export const CAPPED_HOLDS_SOURCE = "device_hold_capped";
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
/**
 * Entries a flagged-entry task lists in its details (kind and opaque id); its count covers the rest
 * (care.md section 6, Device integrity part 4).
 */
export const FLAGGED_ENTRY_IDS_PER_TASK = 50;
/** Flagged-entry tasks an owner's deletions may have open at a location; more join the oldest. */
export const FLAGGED_ENTRY_TASKS_PER_OWNER = 5;
/** A flagged entry with no observation among it is checked within the day (HZ-008; H-148). */
export const FLAGGED_ENTRY_REVIEW_HOURS = 24;
/** The notice the location's Registered Managers get when a cap merges a task (HZ-008). */
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
  merged: "sync.device_hold.merged",
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
export async function registeredManagers(
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
 * Who takes a sync task when no one at its location can act on it (clinical reviews round 7 M5 and
 * round 8 M1): the Registered Managers anywhere in the organisation, else the holders of
 * `permission` anywhere, longest-serving first (the earliest start of a live assignment, then the
 * id), so the first is chosen the same way every time. Empty when there is no one.
 */
export async function fallbackRecipients(
  tx: Transaction,
  permission: string,
  now: Date,
): Promise<string[]> {
  const since = sql`min(${roleAssignment.validFrom})`;
  const managers = await tx
    .select({ id: roleAssignment.tenantUserId })
    .from(roleAssignment)
    .innerJoin(role, eq(role.id, roleAssignment.roleId))
    .where(and(eq(role.key, "registered_manager"), liveAssignment(now)))
    .groupBy(roleAssignment.tenantUserId)
    .orderBy(since, roleAssignment.tenantUserId);
  if (managers.length > 0) return managers.map((r) => r.id);
  const holders = await tx
    .select({ id: roleAssignment.tenantUserId })
    .from(roleAssignment)
    .innerJoin(role, eq(role.id, roleAssignment.roleId))
    .where(
      and(
        sql`${permission} = ANY(${role.permissions})`,
        isNull(role.archivedAt),
        liveAssignment(now),
      ),
    )
    .groupBy(roleAssignment.tenantUserId)
    .orderBy(since, roleAssignment.tenantUserId);
  return holders.map((r) => r.id);
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
 * organisation's when the reporter is assigned across it); with none left, the reporter's live
 * locations, then their most recent one (an agency worker's role ends with the shift). Empty when no
 * location is known.
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
    // Every location only from the reporter's own organisation-wide role, never from a named owner's
    // (security review round 7, L1).
    const everywhere = rows.some(
      (r) => r.tenantUserId === people.reporter && isLive(r) && r.locationId === null,
    );
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
    body: "More of their devices reported unsent entries today. They are on one task for that member of staff, due when the earliest of those holds escalates. Check with them which devices still hold entries.",
  },
  entry_flag: {
    title: "A member of staff reached the limit on entries to check",
    body: `More of their deleted entries reached Harbour while ${FLAGGED_ENTRY_TASKS_PER_OWNER} tasks for them were open here. The entries were added to the oldest of those tasks: check it first.`,
  },
} as const;

/**
 * The notice the location's Registered Managers get when a cap merges a task into another (clinical
 * reviews rounds 6 and 7; security review round 6), in addition to the merged task itself: at most
 * one per person and source a day, audited, with no personal data. Without a Registered Manager
 * there (or anywhere), the holders of `safety.incident.manage` get it. True when one was sent.
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

/** Events whose resource is the device: sync tokens issued to it and the reports it sent. */
const deviceEvents = (deviceId: string) =>
  and(eq(auditEvent.resourceType, "device"), eq(auditEvent.resourceId, deviceId));

/** The device's last report before this one: how much waited, since when, and whose. */
async function previousReport(
  tx: Transaction,
  deviceId: string,
): Promise<{ waiting: number; waitingSince: Date | null; owner: string | null } | null> {
  const [row] = await tx
    .select({ scope: auditEvent.scope, actor: auditEvent.actorTenantUserId })
    .from(auditEvent)
    .where(and(deviceEvents(deviceId), eq(auditEvent.action, DEVICE_REPORT_ACTION)))
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

/** The later of two floors. */
const later = (a: Date | null, b: Date | null): Date | null =>
  a && b ? (a.getTime() >= b.getTime() ? a : b) : (a ?? b);

/**
 * True when the tasks' escalation may be reset now: no reset in the last
 * `DEVICE_HOLD_RESET_HOURS`, whether after a refused close or on a reopen (clinical reviews
 * round 6, M1 and round 7, M1), so a hold signals at least once a day and at most once more.
 */
async function escalationResetDue(
  tx: Transaction,
  taskIds: readonly string[],
  now: Date,
): Promise<boolean> {
  const [row] = await tx
    .select({ occurredAt: auditEvent.occurredAt })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.resourceType, "task"),
        inArray(auditEvent.resourceId, [...taskIds]),
        or(
          eq(auditEvent.action, DEVICE_HOLD_ACTIONS.reset),
          and(
            eq(auditEvent.action, DEVICE_HOLD_ACTIONS.reopened),
            sql`(${auditEvent.scope} ->> 'escalationReset') = 'true'`,
          ),
        ),
      ),
    )
    .orderBy(desc(auditEvent.seq))
    .limit(1);
  return !row || row.occurredAt.getTime() <= now.getTime() - DEVICE_HOLD_RESET_HOURS * HOUR_MS;
}

/**
 * Whether the member may close the device's task (clinical review round 6, M1; security reviews
 * rounds 6 and 7): the hold's owner (as recorded when the task was raised or reopened: a named
 * owner only when bound to the device), whoever raised it, or a holder of `safety.incident.manage`
 * at one of its locations. Null when none of these.
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

/** Where a new task goes: one per location, else one per Registered Manager, else unassigned. */
async function taskTargets(
  tx: Transaction,
  locations: readonly string[],
  now: Date,
): Promise<ReadonlyArray<{ locationId: string | null; assignee: string | null }>> {
  if (locations.length > 0) return locations.map((locationId) => ({ locationId, assignee: null }));
  // No location known: each Registered Manager gets one, assigned to them, so it is never visible
  // only to tenant-wide roles (C-H1). With no Registered Manager, tenant-wide roles see it.
  const managers = await registeredManagers(tx, now);
  return managers.length > 0
    ? managers.map((assignee) => ({ locationId: null, assignee }))
    : [{ locationId: null, assignee: null }];
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
    const reporter = access.tenantUserId;
    const times = clampReportTimes(report, receivedAt);
    const waiting = waitingCount(report);
    const claimed = report.ownerTenantUserId ?? reporter;
    if (deviceId) await lock(tx, access.tenantId, `device_hold:${deviceId}`);
    // Read before this report is recorded, so it counts for none of them.
    const previous = deviceId ? await previousReport(tx, deviceId) : null;
    // From `device_binding`, never the audit trail (care.md section 6, Device integrity part 1).
    const bound = deviceId ? await boundToDevice(tx, deviceId, claimed) : false;
    const seen = deviceId ? await deviceFirstSeen(tx, deviceId) : null;
    // The hold's owner as the server takes it (security review round 7, M1): the named owner (or
    // the reporter) only when bound to the device; otherwise the owner the device last reported,
    // else the reporter. A claim that is not bound is recorded, routes nothing and closes nothing.
    const owner = bound ? claimed : (previous?.owner ?? reporter);
    const claimedOwner = !bound && claimed !== reporter ? claimed : null;
    // A hold never started before the device's last report for it said (round 6, N2), whoever is
    // named as its owner, since one device id is one database and so one owner (security review
    // round 7, L2), nor before the server first heard from the device (round 7, M1).
    const fromPrevious =
      waiting > 0 && previous && previous.waiting > 0 ? previous.waitingSince : null;
    const fromFirstSeen = deviceId ? (seen ?? receivedAt) : null;
    const unfloored = waitingSince(report, receivedAt);
    const since = waitingSince(report, receivedAt, later(fromPrevious, fromFirstSeen));
    const byPrevious = waitingSince(report, receivedAt, fromPrevious);
    const startFloor =
      since.getTime() === unfloored.getTime()
        ? null
        : since.getTime() === byPrevious.getTime()
          ? "earlier_report"
          : "first_seen";
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
        startFloor,
        ownerTenantUserId: owner,
        ownerBound: bound,
        ...(claimedOwner ? { claimedOwnerTenantUserId: claimedOwner } : {}),
        locationIds: [...new Set(report.locationIds ?? [])],
      },
      requestId,
    });
    if (!deviceId) return "none";
    // The reporter has now sent a report from the device: bound from here on, judged after this
    // report so it counts for none of its own decisions.
    await bindDevice(tx, deviceId, reporter, receivedAt);

    if (waiting === 0) {
      return closeIfEntitled(tx, access, deviceId, "report", receivedAt, requestId);
    }

    const dueAt = new Date(since.getTime() + (await heldMaxDays(tx, access.tenantId)) * DAY_MS);
    const open = await tx.select().from(task).where(openDeviceTasks(deviceId));
    if (open.length > 0) return keepOpen(tx, access, open, deviceId, dueAt, receivedAt, requestId);

    // Closed less than a day ago: the same task again (round 6, N2). An escalated task's level is
    // reset under the once-a-day check, so the new hold signals; when the day's reset is used, the
    // reopen records that (escalationReset: false) and a later report resets it once it is due
    // (`keepOpen`; clinical reviews round 7 M1 and round 8 M2). The recorded owner is kept
    // (security reviews round 7, M1 and L2).
    const reopenAfter = new Date(receivedAt.getTime() - DEVICE_HOLD_REOPEN_HOURS * HOUR_MS);
    const recent = await tx
      .select()
      .from(task)
      .where(
        and(deviceTasks(deviceId), eq(task.status, "done"), gt(task.completedAt, reopenAfter)),
      );
    if (recent.length > 0) {
      const ids = recent.map((t) => t.id);
      const lastRaise = await latestTaskEvent(tx, ids, [
        DEVICE_HOLD_ACTIONS.raised,
        DEVICE_HOLD_ACTIONS.reopened,
      ]);
      const keptOwner = scopeText(lastRaise?.scope, "ownerTenantUserId") ?? owner;
      const resetDue = await escalationResetDue(tx, ids, receivedAt);
      for (const row of recent) {
        // Only a task that escalated has anything to reset, and only that uses the day's reset.
        const escalated = row.escalationLevel > 0;
        const reset = escalated && resetDue;
        await tx
          .update(task)
          .set({
            status: "open",
            statusReason: null,
            completedAt: null,
            completedBy: null,
            dueAt,
            ...(reset ? { escalationLevel: 0, escalatedAt: null } : {}),
          })
          .where(eq(task.id, row.id));
        await auditInTx(tx, access, {
          action: DEVICE_HOLD_ACTIONS.reopened,
          resourceType: "task",
          resourceId: row.id,
          scope: {
            deviceId,
            ownerTenantUserId: keptOwner,
            ...(claimedOwner ? { claimedOwnerTenantUserId: claimedOwner } : {}),
            dueAt: dueAt.toISOString(),
            escalationLevel: row.escalationLevel,
            ...(escalated ? { escalationReset: reset } : {}),
          },
          requestId,
        });
      }
      return "reopened";
    }

    // Routed by the reporter's assignments, and the owner's only when bound (security M1).
    const locations = await holdLocations(
      tx,
      { reporter, owner: bound ? claimed : reporter },
      report.locationIds ?? [],
      receivedAt,
    );

    // A few devices per reporter in a rolling day, whatever became of their tasks (round 6, N2),
    // counted under a per-reporter lock so racing reports from several devices take turns.
    await lock(tx, access.tenantId, `device_hold_reporter:${reporter}`);
    const dayAgo = new Date(receivedAt.getTime() - DAY_MS);
    const raised = await tx
      .selectDistinct({ sourceId: task.sourceId })
      .from(task)
      .where(
        and(
          eq(task.kind, DEVICE_HOLD_TASK_KIND),
          eq(task.sourceType, DEVICE_HOLD_SOURCE),
          eq(task.createdBy, reporter),
          isNull(task.deletedAt),
          or(gt(task.createdAt, dayAgo), inArray(task.status, OPEN_STATUSES)),
        ),
      );
    if (raised.length >= DEVICE_HOLD_TASKS_PER_REPORTER) {
      // No cap stops a task (clinical review round 7, M2): the hold goes onto the reporter's one
      // capped-holds task, due at the earliest capped hold's time and escalating like a device task.
      const merged = await mergeCappedHold(tx, access, {
        deviceId,
        locations,
        dueAt,
        now: receivedAt,
        requestId,
      });
      await auditInTx(tx, access, {
        action: DEVICE_HOLD_ACTIONS.capped,
        outcome: "denied",
        resourceType: "device",
        resourceId: deviceId,
        scope: {
          deviceId,
          raised: raised.length,
          ownerTenantUserId: owner,
          ...(claimedOwner ? { claimedOwnerTenantUserId: claimedOwner } : {}),
          locationIds: locations,
          dueAt: dueAt.toISOString(),
          mergedInto: merged,
        },
        requestId,
      });
      await noticeCapped(tx, access, {
        subject: reporter,
        source: "device_hold",
        locationIds: locations,
        now: receivedAt,
        requestId,
      });
      return "capped";
    }

    // One task per location, closed together (clinical review round 6, M2).
    for (const target of await taskTargets(tx, locations, receivedAt)) {
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
        // One open task per device, location and assignee (part 4): a racing raise adds nothing.
        .onConflictDoNothing()
        .returning({ id: task.id });
      if (!created) continue;
      await auditInTx(tx, access, {
        action: DEVICE_HOLD_ACTIONS.raised,
        resourceType: "task",
        resourceId: created?.id,
        scope: {
          deviceId,
          ownerTenantUserId: owner,
          ...(claimedOwner ? { claimedOwnerTenantUserId: claimedOwner } : {}),
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
 * A hold past the reporter's daily cap joins the reporter's one capped-holds task (clinical review
 * round 7, M2): raised at the hold's locations when none is open, otherwise brought forward to the
 * earliest capped hold's due time. A manager completes it once the devices are dealt with. Call
 * under the per-reporter lock. Returns the task ids.
 */
async function mergeCappedHold(
  tx: Transaction,
  access: TenantAccess,
  input: {
    readonly deviceId: string;
    readonly locations: readonly string[];
    readonly dueAt: Date;
    readonly now: Date;
    readonly requestId: string | undefined;
  },
): Promise<string[]> {
  const reporter = access.tenantUserId;
  const open = await tx
    .select()
    .from(task)
    .where(
      and(
        eq(task.kind, DEVICE_HOLD_TASK_KIND),
        eq(task.sourceType, CAPPED_HOLDS_SOURCE),
        eq(task.sourceId, reporter),
        inArray(task.status, OPEN_STATUSES),
        isNull(task.deletedAt),
      ),
    );
  if (open.length > 0) {
    for (const row of open) {
      const due = input.dueAt.getTime() < row.dueAt.getTime() ? input.dueAt : row.dueAt;
      if (due !== row.dueAt) await tx.update(task).set({ dueAt: due }).where(eq(task.id, row.id));
      await auditInTx(tx, access, {
        action: DEVICE_HOLD_ACTIONS.merged,
        resourceType: "task",
        resourceId: row.id,
        scope: { deviceId: input.deviceId, created: false, dueAt: due.toISOString() },
        requestId: input.requestId,
      });
    }
    return open.map((t) => t.id);
  }
  const ids: string[] = [];
  for (const target of await taskTargets(tx, input.locations, input.now)) {
    const [created] = await tx
      .insert(task)
      .values({
        locationId: target.locationId,
        kind: DEVICE_HOLD_TASK_KIND,
        title:
          "Unsent care entries are waiting on more devices than one member of staff may report",
        requiredPermission: DISCARD_OTHERS_PERMISSION,
        sourceType: CAPPED_HOLDS_SOURCE,
        sourceId: reporter,
        assigneeTenantUserId: target.assignee,
        assigneeRoleKey: "registered_manager",
        dueAt: input.dueAt,
        priority: "routine",
      })
      .onConflictDoNothing()
      .returning({ id: task.id });
    if (!created) continue;
    ids.push(created.id);
    await auditInTx(tx, access, {
      action: DEVICE_HOLD_ACTIONS.merged,
      resourceType: "task",
      resourceId: created.id,
      scope: {
        deviceId: input.deviceId,
        created: true,
        locationId: target.locationId,
        assigneeTenantUserId: target.assignee,
        dueAt: input.dueAt.toISOString(),
      },
      requestId: input.requestId,
    });
  }
  return ids;
}

/**
 * A device whose tasks are open reports entries waiting. After a refused close, the new hold resets
 * the tasks' escalation (under the once-a-day check) so it signals again, with the due time never
 * later (clinical review round 6, M1); so does a reopen whose reset was deferred (round 8, M2).
 * Otherwise the due time may only move earlier (S-M1).
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
  // After a refused close, every copy; otherwise an escalated copy whose reopen found the day's
  // reset used (escalationReset: false) and has not been reset since, so that hold still signals
  // once the reset is due: a device re-reports every half hour while anything waits (clinical
  // review round 8, M2).
  const deferred: TaskRow[] = [];
  if (last?.action !== DEVICE_HOLD_ACTIONS.closeRefused) {
    for (const row of open) {
      if (row.escalationLevel === 0) continue;
      const since = await latestTaskEvent(
        tx,
        [row.id],
        [DEVICE_HOLD_ACTIONS.reopened, DEVICE_HOLD_ACTIONS.reset],
      );
      const scope = since?.scope as Record<string, unknown> | null | undefined;
      if (since?.action === DEVICE_HOLD_ACTIONS.reopened && scope?.escalationReset === false) {
        deferred.push(row);
      }
    }
  }
  const toReset = last?.action === DEVICE_HOLD_ACTIONS.closeRefused ? [...open] : deferred;
  if (toReset.length > 0 && (await escalationResetDue(tx, ids, now))) {
    for (const row of toReset) {
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
          ...(toReset === deferred ? { deferred: true } : {}),
        },
        requestId,
      });
    }
    return "reset";
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
 * someone's entries. One indexed read of `device_discard_entry` (care.md section 6, Device
 * integrity part 3; the HZ-040 go-live blocker), never a scan of the tenant's deletion records.
 * Null when there is none.
 */
export async function reportedDeletedBy(
  tx: Transaction,
  entryId: string,
  uploaderTenantUserId: string,
): Promise<string | null> {
  const failed = alias(deviceDiscardEntry, "failed");
  const [row] = await tx
    .select({ discardId: deviceDiscardEntry.discardId })
    .from(deviceDiscardEntry)
    .where(
      and(
        eq(deviceDiscardEntry.entryId, entryId.toLowerCase()),
        eq(deviceDiscardEntry.ownerTenantUserId, uploaderTenantUserId),
        eq(deviceDiscardEntry.stage, "deleted"),
        notExists(
          tx
            .select({ id: failed.id })
            .from(failed)
            .where(
              and(
                eq(failed.tenantId, deviceDiscardEntry.tenantId),
                eq(failed.discardId, deviceDiscardEntry.discardId),
                eq(failed.entryId, deviceDiscardEntry.entryId),
                eq(failed.stage, "failed"),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(deviceDiscardEntry.recordedAt), asc(deviceDiscardEntry.id))
    .limit(1);
  return row?.discardId ?? null;
}

const FLAGGED_ENTRY_TITLES: Record<string, string> = {
  [REPORTED_DELETED_TASK_KIND]: "Check entries uploaded after their device reported deleting them",
  [UPLOADED_BEFORE_DELETION_TASK_KIND]: "Check entries a device deleted after they reached Harbour",
};

/** The task's title with its count, which grows as further entries are added. */
const flaggedTitle = (kind: string, count: number) =>
  `${FLAGGED_ENTRY_TITLES[kind] ?? FLAGGED_ENTRY_TITLES[REPORTED_DELETED_TASK_KIND]}: ${count}`;

interface FlaggedEntry {
  readonly id: string;
  readonly resourceType: string;
  readonly locationId: string | null;
}

/**
 * When the review falls due (clinical review round 7, M3): at once when any entry is an
 * observation (fluids, repositioning, vital signs and every other chart), because a possible
 * duplicate counts towards the day's totals and can complete a round; otherwise within
 * `FLAGGED_ENTRY_REVIEW_HOURS` (human action H-148).
 */
export function flaggedDue(entries: readonly FlaggedEntry[], now: Date): Date {
  return entries.some((e) => e.resourceType === "observation")
    ? now
    : new Date(now.getTime() + FLAGGED_ENTRY_REVIEW_HOURS * HOUR_MS);
}

const atLocation = (locationId: string | null) =>
  locationId ? eq(task.locationId, locationId) : isNull(task.locationId);

/** This owner's open flagged-entry tasks at a location, oldest first, read from their details. */
async function openFlaggedTasksOf(
  tx: Transaction,
  owner: string,
  locationId: string | null,
): Promise<TaskRow[]> {
  return tx
    .select()
    .from(task)
    .where(
      and(
        inArray(task.kind, [...FLAGGED_ENTRY_TASK_KINDS]),
        eq(task.sourceType, FLAGGED_ENTRY_SOURCE),
        atLocation(locationId),
        inArray(task.status, OPEN_STATUSES),
        isNull(task.deletedAt),
        sql`${task.details} ->> 'ownerTenantUserId' = ${owner}`,
      ),
    )
    .orderBy(asc(task.createdAt));
}

/**
 * A flagged-entry task's details (care.md section 6, Device integrity part 4): whose deleted
 * entries they are, how many, and up to `FLAGGED_ENTRY_IDS_PER_TASK` of them by kind and opaque id,
 * the rest counted (`TaskDetails` in packages/contracts). Never clinical text.
 */
export function flaggedDetails(
  before: unknown,
  owner: string,
  entries: readonly FlaggedEntry[],
  now: Date,
): Record<string, unknown> {
  const was = (before ?? {}) as Record<string, unknown>;
  const listed = Array.isArray(was.entries) ? (was.entries as unknown[]) : [];
  const room = Math.max(0, FLAGGED_ENTRY_IDS_PER_TASK - listed.length);
  const added = entries
    .slice(0, room)
    .map((e) => ({ kind: e.resourceType, entryId: e.id, at: now.toISOString() }));
  const omitted =
    (typeof was.entriesOmitted === "number" ? was.entriesOmitted : 0) +
    (entries.length - added.length);
  return {
    ...was,
    ownerTenantUserId: typeof was.ownerTenantUserId === "string" ? was.ownerTenantUserId : owner,
    entryCount: (typeof was.entryCount === "number" ? was.entryCount : 0) + entries.length,
    entries: [...listed, ...added],
    ...(omitted > 0 ? { entriesOmitted: omitted } : {}),
  };
}

/**
 * Adds entries to an open flagged-entry task: its count and list grow in its details, and its due
 * time comes forward when the new entries call for it. The audit event says how many were added.
 */
async function addToFlaggedTask(
  tx: Transaction,
  access: TenantAccess,
  target: TaskRow,
  input: {
    readonly discardId: string;
    readonly ownerTenantUserId: string;
    readonly entries: readonly FlaggedEntry[];
    readonly merged: boolean;
    readonly now: Date;
    readonly requestId: string | undefined;
  },
): Promise<void> {
  const [locked] = await tx
    .select({ details: task.details, dueAt: task.dueAt })
    .from(task)
    .where(eq(task.id, target.id))
    .for("update");
  const details = flaggedDetails(
    locked?.details ?? target.details,
    input.ownerTenantUserId,
    input.entries,
    input.now,
  );
  const count = details.entryCount as number;
  const due = flaggedDue(input.entries, input.now);
  const sooner = due.getTime() < (locked?.dueAt ?? target.dueAt).getTime();
  await tx
    .update(task)
    .set({
      title: flaggedTitle(target.kind, count),
      details,
      ...(sooner ? { dueAt: due, windowEnd: due } : {}),
    })
    .where(eq(task.id, target.id));
  await auditInTx(tx, access, {
    action: ENTRY_FLAG_ACTIONS.added,
    resourceType: "task",
    resourceId: target.id,
    scope: {
      discardId: input.discardId,
      count,
      added: input.entries.length,
      ...(input.merged ? { merged: true } : {}),
      ...(sooner ? { dueAt: due.toISOString() } : {}),
    },
    requestId: input.requestId,
  });
}

type FlagOutcome = { readonly outcome: "raised" | "added" | "merged"; readonly taskId: string };

/**
 * One review task per deletion record, kind and location (security review round 6, N1; clinical
 * review round 7, M4), so each location's managers see only their own people's entries: the first
 * flagged entry there raises it, later ones add to its count. Takes a lock on (tenant, kind,
 * record, location) first, so racing uploads raise one. Each owner has at most 5 open at a
 * location; past that, the entries join the owner's oldest open one there, the cap is audited and
 * the Registered Managers get the daily notice: no cap stops a task (clinical review round 7, M2).
 * Call with tenant-wide scope, under the owner's lock.
 */
async function raiseFlaggedTaskAt(
  tx: Transaction,
  access: TenantAccess,
  input: {
    readonly kind: FlaggedEntryKind;
    readonly discardId: string;
    readonly ownerTenantUserId: string;
    readonly locationId: string | null;
    readonly entries: readonly FlaggedEntry[];
    readonly now: Date;
    readonly requestId: string | undefined;
  },
): Promise<FlagOutcome> {
  await lock(
    tx,
    access.tenantId,
    `${input.kind}:${input.discardId}:${input.locationId ?? "no_location"}`,
  );
  const [open] = await tx
    .select()
    .from(task)
    .where(
      and(
        eq(task.kind, input.kind),
        eq(task.sourceType, FLAGGED_ENTRY_SOURCE),
        eq(task.sourceId, input.discardId),
        atLocation(input.locationId),
        inArray(task.status, OPEN_STATUSES),
        isNull(task.deletedAt),
      ),
    )
    .limit(1);
  const add = {
    discardId: input.discardId,
    ownerTenantUserId: input.ownerTenantUserId,
    entries: input.entries,
    now: input.now,
  };
  if (open) {
    await addToFlaggedTask(tx, access, open, { ...add, merged: false, requestId: input.requestId });
    return { outcome: "added", taskId: open.id };
  }

  const owners = await openFlaggedTasksOf(tx, input.ownerTenantUserId, input.locationId);
  const oldest = owners[0];
  if (oldest && owners.length >= FLAGGED_ENTRY_TASKS_PER_OWNER) {
    await addToFlaggedTask(tx, access, oldest, {
      ...add,
      merged: true,
      requestId: input.requestId,
    });
    await auditInTx(tx, access, {
      action: ENTRY_FLAG_ACTIONS.capped,
      outcome: "denied",
      resourceType: "device_discard",
      resourceId: input.discardId,
      scope: {
        kind: input.kind,
        ownerTenantUserId: input.ownerTenantUserId,
        locationId: input.locationId,
        open: owners.length,
        count: input.entries.length,
        mergedInto: oldest.id,
      },
      requestId: input.requestId,
    });
    await noticeCapped(tx, access, {
      subject: input.ownerTenantUserId,
      source: "entry_flag",
      locationIds: input.locationId ? [input.locationId] : [],
      now: input.now,
      requestId: input.requestId,
    });
    return { outcome: "merged", taskId: oldest.id };
  }

  // Overdue, it escalates once to the holders of its permission at its location (HZ-008). The
  // open-task index takes a racing second raise as the first one's task (part 4).
  const due = flaggedDue(input.entries, input.now);
  const [created] = await tx
    .insert(task)
    .values({
      locationId: input.locationId,
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
      details: flaggedDetails(null, input.ownerTenantUserId, input.entries, input.now),
    })
    .onConflictDoNothing()
    .returning({ id: task.id });
  if (!created) {
    const [raced] = await tx
      .select()
      .from(task)
      .where(
        and(
          eq(task.kind, input.kind),
          eq(task.sourceType, FLAGGED_ENTRY_SOURCE),
          eq(task.sourceId, input.discardId),
          atLocation(input.locationId),
          inArray(task.status, OPEN_STATUSES),
          isNull(task.deletedAt),
        ),
      )
      .limit(1);
    if (!raced) throw new Error("The flagged-entry task was not created.");
    await addToFlaggedTask(tx, access, raced, {
      ...add,
      merged: false,
      requestId: input.requestId,
    });
    return { outcome: "added", taskId: raced.id };
  }
  await auditInTx(tx, access, {
    action: ENTRY_FLAG_ACTIONS.raised,
    resourceType: "task",
    resourceId: created.id,
    scope: {
      discardId: input.discardId,
      ownerTenantUserId: input.ownerTenantUserId,
      count: input.entries.length,
      locationId: input.locationId,
      dueAt: due.toISOString(),
    },
    requestId: input.requestId,
  });
  return { outcome: "raised", taskId: created.id };
}

/**
 * Flags entries of one deletion record, grouped by location (clinical review round 7, M4), each
 * group on its location's task. Returns each entry's task and outcome. Call with tenant-wide scope.
 */
async function raiseFlaggedTasks(
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
): Promise<Map<string, FlagOutcome>> {
  // One owner's flags are taken in turn, so racing uploads or deletions cannot pass the cap
  // (security review round 7, low).
  await lock(tx, access.tenantId, `entry_flag_owner:${input.ownerTenantUserId}`);
  const groups = new Map<string, FlaggedEntry[]>();
  for (const entry of input.entries) {
    const key = entry.locationId ?? "";
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const outcomes = new Map<string, FlagOutcome>();
  for (const key of [...groups.keys()].sort()) {
    const entries = groups.get(key) ?? [];
    const outcome = await raiseFlaggedTaskAt(tx, access, {
      ...input,
      locationId: key === "" ? null : key,
      entries,
    });
    for (const entry of entries) outcomes.set(entry.id, outcome);
  }
  return outcomes;
}

/**
 * Flags an entry uploaded after its owner's device recorded deleting it (clinical review round 4,
 * H1; security review round 6, N1): kept, as every upload is, with an audit event on the entry and
 * a count on the deletion record's review task at the entry's location. Call inside the upload's
 * transaction, once the entry is new; the task part runs with tenant-wide scope there (ADR-0033),
 * because the uploader may not see the location's tasks.
 */
export async function flagIfReportedDeleted(
  tx: Transaction,
  access: TenantAccess,
  entry: {
    readonly resourceType: string;
    readonly id: string;
    readonly locationId: string | null;
    readonly requestId: string | undefined;
    /**
     * Whose entry it is, when not the caller's: the owner of a handed-over entry, whose own
     * deletions count (care.md section 6, Device integrity part 6).
     */
    readonly uploader?: string | undefined;
  },
): Promise<boolean> {
  const uploader = entry.uploader ?? access.tenantUserId;
  const discardId = await reportedDeletedBy(tx, entry.id, uploader);
  if (!discardId) return false;
  const outcomes = await withTenantWideScope(tx, () =>
    raiseFlaggedTasks(tx, access, {
      kind: REPORTED_DELETED_TASK_KIND,
      discardId,
      ownerTenantUserId: uploader,
      entries: [entry],
      now: new Date(),
      requestId: entry.requestId,
    }),
  );
  const flagged = outcomes.get(entry.id);
  await auditInTx(tx, access, {
    action: ENTRY_FLAG_ACTIONS.afterDeletion,
    resourceType: entry.resourceType,
    resourceId: entry.id,
    scope: {
      reportedDeleted: true,
      discardId,
      taskId: flagged?.taskId ?? null,
      task: flagged?.outcome ?? null,
    },
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
 * counted on the deletion record's review task at its location (security review round 6, N1;
 * clinical review round 7, M4). An entry flagged before, under an earlier record or on its upload,
 * is not flagged again; every flagged entry is on a task. Runs as the system acting for the
 * sender. Returns how many entries were newly flagged.
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
    const outcomes = await raiseFlaggedTasks(tx, access, {
      kind: UPLOADED_BEFORE_DELETION_TASK_KIND,
      discardId: discard.id,
      ownerTenantUserId: owner,
      entries: fresh,
      now: new Date(),
      requestId,
    });
    for (const entry of fresh) {
      const flagged = outcomes.get(entry.id);
      await auditInTx(tx, access, {
        action: ENTRY_FLAG_ACTIONS.beforeDeletion,
        resourceType: entry.resourceType,
        resourceId: entry.id,
        scope: {
          discardId: discard.id,
          taskId: flagged?.taskId ?? null,
          task: flagged?.outcome ?? null,
        },
        requestId,
      });
    }
    return fresh.length;
  });
}
