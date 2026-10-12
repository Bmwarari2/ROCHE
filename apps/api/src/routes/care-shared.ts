import type { Transaction } from "@harbour/db";
import type { CareTrigger, PersonRecordKind } from "@harbour/domain";
import { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { auditInTx } from "../http/audit";
import { type AppEnv, requirePermission, type TenantAccess, withTenant } from "../http/context";
import { problems } from "../http/problem";
import { applyTaskLink, type PlannedTaskLink, planTaskLink } from "../services/care";
import { refuseRevokedDevice } from "../services/devices";
import { type HeldHandover, heldHandoverOf } from "../services/held-handover";
import { CareEventAfterExit, loadPerson, raiseLateEntryReview } from "../services/people";

/**
 * Helpers shared by the point-of-care routes (care.ts, care-plans.ts and care-records.ts): the
 * person path parameter, reading windows, the output of append-only entries and corrections.
 */

export const PersonParam = z.object({ id: z.uuid() });
export const SENT_AT_HEADER = "x-harbour-sent-at";
const DAY_MS = 86_400_000;

export const range = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

/** A reading window: the last three days by default, never more than 92 days. */
export function window(q: { from?: string; to?: string }, now: Date) {
  const from = q.from ? new Date(q.from) : new Date(now.getTime() - 3 * DAY_MS);
  const to = q.to ? new Date(q.to) : new Date(now.getTime() + DAY_MS);
  if (to.getTime() - from.getTime() > 92 * DAY_MS)
    throw problems.invalid("Ask for 92 days or fewer.");
  return { from, to };
}

export const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function entryOut(
  row: {
    id: string;
    personId: string;
    locationId: string;
    occurredAt: Date;
    recordedAt: Date;
    deviceTime: Date | null;
    lateEntry: boolean;
    clockDrift: boolean;
    recordedAfterExit: boolean;
    taskId: string | null;
    taskOutcome: string | null;
    supersedesId: string | null;
    correctionReason: string | null;
    createdBy: string | null;
  },
  superseded: ReadonlySet<string>,
) {
  return {
    id: row.id,
    personId: row.personId,
    locationId: row.locationId,
    occurredAt: row.occurredAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
    deviceTime: iso(row.deviceTime),
    lateEntry: row.lateEntry,
    clockDrift: row.clockDrift,
    recordedAfterExit: row.recordedAfterExit,
    taskId: row.taskId,
    taskOutcome: row.taskOutcome as PlannedTaskLink["outcome"] | null,
    supersedesId: row.supersedesId,
    correctionReason: row.correctionReason,
    superseded: superseded.has(row.id),
    recordedBy: row.createdBy,
  };
}

export function supersededIds(rows: readonly { supersedesId: string | null }[]): Set<string> {
  return new Set(rows.flatMap((r) => (r.supersedesId ? [r.supersedesId] : [])));
}

/** A correction must point at an entry about the same person, and say why. */
export function requireCorrection(body: { supersedesId?: string; correctionReason?: string }) {
  if (body.supersedesId && !body.correctionReason) {
    throw problems.invalid("Say why the entry is being corrected.");
  }
}

/** Who writes a care entry a device uploads, and for whom. */
export interface EntryWriter {
  readonly access: TenantAccess;
  /** Who wrote the entry: the caller, or the owner of handed-over entries (`created_by`). */
  readonly author: string;
  /** The hand-over the entry arrives by, when it does (care.md section 6, Device integrity). */
  readonly handover: HeldHandover | null;
}

/**
 * The access for a care entry a device uploads (notes, observations, body-map marks, activities and
 * visits): the route's permission; a hand-over of held entries checked (part 6); otherwise a device
 * a manager revoked refused with 403 `device_revoked`, audited (part 2). A hand-over is how a
 * revoked device's entries leave it, so it is not refused.
 */
export async function entryWriteAccess(
  c: Context<AppEnv>,
  kind: "care_note" | "observation" | "body_map_mark" | "activity_record" | "visit_log",
): Promise<EntryWriter> {
  const access = await requirePermission(c, "care.note.write");
  const handover = await heldHandoverOf(c, access);
  if (!handover) {
    await refuseRevokedDevice(c.get("services"), access, `care.${kind}`, c.get("requestId"));
  }
  return { access, author: handover?.ownerTenantUserId ?? access.tenantUserId, handover };
}

export function permissionsOf(access: TenantAccess): ReadonlySet<string> {
  return new Set(access.effective.permissions);
}

/**
 * What an entry will do to the task it names (`planTaskLink`), or null when it names none. The
 * author's permission is judged when the care was recorded (`occurredAt`; HZ-004, HZ-006).
 */
export async function planLink(
  tx: Transaction,
  access: TenantAccess,
  taskId: string | undefined,
  personId: string,
  occurredAt: Date,
  author: string = access.tenantUserId,
): Promise<PlannedTaskLink | null> {
  if (!taskId) return null;
  // A handed-over entry is judged on its author's permission when the care was recorded, never on
  // the manager's who sent it (care.md section 6, Device integrity part 6).
  const handedOver = author !== access.tenantUserId;
  return planTaskLink(tx, {
    taskId,
    personId,
    actorTenantUserId: author,
    actorPermissions: handedOver ? new Set<string>() : permissionsOf(access),
    occurredAt,
  });
}

/**
 * Carries out a planned link once this request has inserted the entry (`applyTaskLink`). An
 * assignee who may not complete the task has the completion refused and audited with the entry,
 * which is kept, flagged and reviewed (S1 follow-on; HZ-004, HZ-006); a duplicate upload that lost
 * the race to insert writes nothing, so no refusal is recorded for an entry it did not create.
 */
export async function applyLink(
  tx: Transaction,
  access: TenantAccess,
  requestId: string | undefined,
  link: PlannedTaskLink,
  entry: Parameters<typeof applyTaskLink>[2],
): Promise<void> {
  await applyTaskLink(tx, link, entry);
  if (link.assigneeRefused) {
    await auditInTx(tx, access, {
      action: "platform.task.done",
      outcome: "denied",
      resourceType: "task",
      resourceId: link.taskId,
      reason: "assignee_lacks_permission",
      requestId,
    });
  }
}

/**
 * The kind of a care event for people.md rule 3: once a person has left or died, an entry about an
 * event at or before then is a care event (accepted and flagged as recorded after the exit), and
 * a note about anything later is a post-event note.
 */
export function eventKind(
  person: {
    status: string;
    statusChangedAt: Date;
    dischargedAt: Date | null;
    deceasedAt: Date | null;
  },
  kind: "care_note" | "observation" | "body_map_mark" | "assessment",
  occurredAt: Date,
): PersonRecordKind {
  if (kind !== "care_note" || (person.status !== "discharged" && person.status !== "deceased")) {
    return kind;
  }
  const exit =
    person.status === "deceased"
      ? (person.deceasedAt ?? person.statusChangedAt)
      : (person.dischargedAt ?? person.statusChangedAt);
  return occurredAt.getTime() > exit.getTime() ? "post_event_note" : "care_note";
}

/** Rule 12: a closed record takes post-event records only. */
export function requireOpenRecord(person: { closed: boolean }) {
  if (person.closed) {
    throw problems.invalid("This person's record is closed; only post-event notes can be added.");
  }
}

/** The refused entry as the late-entry review names it: opaque references, no clinical text. */
export interface RefusedEntry {
  /** The kind of entry (`care_note`, `observation`, `incident` and so on). */
  readonly kind: string;
  /** The device-generated id the entry was sent with, if any. */
  readonly clientId?: string | null | undefined;
  /** When the entry says the event happened. */
  readonly occurredAt?: string | null | undefined;
  /** Who wrote it, when not the caller (a handed-over entry's owner). */
  readonly recordedBy?: string | undefined;
}

/**
 * Runs a care write. A care event timed after the person left, died or went away (beyond the
 * clock tolerance) is refused, so the device keeps it to resolve, and one review task goes to the
 * nurse in charge in its own transaction, so it is not lost with the refusal. The task names the
 * entry's kind, client id, device and user (people.md rule 3; HZ-006).
 */
export async function withLateEntryReview<T>(
  c: Context<AppEnv>,
  entry: RefusedEntry,
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof CareEventAfterExit) {
      const access = c.get("access");
      await withTenant(c, async (tx) => {
        const p = await loadPerson(tx, error.personId);
        const taskId = await raiseLateEntryReview(tx, p, new Date(), {
          kind: entry.kind,
          clientId: entry.clientId ?? null,
          occurredAt: entry.occurredAt ?? null,
          deviceId: access.deviceId,
          recordedBy: entry.recordedBy ?? access.tenantUserId,
        });
        await auditInTx(tx, access, {
          action: "care.entry.after_exit",
          outcome: "denied",
          resourceType: "person",
          resourceId: p.id,
          reason: "occurred_after_status_change",
          scope: { reviewTaskId: taskId },
          requestId: c.get("requestId"),
        });
      });
    }
    throw error;
  }
}

/** Follow-ups that stay relevant whoever is left to act: the incident and safeguarding prompts. */
const SAFETY_TASKS = new Set(["incident_report", "safeguarding_decision_guide"]);

/**
 * The follow-ups an entry recorded after a status change still raises (people.md rule 3): before
 * a move to hospital or on leave, the urgent alert to the nurse in charge (the result may matter
 * to the hospital) and the safety prompts; after a discharge or death, the safety prompts only.
 * Point-of-care follow-ups (repeat observations, rescreens) are not raised for someone not here.
 */
export function triggersAfterChange(
  triggers: readonly CareTrigger[],
  recordedAfterExit: boolean,
  status: string,
): CareTrigger[] {
  if (!recordedAfterExit) return [...triggers];
  const away = status === "on_leave" || status === "in_hospital";
  return triggers.filter(
    (t) => (t.kind === "urgent_alert" && away) || (t.kind === "task" && SAFETY_TASKS.has(t.task)),
  );
}
