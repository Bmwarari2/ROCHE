/**
 * The hand-over of held entries (care.md section 6, Device integrity part 6; HZ-004, HZ-006,
 * HZ-040): a manager signed in on the device holding another member of staff's unsent entries
 * sends them on that person's behalf, or the owner sends their own from a device a manager
 * revoked. Each entry goes to its own endpoint with `x-harbour-handover-owner` (the owner),
 * `x-harbour-handover` (an id for the hand-over) and `x-harbour-device` (the device that held it).
 *
 * The request (`heldHandoverOf`): the owner is staff of the organisation (whatever their status
 * now) bound to that device; the sender is the owner or holds `care.held_entry.hand_over` (step-up
 * and MFA), and is bound to the device too (the device sends its report as the sender first, and a
 * report binds the reporter).
 *
 * Each entry is planned before its transaction (`planHandedOverEntry`, #25 review rounds 2 and 3):
 * the device has an open hold owned by that person (its reports since the hold began say entries
 * wait and name them as the bound owner). The count comes from the latest report in that hold not
 * sent by the sender, the owner's own preferred (the sender's own reports never count, so a sender
 * cannot report nothing and then a large count; the owner sending their own uses their own
 * reports); with no such report the hand-over is refused, since a second holder's confirmation is
 * a decision for the CSO and DPO (H-158). The entry's time is its device time, else its event time,
 * with the clock-drift tolerance (`sync.clock_drift_flag_minutes`): at or after the owner first
 * used the device, at or before the report that counted it, and, on a revoked device, at or before
 * the revocation. The person was in the owner's care (an assignment, or a tenant-wide or location
 * role at their location) within the offline window before the entry's own time. Each entry is
 * then admitted in its own transaction (`recordHandedOverEntry`, the database function
 * `app.admit_handed_over_entry`): the hand-over id names this owner, device and sender only, and
 * the hold's entries admitted since that report stay within its count, so an entry the API then
 * refuses uses none of it. Refusals are 422 `handover_refused`: the device keeps that entry held
 * with the reason and carries on with the rest.
 *
 * The entry is written as the owner's (`created_by`) with the sender as `handed_over_by` ("Sent
 * by"), any task it completes is judged on the owner's permission when the care was recorded
 * (never the manager's), it is flagged against the owner's deletions, and `sync.entry.handed_over`
 * records the sender, the owner, the device and the hand-over.
 */
import { HANDOVER_ID_HEADER, HANDOVER_OWNER_HEADER } from "@harbour/contracts";
import { auditEvent, handedOverEntry, type Transaction, tenantUser } from "@harbour/db";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx } from "../http/audit";
import { type AppEnv, requirePermission, type TenantAccess } from "../http/context";
import { problems } from "../http/problem";
import {
  bindingOf,
  boundToDevice,
  ENTRY_PERMISSION,
  inSystemView,
  offlineWindowDaysOf,
  personReachedBy,
} from "./devices";
import { CLOCK_DRIFT_RATE_KEY } from "./people";
import { rateNumber } from "./rates";

/** The permission a manager needs to send another member's held entries (step-up). */
export const HANDOVER_PERMISSION = "care.held_entry.hand_over" as const;
/** The audit action on an entry sent by a hand-over. */
export const HANDED_OVER_ACTION = "sync.entry.handed_over";
/** A device's report of its unsent work (`DEVICE_REPORT_ACTION` in device-holds). */
const REPORT_ACTION = "sync.device.report";
/** The reports read back to find the start of a hold. */
const HOLD_REPORTS_READ = 50;
const DAY_MS = 86_400_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface HeldHandover {
  readonly ownerTenantUserId: string;
  readonly handoverId: string;
  /** The device that held the entries. */
  readonly deviceId: string;
  /** True when the owner sends their own (from a revoked device). */
  readonly byOwner: boolean;
  /** Who sends them: the caller. */
  readonly senderTenantUserId: string;
}

/** Who sent an entry for its author: the sender of a manager's hand-over, else null. */
export function handedOverByOf(handover: HeldHandover | null): string | null {
  return handover && !handover.byOwner ? handover.senderTenantUserId : null;
}

/**
 * The hand-over a request makes, checked (see the module comment), or null when it makes none.
 * Refusals are 422 (`invalid` for a malformed hand-over, `handover_refused` for one the server will
 * not take) or the permission's own 403 (`missing_permission`, `step_up_required`,
 * `mfa_enrolment_required`).
 */
export async function heldHandoverOf(
  c: Context<AppEnv>,
  access: TenantAccess,
): Promise<HeldHandover | null> {
  const owner = c.req.header(HANDOVER_OWNER_HEADER);
  if (owner === undefined) return null;
  const handoverId = c.req.header(HANDOVER_ID_HEADER);
  if (!UUID.test(owner) || !handoverId || !UUID.test(handoverId)) {
    throw problems.invalid("A hand-over names its owner and has an id.");
  }
  const deviceId = access.deviceId;
  if (!deviceId) throw problems.invalid("A hand-over names the device that held the entries.");
  const ownerId = owner.toLowerCase();
  const byOwner = ownerId === access.tenantUserId;
  // A manager needs the hand-over permission, with a fresh sign-in; the owner sends their own.
  if (!byOwner) await requirePermission(c, HANDOVER_PERMISSION);
  const known = await inSystemView(c.get("services").db, access, async (tx) => {
    const [member] = await tx
      .select({ id: tenantUser.id })
      .from(tenantUser)
      .where(eq(tenantUser.id, ownerId));
    if (!member || !(await boundToDevice(tx, deviceId, ownerId))) return "owner_unbound" as const;
    if (!byOwner && !(await boundToDevice(tx, deviceId, access.tenantUserId))) {
      return "sender_unbound" as const;
    }
    return "ok" as const;
  });
  if (known === "owner_unbound") {
    throw problems.handoverRefused(
      "That member of staff has not used this device, so its entries are not theirs to hand over.",
    );
  }
  if (known === "sender_unbound") {
    throw problems.handoverRefused(
      "Send this device's report from your own sign-in first: a hand-over is taken only from someone who has used the device.",
    );
  }
  return {
    ownerTenantUserId: ownerId,
    handoverId: handoverId.toLowerCase(),
    deviceId,
    byOwner,
    senderTenantUserId: access.tenantUserId,
  };
}

interface HoldReport {
  readonly occurredAt: Date;
  readonly reporter: string | null;
  readonly waiting: number;
  readonly owner: string | null;
}

function numberIn(scope: unknown, key: string): number {
  const value = (scope as Record<string, unknown> | null)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function textIn(scope: unknown, key: string): string | null {
  const value = (scope as Record<string, unknown> | null)?.[key];
  return typeof value === "string" ? value : null;
}

/**
 * The device's open hold for the owner: the reports since it began, newest first, while each says
 * entries wait and names the owner. Empty when the device's last report shows no such hold.
 */
async function openHold(tx: Transaction, deviceId: string, owner: string): Promise<HoldReport[]> {
  const rows = await tx
    .select({
      occurredAt: auditEvent.occurredAt,
      actor: auditEvent.actorTenantUserId,
      scope: auditEvent.scope,
    })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.resourceType, "device"),
        eq(auditEvent.resourceId, deviceId),
        eq(auditEvent.action, REPORT_ACTION),
      ),
    )
    .orderBy(desc(auditEvent.seq))
    .limit(HOLD_REPORTS_READ);
  const hold: HoldReport[] = [];
  for (const row of rows) {
    const report = {
      occurredAt: row.occurredAt,
      reporter: row.actor,
      waiting: numberIn(row.scope, "waiting"),
      owner: textIn(row.scope, "ownerTenantUserId"),
    };
    if (report.waiting <= 0 || report.owner !== owner) break;
    hold.push(report);
  }
  return hold;
}

/**
 * The report a hand-over's count comes from (#25 review round 3, item 1): the latest in the open
 * hold not sent by the sender, the owner's own preferred; the sender's own are skipped, never
 * stopped at. The owner sending their own uses their own reports. Undefined when there is none.
 */
function countBasis(
  hold: readonly HoldReport[],
  owner: string,
  sender: string,
): HoldReport | undefined {
  const others = owner === sender ? hold : hold.filter((r) => r.reporter !== sender);
  return others.find((r) => r.reporter === owner) ?? others[0];
}

export type HandedOverTable =
  | "care_note"
  | "observation"
  | "body_map_mark"
  | "activity_record"
  | "visit_log";

/** A handed-over entry checked against its hold, for `recordHandedOverEntry` in its transaction. */
export interface HandedOverAdmission {
  readonly handover: HeldHandover;
  readonly table: HandedOverTable;
  readonly entryId: string;
  /** When the report that gave the count was made, and the count. */
  readonly since: Date;
  readonly limit: number;
}

/** The time a hand-over judges an entry by: when it was made on the device, else its event time. */
function entryTimeOf(entry: { readonly occurredAt: string; readonly deviceTime?: string | null }) {
  const at = new Date(entry.deviceTime ?? entry.occurredAt);
  if (Number.isNaN(at.getTime())) throw problems.invalid("The entry's time is not a time.");
  return at;
}

/**
 * Checks one entry of a hand-over against the device's hold before its transaction (see the module
 * comment), and returns what `recordHandedOverEntry` needs. An entry already admitted passes on to
 * the admission, which takes it again for the same owner (a replay). Throws 422 `handover_refused`.
 */
export async function planHandedOverEntry(
  c: Context<AppEnv>,
  handover: HeldHandover,
  entry: {
    readonly table: HandedOverTable;
    readonly entryId: string | undefined;
    readonly personId: string | null;
    readonly occurredAt: string;
    readonly deviceTime?: string | null | undefined;
  },
): Promise<HandedOverAdmission> {
  if (!entry.entryId) {
    throw problems.invalid("A handed-over entry carries the id it was written with.");
  }
  const entryId = entry.entryId.toLowerCase();
  const at = entryTimeOf(entry);
  const access = c.get("access");
  const owner = handover.ownerTenantUserId;
  const plan = await inSystemView(c.get("services").db, access, async (tx) => {
    const [admitted] = await tx
      .select({ owner: handedOverEntry.ownerTenantUserId })
      .from(handedOverEntry)
      .where(
        and(eq(handedOverEntry.recordTable, entry.table), eq(handedOverEntry.entryId, entryId)),
      );
    // A replay: the admission in the entry's transaction passes it again, or refuses another owner.
    if (admitted) return { since: new Date(0), limit: 0 };
    const hold = await openHold(tx, handover.deviceId, owner);
    if (hold.length === 0) {
      return "The device has not reported entries waiting for this member of staff. Send its report first.";
    }
    const basis = countBasis(hold, owner, handover.senderTenantUserId);
    if (!basis) {
      return "Only your own reports show entries waiting for this member of staff, so the server cannot count them. It needs a report the device sent while they or someone else was signed in.";
    }
    const toleranceMs = (await rateNumber(tx, access.tenantId, CLOCK_DRIFT_RATE_KEY)) * 60_000;
    const binding = await bindingOf(tx, handover.deviceId, owner);
    if (!binding || at.getTime() < binding.firstSeenAt.getTime() - toleranceMs) {
      return "This entry is timed before that member of staff first used this device.";
    }
    if (binding.revokedAt && at.getTime() > binding.revokedAt.getTime() + toleranceMs) {
      return "This entry is timed after the device was withdrawn.";
    }
    if (at.getTime() > basis.occurredAt.getTime() + toleranceMs) {
      return "This entry is timed after the device last reported it waiting.";
    }
    if (entry.personId) {
      // The care window runs back from the entry's own time, so an owner whose access ended since
      // (over a weekend, or while the hold waited for days) still counts (#25 review round 3, M1).
      const windowDays = await offlineWindowDaysOf(tx, access.tenantId);
      const since = new Date(at.getTime() - windowDays * DAY_MS);
      const until = new Date(at.getTime() + toleranceMs);
      if (!(await personReachedBy(tx, owner, entry.personId, since, until, ENTRY_PERMISSION))) {
        return "This person was not in that member of staff's care when the entry was made.";
      }
    }
    return { since: basis.occurredAt, limit: basis.waiting };
  });
  if (typeof plan === "string") throw problems.handoverRefused(plan);
  return { handover, table: entry.table, entryId, ...plan };
}

/**
 * Admits a planned entry in the transaction that writes it (#25 review round 3, low), through
 * `app.admit_handed_over_entry`: one hand-over id at a time, then one hold at a time; the id names
 * this owner, device and sender only; an entry already admitted for the owner passes again;
 * otherwise the hold's entries admitted since its report stay within its count. Call in the
 * sender's transaction (their own view or the system's acting for them), before the entry is
 * written. Throws 422 `handover_refused`, which rolls the transaction back.
 */
export async function recordHandedOverEntry(
  tx: Transaction,
  admission: HandedOverAdmission,
): Promise<void> {
  const { handover } = admission;
  const result = await tx.execute<{ reason: string | null }>(sql`
    SELECT app.admit_handed_over_entry(
      ${handover.handoverId}::uuid, ${handover.deviceId}::uuid, ${handover.ownerTenantUserId}::uuid,
      ${handover.senderTenantUserId}::uuid, ${admission.table}, ${admission.entryId}::uuid,
      ${admission.since.toISOString()}::timestamptz, ${admission.limit}::integer) AS reason`);
  const reason = result.rows[0]?.reason;
  if (reason) throw problems.handoverRefused(reason);
}

/** Records that an entry reached the server by a hand-over, in the entry's transaction. */
export async function auditHandedOver(
  tx: Transaction,
  access: TenantAccess,
  handover: HeldHandover | null,
  entry: {
    readonly resourceType: string;
    readonly id: string;
    readonly requestId: string | undefined;
  },
): Promise<void> {
  if (!handover) return;
  await auditInTx(tx, access, {
    action: HANDED_OVER_ACTION,
    resourceType: entry.resourceType,
    resourceId: entry.id,
    scope: {
      ownerTenantUserId: handover.ownerTenantUserId,
      heldOnDeviceId: handover.deviceId,
      handoverId: handover.handoverId,
      byOwner: handover.byOwner,
    },
    requestId: entry.requestId,
  });
}
