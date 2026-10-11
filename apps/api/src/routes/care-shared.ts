import type { CareTrigger, PersonRecordKind } from "@harbour/domain";
import { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { auditInTx } from "../http/audit";
import { type AppEnv, type TenantAccess, withTenant } from "../http/context";
import { problems } from "../http/problem";
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

export function permissionsOf(access: TenantAccess): ReadonlySet<string> {
  return new Set(access.effective.permissions);
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

/**
 * Runs a care write. A care event timed after the person left, died or went away (beyond the
 * clock tolerance) is refused, so the device keeps it to resolve, and one review task goes to the
 * nurse in charge in its own transaction, so it is not lost with the refusal (people.md rule 3;
 * HZ-006).
 */
export async function withLateEntryReview<T>(
  c: Context<AppEnv>,
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof CareEventAfterExit) {
      const access = c.get("access");
      await withTenant(c, async (tx) => {
        const p = await loadPerson(tx, error.personId);
        const taskId = await raiseLateEntryReview(tx, p, new Date());
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
