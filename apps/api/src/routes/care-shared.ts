import type { PersonRecordKind } from "@harbour/domain";
import { z } from "@hono/zod-openapi";
import type { TenantAccess } from "../http/context";
import { problems } from "../http/problem";

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
