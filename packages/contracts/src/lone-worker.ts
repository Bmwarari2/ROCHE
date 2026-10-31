import { z } from "zod";

/**
 * Lone-worker safety (SCHED-012, Phase 2 slice 46; scheduling.md section 14; HZ-125). Enumerations
 * mirror packages/domain (`scheduling/lone-worker.ts`); the API tests keep them in step. The web
 * screens are slice 61 and the mobile app slice 71.
 */

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });
const version = z.number().int().min(1);

export const LoneWorkerEventKind = z
  .enum(["check_in", "duress", "help", "finish"])
  .meta({ id: "LoneWorkerEventKind" });
export const LoneWorkerAlarmReason = z
  .enum(["overdue", "not_finished", "duress", "help"])
  .meta({ id: "LoneWorkerAlarmReason" });
export const LoneWorkerAlarmState = z
  .enum(["open", "acknowledged", "resolved_by_check_in", "resolved_late_check_in"])
  .meta({ id: "LoneWorkerAlarmState" });
export const LoneWorkerOutcome = z
  .enum(["safe_confirmed", "help_sent", "emergency_services_called", "other"])
  .meta({ id: "LoneWorkerOutcome" });
export const LoneWorkerWorkKind = z
  .enum(["domiciliary_visit", "night_shift", "other"])
  .meta({ id: "LoneWorkerWorkKind" });
export const LoneWorkerSessionStatus = z
  .enum(["ok", "due", "alarm", "finished"])
  .meta({ id: "LoneWorkerSessionStatus" });

const Channel = z.enum(["in_app", "push", "email", "sms"]);

export const LoneWorkerRouteStep = z
  .object({
    afterMinutes: z.number().int().min(1).max(1440),
    targetRoleKey: z.string().trim().min(1).max(60).optional(),
    targetTenantUserId: uuid.optional(),
    channels: z.array(Channel).min(1).max(4),
  })
  .meta({ id: "LoneWorkerRouteStep" });

export const LoneWorkerRoute = z
  .object({
    /** True once a valid route is saved: until then no session can start (H-539). */
    on: z.boolean(),
    steps: z.array(LoneWorkerRouteStep),
    problems: z.array(z.object({ code: z.string(), message: z.string() })),
    /** Whether the organisation attaches location evidence to events (off by default; H-527). */
    locationEvidence: z.boolean(),
  })
  .meta({ id: "LoneWorkerRoute" });

export const SetLoneWorkerRoute = z
  .object({ steps: z.array(LoneWorkerRouteStep).min(1).max(6) })
  .meta({ id: "SetLoneWorkerRoute" });

export const StartLoneWorkerSession = z
  .object({
    /** The client's UUID, kept across retries: a second start with it returns the first. */
    id: uuid,
    locationId: uuid,
    workKind: LoneWorkerWorkKind,
    startedAt: isoDateTime,
    plannedEndAt: isoDateTime,
    intervalMinutes: z.number().int().min(1).max(1440),
  })
  .meta({ id: "StartLoneWorkerSession" });

export const LoneWorkerLocationPoint = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracyMetres: z.number().int().min(0).max(100000).nullable(),
  })
  .meta({ id: "LoneWorkerLocationPoint" });

export const RecordLoneWorkerEvent = z
  .object({
    /** The client's UUID: the same event sent twice (a retry, an offline queue) records once. */
    id: uuid,
    kind: LoneWorkerEventKind,
    /** When the worker made it, by the device's clock (it may arrive much later). */
    deviceAt: isoDateTime,
    /** Ignored unless the organisation's location flag is on; one point, never a track. */
    location: LoneWorkerLocationPoint.nullable().optional(),
  })
  .meta({ id: "RecordLoneWorkerEvent" });

/** What the worker's own screen shows: a duress check-in reads as an ordinary check-in. */
export const LoneWorkerOwnEvent = z
  .object({
    id: uuid,
    kind: LoneWorkerEventKind,
    deviceAt: isoDateTime,
    receivedAt: isoDateTime,
    late: z.boolean(),
  })
  .meta({ id: "LoneWorkerOwnEvent" });

export const LoneWorkerOwnSession = z
  .object({
    id: uuid,
    locationId: uuid,
    workKind: LoneWorkerWorkKind,
    startedAt: isoDateTime,
    plannedEndAt: isoDateTime,
    intervalMinutes: z.number().int(),
    finishedAt: isoDateTime.nullable(),
    status: LoneWorkerSessionStatus,
    nextDueAt: isoDateTime.nullable(),
    /** Overdue or unfinished only: a duress alarm is never shown to the worker. */
    overdueAlarmOpen: z.boolean(),
    events: z.array(LoneWorkerOwnEvent),
    version,
  })
  .meta({ id: "LoneWorkerOwnSession" });

export const LoneWorkerMine = z
  .object({ session: LoneWorkerOwnSession.nullable(), on: z.boolean() })
  .meta({ id: "LoneWorkerMine" });

export const LoneWorkerEventResult = z
  .object({
    id: uuid,
    /** As the worker's screen shows it (duress reads as check_in). */
    kind: LoneWorkerEventKind,
    effectiveAt: isoDateTime,
    late: z.boolean(),
    nextDueAt: isoDateTime.nullable(),
    /** Plain words for the worker: identical for a check-in and a duress check-in. */
    message: z.string(),
  })
  .meta({ id: "LoneWorkerEventResult" });

export const LoneWorkerBoardItem = z
  .object({
    sessionId: uuid,
    workerTenantUserId: uuid,
    locationId: uuid,
    workKind: LoneWorkerWorkKind,
    startedAt: isoDateTime,
    plannedEndAt: isoDateTime,
    intervalMinutes: z.number().int(),
    status: LoneWorkerSessionStatus,
    statusWords: z.string(),
    nextDueAt: isoDateTime.nullable(),
    lastCheckInAt: isoDateTime.nullable(),
    lastCheckInLate: z.boolean(),
    openAlarmIds: z.array(uuid),
  })
  .meta({ id: "LoneWorkerBoardItem" });

export const LoneWorkerBoard = z
  .object({ items: z.array(LoneWorkerBoardItem), on: z.boolean() })
  .meta({ id: "LoneWorkerBoard" });

export const LoneWorkerAlarmItem = z
  .object({
    id: uuid,
    sessionId: uuid,
    workerTenantUserId: uuid,
    locationId: uuid,
    reason: LoneWorkerAlarmReason,
    reasonWords: z.string(),
    state: LoneWorkerAlarmState,
    stateWords: z.string(),
    dueAt: isoDateTime.nullable(),
    raisedAt: isoDateTime,
    lastAlertedAt: isoDateTime,
    alertCount: z.number().int(),
    /** The latest check-in the server holds, by device time, and whether it came late. */
    lastCheckInAt: isoDateTime.nullable(),
    lastCheckInLate: z.boolean(),
    resolvedAt: isoDateTime.nullable(),
    acknowledgedBy: uuid.nullable(),
    acknowledgedAt: isoDateTime.nullable(),
    outcome: LoneWorkerOutcome.nullable(),
    note: z.string().nullable(),
    incidentId: uuid.nullable(),
    /** Evidence only, while not yet erased: the latest point attached to the session's events. */
    location: LoneWorkerLocationPoint.extend({ capturedAt: isoDateTime }).nullable(),
    version,
  })
  .meta({ id: "LoneWorkerAlarmItem" });

export const LoneWorkerAlarmList = z
  .object({ items: z.array(LoneWorkerAlarmItem) })
  .meta({ id: "LoneWorkerAlarmList" });

export const AcknowledgeLoneWorkerAlarm = z
  .object({
    outcome: LoneWorkerOutcome,
    note: z.string().trim().min(1).max(2000),
    incidentId: uuid.nullable().optional(),
    version,
  })
  .meta({ id: "AcknowledgeLoneWorkerAlarm" });

export const AcknowledgedLoneWorkerAlarm = z
  .object({
    alarm: LoneWorkerAlarmItem,
    /** Anything but safe confirmed: report an incident (and link it to the alarm). */
    incidentSuggested: z.boolean(),
  })
  .meta({ id: "AcknowledgedLoneWorkerAlarm" });

export type LoneWorkerEventKind = z.infer<typeof LoneWorkerEventKind>;
export type LoneWorkerAlarmReason = z.infer<typeof LoneWorkerAlarmReason>;
export type LoneWorkerAlarmState = z.infer<typeof LoneWorkerAlarmState>;
export type LoneWorkerOutcome = z.infer<typeof LoneWorkerOutcome>;
export type LoneWorkerWorkKind = z.infer<typeof LoneWorkerWorkKind>;
export type LoneWorkerSessionStatus = z.infer<typeof LoneWorkerSessionStatus>;
export type LoneWorkerRouteStep = z.infer<typeof LoneWorkerRouteStep>;
export type LoneWorkerRoute = z.infer<typeof LoneWorkerRoute>;
export type SetLoneWorkerRoute = z.infer<typeof SetLoneWorkerRoute>;
export type StartLoneWorkerSession = z.infer<typeof StartLoneWorkerSession>;
export type LoneWorkerLocationPoint = z.infer<typeof LoneWorkerLocationPoint>;
export type RecordLoneWorkerEvent = z.infer<typeof RecordLoneWorkerEvent>;
export type LoneWorkerOwnEvent = z.infer<typeof LoneWorkerOwnEvent>;
export type LoneWorkerOwnSession = z.infer<typeof LoneWorkerOwnSession>;
export type LoneWorkerMine = z.infer<typeof LoneWorkerMine>;
export type LoneWorkerEventResult = z.infer<typeof LoneWorkerEventResult>;
export type LoneWorkerBoardItem = z.infer<typeof LoneWorkerBoardItem>;
export type LoneWorkerBoard = z.infer<typeof LoneWorkerBoard>;
export type LoneWorkerAlarmItem = z.infer<typeof LoneWorkerAlarmItem>;
export type LoneWorkerAlarmList = z.infer<typeof LoneWorkerAlarmList>;
export type AcknowledgeLoneWorkerAlarm = z.infer<typeof AcknowledgeLoneWorkerAlarm>;
export type AcknowledgedLoneWorkerAlarm = z.infer<typeof AcknowledgedLoneWorkerAlarm>;
