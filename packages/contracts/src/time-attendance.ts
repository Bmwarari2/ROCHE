import { z } from "zod";

/**
 * Time and attendance and working-time records (scheduling.md section 16; SCHED-004, SCHED-003;
 * hazards HZ-010, HZ-124, HZ-011). Clock evidence is never a position: only whether the phone was at
 * the location, or which of the location's NFC tags it read.
 */

const uuid = z.uuid();
const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });
const version = z.number().int().min(1);
const span = z.object({ start: isoDateTime, end: isoDateTime });
/** An NFC tag's reference: a short code, never a position. */
const tagRef = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export const ClockKind = z
  .enum(["in", "out", "break_start", "break_end"])
  .meta({ id: "ClockKind" });
export const ClockEvidence = z.enum(["none", "at_location", "nfc"]).meta({ id: "ClockEvidence" });
export const TimesheetKind = z
  .enum(["work", "sleep_in", "on_call_at_workplace", "on_call_away", "training", "travel"])
  .meta({ id: "TimesheetKind" });
export const TravelKind = z
  .enum([
    "between_assignments",
    "home_to_first_assignment",
    "last_assignment_to_home",
    "commute_to_fixed_workplace",
  ])
  .meta({ id: "TravelKind" });

export const RecordClockEvent = z
  .object({
    /** The client's UUID: a replay with the same id returns the stored event. */
    id: uuid,
    kind: ClockKind,
    locationId: uuid,
    /** The shift clocked for, if any. */
    shiftId: uuid.nullable().default(null),
    deviceTime: isoDateTime,
    /** The device's opaque id (letters, digits and . _ : -). */
    deviceId: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,120}$/)
      .nullable()
      .default(null),
    /** Kept only when the location's setting asks for it; otherwise stored as none, flagged. */
    evidence: ClockEvidence.default("none"),
    nfcTagRef: tagRef.nullable().default(null),
  })
  .meta({ id: "RecordClockEvent" });

export const ClockEventItem = z
  .object({
    id: uuid,
    workerId: uuid,
    kind: ClockKind,
    locationId: uuid,
    shiftId: uuid.nullable(),
    deviceTime: isoDateTime,
    recordedAt: isoDateTime,
    evidence: ClockEvidence,
    flags: z.array(z.string()),
    /** The draft timesheet entry a clock-out made, if any. */
    timesheetEntryId: uuid.nullable(),
  })
  .meta({ id: "ClockEventItem" });

export const ClockSettingItem = z
  .object({
    locationId: uuid,
    version: z.number().int().nullable(),
    evidence: ClockEvidence,
    nfcTagRefs: z.array(z.string()),
  })
  .meta({ id: "ClockSettingItem" });

export const ChangeClockSetting = z
  .object({
    version: z.number().int().nullable(),
    evidence: ClockEvidence,
    nfcTagRefs: z.array(tagRef).max(20).default([]),
    /** Turning location or NFC evidence on needs the employee-monitoring DPIA approved (H-527). */
    dpiaApproved: z.boolean().default(false),
  })
  .meta({ id: "ChangeClockSetting" });

export const TimesheetEntryItem = z
  .object({
    id: uuid,
    version,
    workerId: uuid,
    /** The worker's name, for those who may read the entry. */
    workerName: z.string().nullable(),
    locationId: uuid,
    shiftId: uuid.nullable(),
    kind: TimesheetKind,
    startedAt: isoDateTime,
    endedAt: isoDateTime,
    breaks: z.array(span),
    travel: TravelKind.nullable(),
    mileageTenths: z.number().int().nullable(),
    source: z.enum(["clock", "manual"]),
    status: z.enum(["draft", "approved"]),
    approvedBy: uuid.nullable(),
    approvedAt: isoDateTime.nullable(),
    supersedesId: uuid.nullable(),
    correctionReason: z.string().nullable(),
    /** Corrected by an approved entry: shown struck through, never counted. */
    superseded: z.boolean(),
    workedMinutes: z.number(),
    problems: z.array(z.string()),
    awakePeriods: z.array(span),
  })
  .meta({ id: "TimesheetEntryItem" });

export const TimesheetList = z
  .object({ items: z.array(TimesheetEntryItem) })
  .meta({ id: "TimesheetList" });

const EntryFields = {
  kind: TimesheetKind,
  startedAt: isoDateTime,
  endedAt: isoDateTime,
  breaks: z.array(span).max(10).default([]),
  travel: TravelKind.nullable().default(null),
  mileageTenths: z.number().int().min(0).max(100_000).nullable().default(null),
};

export const CreateTimesheetEntry = z
  .object({ workerId: uuid, shiftId: uuid.nullable().default(null), ...EntryFields })
  .meta({ id: "CreateTimesheetEntry" });

export const ChangeTimesheetEntry = z
  .object({ version, ...EntryFields })
  .meta({ id: "ChangeTimesheetEntry" });

export const CorrectTimesheetEntry = z
  .object({ reason: z.string().trim().min(3).max(500), ...EntryFields })
  .meta({ id: "CorrectTimesheetEntry" });

export const ApproveTimesheetEntry = z.object({ version }).meta({ id: "ApproveTimesheetEntry" });

export const ApprovedTimesheet = z
  .object({
    entry: TimesheetEntryItem,
    /** The working time check run on approval: advice, never a block. */
    workingTime: z.object({
      resultId: uuid,
      breaches: z.number().int(),
      conditionals: z.number().int(),
      notes: z.array(z.string()),
    }),
  })
  .meta({ id: "ApprovedTimesheet" });

export const RecordAwakePeriod = z
  .object({ start: isoDateTime, end: isoDateTime })
  .meta({ id: "RecordAwakePeriod" });

export const ClockExceptionList = z
  .object({
    events: z.array(ClockEventItem),
    drafts: z.array(TimesheetEntryItem),
  })
  .meta({ id: "ClockExceptionList" });

export const RecordOptOut = z
  .object({
    signedOn: isoDate,
    endsOn: isoDate.nullable().default(null),
    noticeAmount: z.number().int().min(0).max(365).nullable().default(null),
    noticeUnit: z.enum(["days", "months"]).nullable().default(null),
    noticeGivenOn: isoDate.nullable().default(null),
  })
  .meta({ id: "RecordOptOut" });

export const OptOutItem = z
  .object({
    id: uuid,
    version,
    workerId: uuid,
    signedOn: isoDate,
    endsOn: isoDate.nullable(),
    noticeAmount: z.number().int().nullable(),
    noticeUnit: z.enum(["days", "months"]).nullable(),
    noticeGivenOn: isoDate.nullable(),
    recordedBy: uuid,
  })
  .meta({ id: "OptOutItem" });

export const OptOutList = z.object({ items: z.array(OptOutItem) }).meta({ id: "OptOutList" });

export const WorkingTimeResultList = z
  .object({
    /** The member's name, only when there are results to show (null otherwise). */
    memberName: z.string().nullable(),
    items: z.array(
      z.object({
        id: uuid,
        evaluateFrom: isoDate,
        evaluateTo: isoDate,
        breaches: z.number().int(),
        conditionals: z.number().int(),
        findings: z.array(z.record(z.string(), z.unknown())),
        trigger: z.string(),
        createdAt: isoDateTime,
      }),
    ),
  })
  .meta({ id: "WorkingTimeResultList" });
