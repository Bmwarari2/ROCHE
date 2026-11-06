/**
 * What the phone writes for the member's clock and lone working (scheduling.md section 18): each
 * with a client UUID made on the phone, queued in PowerSync's upload queue and sent when there is
 * a connection (`shift-upload.ts`), so a retry records once. Pure, so the rows are tested without
 * a device.
 */
import type { ClockKind } from "./clock-view";
import type { LoneWorkerEventKind } from "./lone-worker-view";
import { INSERT_CLOCK_EVENT_SQL, INSERT_LONE_WORKER_SQL } from "./queries";

export interface Statement {
  readonly sql: string;
  readonly params: (string | null)[];
}

export function clockStatement(input: {
  readonly id: string;
  readonly tenantId: string;
  readonly workerId: string;
  readonly kind: ClockKind;
  readonly shiftId: string | null;
  readonly locationId: string;
  readonly at: Date;
}): Statement {
  return {
    sql: INSERT_CLOCK_EVENT_SQL,
    params: [
      input.id,
      input.tenantId,
      input.workerId,
      input.kind,
      input.shiftId,
      input.locationId,
      input.at.toISOString(),
    ],
  };
}

export type LoneWorkKind = "domiciliary_visit" | "night_shift" | "other";

/** A session start: the outbox row's id is the session's own (`toShiftUpload` checks it). */
export function loneStartStatement(input: {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly locationId: string;
  readonly workKind: LoneWorkKind;
  readonly at: Date;
  readonly hours: number;
  readonly intervalMinutes: number;
}): Statement {
  const body = {
    id: input.sessionId,
    locationId: input.locationId,
    workKind: input.workKind,
    startedAt: input.at.toISOString(),
    plannedEndAt: new Date(input.at.getTime() + input.hours * 3_600_000).toISOString(),
    intervalMinutes: input.intervalMinutes,
  };
  return {
    sql: INSERT_LONE_WORKER_SQL,
    params: [
      input.sessionId,
      input.tenantId,
      "start",
      input.sessionId,
      JSON.stringify(body),
      input.at.toISOString(),
    ],
  };
}

/** Help with no session on the phone (H-1317): sent to the emergency route. */
export function loneEmergencyStatement(input: {
  readonly eventId: string;
  readonly tenantId: string;
  readonly at: Date;
}): Statement {
  const body = { id: input.eventId, kind: "help", deviceAt: input.at.toISOString() };
  return {
    sql: INSERT_LONE_WORKER_SQL,
    params: [
      input.eventId,
      input.tenantId,
      "emergency",
      input.eventId,
      JSON.stringify(body),
      input.at.toISOString(),
    ],
  };
}

/**
 * A lone-working event: the outbox row's id is the event's own. A duress press is written the
 * same way as a check-in, with only its kind different, and nothing else on the phone records it.
 */
export function loneEventStatement(input: {
  readonly eventId: string;
  readonly sessionId: string;
  readonly tenantId: string;
  readonly kind: LoneWorkerEventKind;
  readonly at: Date;
}): Statement {
  const body = { id: input.eventId, kind: input.kind, deviceAt: input.at.toISOString() };
  return {
    sql: INSERT_LONE_WORKER_SQL,
    params: [
      input.eventId,
      input.tenantId,
      "event",
      input.sessionId,
      JSON.stringify(body),
      input.at.toISOString(),
    ],
  };
}
