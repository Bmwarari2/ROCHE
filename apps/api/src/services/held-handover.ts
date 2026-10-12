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
 * Each entry (`admitHandedOverEntry`, #25 review round 2, H1): the device has an open hold owned by
 * that person (its last report says entries wait and names them as the bound owner), and the
 * hold's entries handed over since its report (by someone other than the sender, where there is
 * one) stay within the count it reported; the entry was recorded at or after the owner first used
 * the device and, on a revoked device, at or before the revocation; the person was in the owner's
 * care (an assignment, or a tenant-wide or location role at their location) within the offline
 * window; and the hand-over id names this owner, device and sender only. Each entry is recorded in
 * `handed_over_entry` before it is written. Refusals are 422 `handover_refused`: the device stops
 * and keeps the entry held.
 *
 * The entry is written as the owner's (`created_by`) with the sender as `handed_over_by` ("Sent
 * by"), any task it completes is judged on the owner's permission when the care was recorded
 * (never the manager's), it is flagged against the owner's deletions, and `sync.entry.handed_over`
 * records the sender, the owner, the device and the hand-over.
 */
import { HANDOVER_ID_HEADER, HANDOVER_OWNER_HEADER } from "@harbour/contracts";
import { auditEvent, handedOverEntry, type Transaction, tenantUser } from "@harbour/db";
import { and, count, desc, eq, gt, sql } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx } from "../http/audit";
import { type AppEnv, requirePermission, type TenantAccess } from "../http/context";
import { problems } from "../http/problem";
import {
  bindingOf,
  boundToDevice,
  inSystemView,
  offlineWindowDaysOf,
  personReachedBy,
} from "./devices";

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
 * Admits one entry of a hand-over before it is written (see the module comment), recording it in
 * `handed_over_entry`; a replay of an entry already admitted for the same owner passes without
 * counting again. Throws 422 `handover_refused` otherwise.
 */
export async function admitHandedOverEntry(
  c: Context<AppEnv>,
  handover: HeldHandover,
  entry: {
    readonly table: "care_note" | "observation" | "body_map_mark" | "activity_record" | "visit_log";
    readonly entryId: string | undefined;
    readonly personId: string;
    readonly occurredAt: string;
  },
): Promise<void> {
  if (!entry.entryId) {
    throw problems.invalid("A handed-over entry carries the id it was written with.");
  }
  const entryId = entry.entryId.toLowerCase();
  const occurredAt = new Date(entry.occurredAt);
  const access = c.get("access");
  const now = new Date();
  const refusal = await inSystemView(c.get("services").db, access, async (tx) => {
    await tx.execute(
      // One hold's entries are admitted one at a time, so racing requests cannot pass its count.
      sqlLock(access.tenantId, handover.deviceId, handover.ownerTenantUserId),
    );
    // A hand-over id names one owner, device and sender (#25 review round 2, H1).
    const [used] = await tx
      .select({
        owner: handedOverEntry.ownerTenantUserId,
        deviceId: handedOverEntry.deviceId,
        sentBy: handedOverEntry.sentBy,
      })
      .from(handedOverEntry)
      .where(eq(handedOverEntry.handoverId, handover.handoverId))
      .limit(1);
    if (
      used &&
      (used.owner !== handover.ownerTenantUserId ||
        used.deviceId !== handover.deviceId ||
        used.sentBy !== handover.senderTenantUserId)
    ) {
      return "That hand-over id is already used for another member of staff, device or sender.";
    }
    const [admitted] = await tx
      .select({ owner: handedOverEntry.ownerTenantUserId })
      .from(handedOverEntry)
      .where(
        and(eq(handedOverEntry.recordTable, entry.table), eq(handedOverEntry.entryId, entryId)),
      );
    if (admitted) {
      return admitted.owner === handover.ownerTenantUserId
        ? null
        : "That entry was sent for another member of staff.";
    }
    const hold = await openHold(tx, handover.deviceId, handover.ownerTenantUserId);
    const latest = hold[0];
    if (!latest) {
      return "The device has not reported entries waiting for this member of staff. Send its report first.";
    }
    // The count a hand-over may send: the hold's report from someone other than the sender where
    // there is one, so the sender's own report cannot raise it; else the latest.
    const basis = hold.find((r) => r.reporter !== handover.senderTenantUserId) ?? latest;
    const [sent] = await tx
      .select({ n: count() })
      .from(handedOverEntry)
      .where(
        and(
          eq(handedOverEntry.deviceId, handover.deviceId),
          eq(handedOverEntry.ownerTenantUserId, handover.ownerTenantUserId),
          gt(handedOverEntry.acceptedAt, basis.occurredAt),
        ),
      );
    if ((sent?.n ?? 0) >= basis.waiting) {
      return `All ${basis.waiting} entries the device reported waiting for this member of staff have been sent.`;
    }
    const binding = await bindingOf(tx, handover.deviceId, handover.ownerTenantUserId);
    if (!binding || occurredAt.getTime() < binding.firstSeenAt.getTime()) {
      return "This entry is timed before that member of staff first used this device.";
    }
    if (binding.revokedAt && occurredAt.getTime() > binding.revokedAt.getTime()) {
      return "This entry is timed after the device was withdrawn.";
    }
    const windowDays = await offlineWindowDaysOf(tx, access.tenantId);
    const since = new Date(now.getTime() - windowDays * DAY_MS);
    if (!(await personReachedBy(tx, handover.ownerTenantUserId, entry.personId, since, now))) {
      return "This person was not in that member of staff's care while the device was offline.";
    }
    await tx.insert(handedOverEntry).values({
      handoverId: handover.handoverId,
      deviceId: handover.deviceId,
      ownerTenantUserId: handover.ownerTenantUserId,
      sentBy: handover.senderTenantUserId,
      recordTable: entry.table,
      entryId,
      acceptedAt: now,
    });
    return null;
  });
  if (refusal) throw problems.handoverRefused(refusal);
}

function sqlLock(tenantId: string, deviceId: string, owner: string) {
  return sql`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}:handover:${deviceId}:${owner}`}))`;
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
