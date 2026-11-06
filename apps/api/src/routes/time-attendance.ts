import {
  ApprovedTimesheet,
  ApproveTimesheetEntry,
  ChangeClockSetting,
  ChangeTimesheetEntry,
  ClockEventItem,
  ClockExceptionList,
  ClockSettingItem,
  CorrectTimesheetEntry,
  CreateTimesheetEntry,
  OptOutItem,
  OptOutList,
  RecordAwakePeriod,
  RecordClockEvent,
  RecordOptOut,
  TimesheetEntryItem,
  TimesheetList,
  WorkingTimeResultList,
} from "@harbour/contracts";
import {
  clockEvent,
  clockSetting,
  shift,
  sleepInAwakePeriod,
  type Transaction,
  task,
  timesheetEntry,
  workingTimeOptOut,
  workingTimeResult,
} from "@harbour/db";
import {
  APPROVAL_MESSAGES,
  agencyUploadDecision,
  approvalProblem,
  type ClockFlag,
  can,
  clockFlags,
  clockInRefused,
  PAIRING_MESSAGES,
  pairClockEvents,
  ukEndOfDay,
  ukIsoDate,
  ukStartOfDay,
  withinBookedWindow,
  workedMinutes,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Context } from "hono";
import { writeAudit } from "../http/audit";
import {
  type AppEnv,
  requireAnyPermission,
  requirePermission,
  type TenantAccess,
  withTenant,
} from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { publish } from "../outbox";
import { currentBookedShiftEnd } from "../services/agency-window";
import { rateNumber } from "../services/rates";
import type { ShiftRow } from "../services/rota";
import { staffNames } from "../services/staff";
import { withSystemRights } from "../services/system-rights";
import {
  bookedShift,
  clockInProblems,
  exceptionFlags,
  formerShift,
  ownShift,
  raiseClockException,
  raiseRefusedClockIn,
  storeWorkingTimeResult,
  type TimesheetRow,
  timesheetFact,
} from "../services/time-attendance";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import { audit, requireLocationInScope } from "./people-shared";
import { change, stale, worksAt } from "./rota";

/**
 * Time and attendance and working-time records (scheduling.md section 16; SCHED-004, SCHED-003;
 * hazards HZ-010, HZ-124, HZ-011). A member clocks only for themselves; a bank or agency member's
 * late upload is accepted inside their booked window and flagged (ADR-0088). Clocking in applies
 * the rostering rule on the day. Timesheets are approved never by the worker and corrected by a
 * superseding entry. Location evidence is a word, never a position. Audit events carry ids only.
 */

const MANAGERS = ["scheduling.rota.approve", "scheduling.rota.manage"] as const;
const A = {
  recorded: "scheduling.clock.recorded",
  refused: "scheduling.clock.refused",
  created: "scheduling.timesheet.created",
  changed: "scheduling.timesheet.changed",
  approved: "scheduling.timesheet.approved",
  corrected: "scheduling.timesheet.corrected",
  result: "scheduling.working_time.result_stored",
  optOut: "scheduling.opt_out.recorded",
  optOutViewed: "scheduling.opt_out.viewed",
  setting: "scheduling.clock_setting.changed",
  awake: "scheduling.timesheet.awake_recorded",
} as const;

const IdParam = z.object({ id: z.uuid() });
const Range = z.object({ from: z.iso.date(), to: z.iso.date() });
const PAIRING: readonly string[] = Object.keys(PAIRING_MESSAGES);
/**
 * How far back a clock-out looks for its clock-in: the longest entry the database allows (25 hours,
 * a design limit, not a statutory figure; a longer live-in stretch is entered by hand).
 */
const PAIRING_LOOK_HOURS = 25;
const iso = (d: Date | null) => (d ? d.toISOString() : null);

function rangeOf(q: { from: string; to: string }) {
  if (q.to < q.from) throw problems.invalid("The last date must not be before the first.");
  if (Date.parse(q.to) - Date.parse(q.from) > 31 * 86_400_000) {
    throw problems.invalid("Ask for at most 32 days at a time.");
  }
  return { start: ukStartOfDay(q.from), end: ukEndOfDay(q.to) };
}

function eventItem(e: typeof clockEvent.$inferSelect, entryId: string | null = null) {
  return {
    id: e.id,
    workerId: e.workerId,
    kind: e.kind as z.infer<typeof ClockEventItem>["kind"],
    locationId: e.locationId,
    shiftId: e.shiftId,
    deviceTime: e.deviceTime.toISOString(),
    recordedAt: e.recordedAt.toISOString(),
    evidence: e.evidence as z.infer<typeof ClockEventItem>["evidence"],
    flags: e.flags,
    timesheetEntryId: entryId,
  };
}

async function entryItems(
  tx: Transaction,
  rows: readonly TimesheetRow[],
): Promise<z.infer<typeof TimesheetEntryItem>[]> {
  const ids = rows.map((r) => r.id);
  // Every entry of these workers that could supersede one of these.
  const correctors =
    ids.length === 0
      ? []
      : await tx
          .select({
            id: timesheetEntry.id,
            supersedesId: timesheetEntry.supersedesId,
            status: timesheetEntry.status,
          })
          .from(timesheetEntry)
          .where(inArray(timesheetEntry.supersedesId, ids));
  const superseded = new Set(
    correctors.filter((c) => c.status === "approved").map((c) => c.supersedesId as string),
  );
  const outIds = rows
    .flatMap((r) => [r.clockOutId, r.clockInId])
    .filter((v): v is string => v !== null);
  const outs =
    outIds.length === 0
      ? []
      : await tx
          .select({ id: clockEvent.id, flags: clockEvent.flags })
          .from(clockEvent)
          .where(inArray(clockEvent.id, outIds));
  const awake =
    ids.length === 0
      ? []
      : await tx
          .select()
          .from(sleepInAwakePeriod)
          .where(inArray(sleepInAwakePeriod.timesheetEntryId, ids));
  const names = await staffNames(
    tx,
    rows.map((r) => r.workerId),
  );
  return rows.map((r) => {
    const fact = timesheetFact(r);
    return {
      id: r.id,
      version: r.version,
      workerId: r.workerId,
      workerName: names(r.workerId)?.displayName ?? null,
      locationId: r.locationId,
      shiftId: r.shiftId,
      kind: fact.kind,
      startedAt: r.startedAt.toISOString(),
      endedAt: r.endedAt.toISOString(),
      breaks: fact.breaks.map((b) => ({ start: b.start.toISOString(), end: b.end.toISOString() })),
      travel: fact.travel,
      mileageTenths: r.mileageTenths,
      source: r.source as "clock" | "manual",
      status: fact.status,
      approvedBy: r.approvedBy,
      approvedAt: iso(r.approvedAt),
      supersedesId: r.supersedesId,
      correctionReason: r.correctionReason,
      superseded: superseded.has(r.id),
      workedMinutes: workedMinutes(fact),
      problems: [
        ...new Set(
          outs
            .filter((o) => o.id === r.clockOutId || o.id === r.clockInId)
            .flatMap((o) => o.flags)
            .filter((f) => PAIRING.includes(f)),
        ),
      ],
      awakePeriods: awake
        .filter((p) => p.timesheetEntryId === r.id)
        .map((p) => ({ start: p.startedAt.toISOString(), end: p.endedAt.toISOString() })),
    };
  });
}

function checkEntryFields(body: {
  kind: string;
  startedAt: string;
  endedAt: string;
  breaks: readonly { start: string; end: string }[];
  travel: string | null;
  mileageTenths: number | null;
}) {
  if (body.endedAt <= body.startedAt) throw problems.invalid("The entry ends before it starts.");
  if ((body.kind === "travel") !== (body.travel !== null)) {
    throw problems.invalid("A travel entry says which journey; no other entry does.");
  }
  if (body.mileageTenths !== null && body.kind !== "travel") {
    throw problems.invalid("Mileage is recorded on a travel entry.");
  }
  for (const b of body.breaks) {
    if (b.end <= b.start || b.start < body.startedAt || b.end > body.endedAt) {
      throw problems.invalid("Each break lies inside the entry and ends after it starts.");
    }
  }
}

async function loadEntry(tx: Transaction, id: string): Promise<TimesheetRow | null> {
  const [row] = await tx
    .select()
    .from(timesheetEntry)
    .where(and(eq(timesheetEntry.id, id), isNull(timesheetEntry.deletedAt)));
  return row ?? null;
}

async function isAgencyMember(tx: Transaction, memberId: string): Promise<boolean> {
  const rows = await withSystemRights(tx, () =>
    tx.execute<{ yes: boolean }>(sql`SELECT app.member_is_agency(${memberId}) AS yes`),
  );
  return rows.rows[0]?.yes === true;
}

const refusedClock = async (
  c: Context<AppEnv>,
  access: TenantAccess,
  reason: string,
  problem: HttpProblem,
) => {
  await writeAudit(c.get("services").appPool, access, {
    action: A.refused,
    outcome: "denied",
    resourceType: "clock_event",
    reason,
    requestId: c.get("requestId"),
  });
  return problem;
};

type ClockRow = typeof clockEvent.$inferSelect;

/** The stored event for a replayed id: the same event returns it; anything else is a conflict. */
async function replayOf(
  tx: Transaction,
  body: { id: string; kind: string },
  me: string,
  deviceTime: Date,
): Promise<{ replay: ReturnType<typeof eventItem> } | null> {
  const [existing] = await withSystemRights(tx, () =>
    tx.select().from(clockEvent).where(eq(clockEvent.id, body.id)),
  );
  if (!existing) return null;
  if (
    existing.workerId !== me ||
    existing.kind !== body.kind ||
    existing.deviceTime.getTime() !== deviceTime.getTime()
  ) {
    throw new HttpProblem(409, "clock_id_reused", "That event id was used for a different event.");
  }
  const [entry] = await withSystemRights(tx, () =>
    tx
      .select({ id: timesheetEntry.id })
      .from(timesheetEntry)
      .where(
        and(
          or(eq(timesheetEntry.clockOutId, existing.id), eq(timesheetEntry.clockInId, existing.id)),
          isNull(timesheetEntry.supersedesId),
        ),
      )
      .limit(1),
  );
  return { replay: eventItem(existing, entry?.id ?? null) };
}

/** The evidence kept: only what the location's setting asks for, an NFC tag only if listed. */
async function allowedEvidence(
  tx: Transaction,
  body: { locationId: string; evidence: string; nfcTagRef: string | null },
): Promise<{ evidence: "none" | "at_location" | "nfc"; nfcTagRef: string | null }> {
  if (body.evidence === "none") return { evidence: "none", nfcTagRef: null };
  const [setting] = await withSystemRights(tx, () =>
    tx.select().from(clockSetting).where(eq(clockSetting.locationId, body.locationId)),
  );
  if (!setting || setting.evidence !== body.evidence) return { evidence: "none", nfcTagRef: null };
  if (body.evidence === "nfc" && !setting.nfcTagRefs.includes(body.nfcTagRef ?? "")) {
    return { evidence: "none", nfcTagRef: null };
  }
  return { evidence: body.evidence as "at_location" | "nfc", nfcTagRef: body.nfcTagRef };
}

/** A clock event already in a live entry made from the clock. */
const inEntry = (column: typeof timesheetEntry.clockInId | typeof timesheetEntry.clockOutId) =>
  sql`EXISTS (SELECT 1 FROM public.timesheet_entry te WHERE te.tenant_id = ${clockEvent.tenantId}
    AND ${sql.raw(`te.${column.name}`)} = ${clockEvent.id} AND te.supersedes_id IS NULL
    AND te.deleted_at IS NULL)`;

type ClockFact = Pick<
  ClockRow,
  "id" | "kind" | "workerId" | "locationId" | "deviceTime" | "shiftId"
>;
interface PairPlan {
  readonly clockIn: ClockFact;
  readonly clockOut: ClockFact;
  readonly paired: ReturnType<typeof pairClockEvents>;
}

/**
 * Rule 4: pairs a clock-out with the member's latest unpaired clock-in at the location before it
 * (within the longest entry), or a clock-in with the next unpaired clock-out after it with no
 * other clock-in between, with the breaks between them. Run before the event is stored, so its
 * problems are kept on it; a clock-out with no clock-in is flagged.
 */
async function planPair(
  tx: Transaction,
  made: ClockFact,
): Promise<{ plan: PairPlan | null; problems: string[] }> {
  const none = { plan: null, problems: [] as string[] };
  if (made.kind !== "in" && made.kind !== "out") return none;
  const span = PAIRING_LOOK_HOURS * 3_600_000;
  const same = and(
    eq(clockEvent.workerId, made.workerId),
    eq(clockEvent.locationId, made.locationId),
  );
  let clockIn: ClockFact | undefined;
  let clockOut: ClockFact | undefined;
  if (made.kind === "out") {
    clockOut = made;
    [clockIn] = await withSystemRights(tx, () =>
      tx
        .select()
        .from(clockEvent)
        .where(
          and(
            same,
            eq(clockEvent.kind, "in"),
            lt(clockEvent.deviceTime, made.deviceTime),
            gt(clockEvent.deviceTime, new Date(made.deviceTime.getTime() - span)),
            sql`NOT ${inEntry(timesheetEntry.clockInId)}`,
          ),
        )
        .orderBy(desc(clockEvent.deviceTime))
        .limit(1),
    );
  } else {
    clockIn = made;
    [clockOut] = await withSystemRights(tx, () =>
      tx
        .select()
        .from(clockEvent)
        .where(
          and(
            same,
            eq(clockEvent.kind, "out"),
            gt(clockEvent.deviceTime, made.deviceTime),
            lt(clockEvent.deviceTime, new Date(made.deviceTime.getTime() + span)),
            sql`NOT ${inEntry(timesheetEntry.clockOutId)}`,
          ),
        )
        .orderBy(asc(clockEvent.deviceTime))
        .limit(1),
    );
    if (!clockOut) return none;
    const out = clockOut;
    const between = await withSystemRights(tx, () =>
      tx
        .select({ id: clockEvent.id })
        .from(clockEvent)
        .where(
          and(
            same,
            eq(clockEvent.kind, "in"),
            gt(clockEvent.deviceTime, made.deviceTime),
            lt(clockEvent.deviceTime, out.deviceTime),
          ),
        )
        .limit(1),
    );
    if (between.length > 0) return none;
  }
  const from = clockIn?.deviceTime;
  const breaks =
    from && clockOut
      ? await withSystemRights(tx, () =>
          tx
            .select()
            .from(clockEvent)
            .where(
              and(
                same,
                inArray(clockEvent.kind, ["break_start", "break_end"]),
                gt(clockEvent.deviceTime, from),
                lt(clockEvent.deviceTime, (clockOut as ClockFact).deviceTime),
              ),
            ),
        )
      : [];
  const paired = pairClockEvents([
    ...(clockIn ? [{ id: clockIn.id, kind: "in" as const, at: clockIn.deviceTime }] : []),
    ...breaks.map((e) => ({ id: e.id, kind: e.kind as "break_start", at: e.deviceTime })),
    ...(clockOut ? [{ id: clockOut.id, kind: "out" as const, at: clockOut.deviceTime }] : []),
  ]);
  if (!clockIn || !clockOut || !paired.start || !paired.end || paired.end <= paired.start) {
    return { plan: null, problems: [...paired.problems] };
  }
  return { plan: { clockIn, clockOut, paired }, problems: [...paired.problems] };
}

/** Drafts the entry a pairing found (rule 4); one per clock-in and clock-out. Returns its id. */
async function draftFrom(tx: Transaction, plan: PairPlan): Promise<string | null> {
  const { clockIn, clockOut, paired } = plan;
  const shiftId = clockIn.shiftId ?? clockOut.shiftId;
  const [s] = shiftId
    ? await withSystemRights(tx, () => tx.select().from(shift).where(eq(shift.id, shiftId)))
    : [];
  const [entry] = await withSystemRights(tx, () =>
    tx
      .insert(timesheetEntry)
      .values({
        workerId: clockIn.workerId,
        locationId: clockIn.locationId,
        shiftId: shiftId ?? null,
        kind: (s?.kind ?? "work") as "work",
        startedAt: paired.start as Date,
        endedAt: paired.end as Date,
        breaks: paired.breaks.map((b) => ({
          start: b.start.toISOString(),
          end: b.end.toISOString(),
        })),
        source: "clock",
        clockInId: clockIn.id,
        clockOutId: clockOut.id,
      })
      .onConflictDoNothing()
      .returning({ id: timesheetEntry.id }),
  );
  return entry?.id ?? null;
}

export const timeAttendanceRouter = createRouter()
  // ----------------------------------------------------------------------------------------
  // Clock events (rules 1 to 3)
  // ----------------------------------------------------------------------------------------
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/me/clock-events",
      tags: ["scheduling"],
      summary: "Clock in, out or a break",
      description:
        "Always for oneself. Keeps the device's and the server's time and flags a late upload or a device clock ahead (HZ-010). A staff member needs scheduling.timesheet.self; a bank or agency member a confirmed booking of the shift, and a late upload after their window closes is accepted inside the booked window, flagged, never dropped (ADR-0088). Clocking in to a shift applies the rostering rule on the day and, for bank and agency workers, needs an induction at the location: refused online (422), flagged with an urgent task when uploaded late. A clock-out makes a draft timesheet entry. Idempotent by the client's id.",
      security,
      request: { body: jsonBody(RecordClockEvent, "The event") },
      responses: {
        200: jsonBody(ClockEventItem, "Already recorded"),
        201: jsonBody(ClockEventItem, "Recorded"),
        ...errorResponses,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = c.get("access");
      const body = c.req.valid("json");
      const now = new Date();
      const deviceTime = new Date(body.deviceTime);
      if ((body.evidence === "nfc") !== (body.nfcTagRef !== null)) {
        throw problems.invalid("An NFC clock-in names the tag read; no other does.");
      }
      const me = access.tenantUserId;
      const result = await withTenant(c, async (tx) => {
        const refuse = async (reason: string, problem: HttpProblem) => ({
          refused: await refusedClock(c, access, reason, problem),
        });
        // Idempotent: a replay of the same id returns the stored event (rule 1).
        const replay = await replayOf(tx, body, me, deviceTime);
        if (replay) return replay;
        const tolerance = await rateNumber(tx, access.tenantId, "sync.clock_drift_flag_minutes");
        const flags = new Set<string>(clockFlags(deviceTime, now, tolerance));
        const late = flags.has("late_upload");
        const agency = await isAgencyMember(tx, me);
        const selfRecorder = can(access.effective, "scheduling.timesheet.self");
        let s: ShiftRow | null = null;
        if (agency) {
          // Rule 2 (ADR-0088): a bank or agency member clocks only for a booked shift, at a device
          // time inside its window; after the window closes the event is still accepted, flagged.
          if (!body.shiftId) {
            return refuse(
              "no_booking",
              new HttpProblem(422, "no_booking", "Clock in for the shift you are booked on."),
            );
          }
          s = await bookedShift(tx, me, body.shiftId);
          if (!s && late) {
            // Booked when worked, cancelled since: kept and flagged (rule 1).
            s = await formerShift(tx, me, body.shiftId);
            if (s) flags.add("no_booking");
          }
          const hours = await rateNumber(tx, access.tenantId, "access.agency.post_shift_hours");
          if (!s || !withinBookedWindow(deviceTime, { start: s.startsAt, end: s.endsAt }, hours)) {
            return refuse(
              "no_booking",
              new HttpProblem(
                422,
                "no_booking",
                "There is no booking of yours for this shift at that time.",
              ),
            );
          }
          // H-921 recommended answer: after the window closes, accepted only for the upload grace
          // period (access.agency.upload_grace_hours), then refused with a reason, audited.
          const grace = await rateNumber(tx, access.tenantId, "access.agency.upload_grace_hours");
          const decision = agencyUploadDecision(
            [{ start: s.startsAt, end: s.endsAt }],
            deviceTime,
            now,
            hours,
            grace,
          );
          if (!decision.accept) {
            return refuse(
              decision.reason,
              new HttpProblem(
                422,
                decision.reason,
                "This was recorded on a booked shift, but the time to upload it has passed. Tell the person in charge.",
              ),
            );
          }
          if (!(await currentBookedShiftEnd(tx, me, now, hours)))
            flags.add("outside_access_window");
        } else {
          if (!selfRecorder && !(late && body.shiftId)) {
            return refuse("missing_permission", problems.forbidden());
          }
          if (body.shiftId) {
            s = await ownShift(tx, me, body.shiftId);
            if (s && !selfRecorder) flags.add("no_permission");
            if (!s && late) {
              // On the shift when worked, removed since: kept and flagged (rule 1).
              s = await formerShift(tx, me, body.shiftId);
              if (s) flags.add(selfRecorder ? "not_on_shift" : "no_permission");
            }
            if (!s) {
              return refuse(
                "not_on_shift",
                new HttpProblem(422, "not_on_shift", "That is not a shift you are on."),
              );
            }
          } else {
            // Rule 3: a clock-in names its shift, so the checks can run; one recorded offline
            // without is kept, flagged and raised. Without a shift, only where the member works.
            if (body.kind === "in" && !late) {
              return refuse(
                "no_shift",
                new HttpProblem(422, "no_shift", "Clock in for a shift you are on."),
              );
            }
            if (!(await worksAt(tx, me, body.locationId))) {
              return refuse(
                "not_at_location",
                new HttpProblem(422, "not_at_location", "You do not work at that location."),
              );
            }
            flags.add("no_shift");
          }
        }
        if (s && s.locationId !== body.locationId) {
          if (!late) {
            return refuse(
              "other_location",
              new HttpProblem(422, "other_location", "The shift is at another location."),
            );
          }
          flags.add("other_location");
        }
        // Rule 3 (HZ-124): the rule on the day, refused while the shift has not ended whatever
        // the device's time; after it, kept, flagged and raised.
        if (s && body.kind === "in") {
          const found = await clockInProblems(tx, access.tenantId, s, me, agency, now);
          if (clockInRefused(found.length > 0, now, s.endsAt)) {
            await raiseRefusedClockIn(tx, s);
            const first = found[0] as string;
            return refuse(
              first,
              new HttpProblem(
                422,
                first,
                first === "no_induction"
                  ? "You need an induction at this location before you start. Ask the person in charge."
                  : "You cannot start this shift: a check you need is missing or has lapsed. Ask the person in charge.",
              ),
            );
          }
          for (const f of found) flags.add(f);
        }
        // Evidence only as the location's setting allows (H-527): anything else is not kept.
        const evidence = await allowedEvidence(tx, body);
        if (evidence.evidence !== body.evidence) flags.add("evidence_not_matched");
        const pairing = await planPair(tx, {
          id: body.id,
          kind: body.kind,
          workerId: me,
          locationId: body.locationId,
          deviceTime,
          shiftId: s?.id ?? null,
        });
        for (const p of pairing.problems) flags.add(p);
        const values = {
          id: body.id,
          workerId: me,
          kind: body.kind,
          shiftId: s?.id ?? null,
          locationId: body.locationId,
          deviceTime,
          recordedAt: now,
          deviceId: body.deviceId,
          evidence: evidence.evidence,
          nfcTagRef: evidence.nfcTagRef,
          flags: [...flags],
          createdBy: me,
        };
        // Written in the member's own name, so the database's self check applies; the system
        // writes only what that check would refuse (an agency upload, a lapsed permission).
        const insert = () => tx.insert(clockEvent).values(values).onConflictDoNothing().returning();
        const asSelf = !agency && selfRecorder;
        const [made] = asSelf ? await insert() : await withSystemRights(tx, insert);
        if (!made) {
          const again = await replayOf(tx, body, me, deviceTime);
          if (again) return again;
          throw new HttpProblem(
            409,
            "clock_id_reused",
            "That event id was used for a different event.",
          );
        }
        // Rule 4: a clock-out pairs with its open clock-in; a clock-in uploaded after its
        // clock-out pairs with it then.
        const entryId = pairing.plan ? await draftFrom(tx, pairing.plan) : null;
        const raised = exceptionFlags(flags, body.kind);
        if (raised.length > 0) await raiseClockException(tx, made, raised);
        await audit(c, tx, access, {
          action: A.recorded,
          resourceType: "clock_event",
          resourceId: made.id,
          scopeExtra: { kind: body.kind, flags: [...flags] as ClockFlag[] },
        });
        return { made: eventItem(made, entryId) };
      });
      if ("refused" in result) throw result.refused;
      if ("replay" in result) return c.json(result.replay, 200);
      return c.json(result.made, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/me/timesheets",
      tags: ["scheduling"],
      summary: "My timesheet entries",
      security,
      request: { query: Range },
      responses: { 200: jsonBody(TimesheetList, "Entries"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, "scheduling.timesheet.self");
      const range = rangeOf(c.req.valid("query"));
      const items = await withTenant(c, async (tx) => {
        const rows = await tx
          .select()
          .from(timesheetEntry)
          .where(
            and(
              eq(timesheetEntry.workerId, access.tenantUserId),
              isNull(timesheetEntry.deletedAt),
              gte(timesheetEntry.startedAt, range.start),
              lt(timesheetEntry.startedAt, range.end),
            ),
          )
          .orderBy(asc(timesheetEntry.startedAt));
        return entryItems(tx, rows);
      });
      return c.json({ items }, 200);
    },
  )
  // ----------------------------------------------------------------------------------------
  // Clock evidence at a location (H-527)
  // ----------------------------------------------------------------------------------------
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/locations/{id}/clock-setting",
      tags: ["scheduling"],
      summary: "Clock evidence at a location",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(ClockSettingItem, "The setting"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [
        "scheduling.rota.manage",
        "scheduling.rota.read",
        "scheduling.timesheet.self",
      ]);
      const { id } = c.req.valid("param");
      requireLocationInScope(access, id);
      const [row] = await withTenant(c, (tx) =>
        tx.select().from(clockSetting).where(eq(clockSetting.locationId, id)),
      );
      return c.json(
        {
          locationId: id,
          version: row?.version ?? null,
          evidence: (row?.evidence ?? "none") as "none",
          nfcTagRefs: row?.nfcTagRefs ?? [],
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/locations/{id}/clock-setting",
      tags: ["scheduling"],
      summary: "Set clock evidence at a location",
      description:
        "Location or NFC evidence is employee monitoring: it needs dpiaApproved, confirming the employee-monitoring DPIA is approved (H-527). Never a position: only whether the phone was at the location or read the location's tag.",
      security,
      request: { params: IdParam, body: jsonBody(ChangeClockSetting, "The setting") },
      responses: {
        200: jsonBody(ClockSettingItem, "Set"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "scheduling.rota.approve");
      const { id } = c.req.valid("param");
      requireLocationInScope(access, id);
      const body = c.req.valid("json");
      if (body.evidence !== "none" && !body.dpiaApproved) {
        throw problems.invalid(
          "Location and NFC evidence need the employee-monitoring DPIA approved first.",
        );
      }
      if ((body.evidence === "nfc") !== body.nfcTagRefs.length > 0) {
        throw problems.invalid("NFC evidence names the location's tags; no other does.");
      }
      const row = await change(
        c,
        access,
        { action: A.setting, resourceType: "location", id },
        async (tx) => {
          const [current] = await tx
            .select()
            .from(clockSetting)
            .where(eq(clockSetting.locationId, id));
          let saved: typeof clockSetting.$inferSelect | undefined;
          if (!current) {
            if (body.version !== null) throw stale();
            [saved] = await tx
              .insert(clockSetting)
              .values({ locationId: id, evidence: body.evidence, nfcTagRefs: body.nfcTagRefs })
              .returning();
          } else {
            [saved] = await tx
              .update(clockSetting)
              .set({ evidence: body.evidence, nfcTagRefs: body.nfcTagRefs })
              .where(
                and(eq(clockSetting.id, current.id), eq(clockSetting.version, body.version ?? -1)),
              )
              .returning();
            if (!saved) throw stale();
          }
          await audit(c, tx, access, {
            action: A.setting,
            resourceType: "location",
            resourceId: id,
            scopeExtra: { evidence: body.evidence, dpiaApproved: body.dpiaApproved },
          });
          return saved as typeof clockSetting.$inferSelect;
        },
      );
      return c.json(
        {
          locationId: id,
          version: row.version,
          evidence: row.evidence as "none",
          nfcTagRefs: row.nfcTagRefs,
        },
        200,
      );
    },
  )
  // ----------------------------------------------------------------------------------------
  // Timesheets (rules 4 to 6)
  // ----------------------------------------------------------------------------------------
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/locations/{id}/timesheets",
      tags: ["scheduling"],
      summary: "Timesheet entries at a location",
      security,
      request: { params: IdParam, query: Range },
      responses: {
        200: jsonBody(TimesheetList, "Entries"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, MANAGERS);
      const { id } = c.req.valid("param");
      requireLocationInScope(access, id);
      const range = rangeOf(c.req.valid("query"));
      const items = await withTenant(c, async (tx) => {
        const rows = await tx
          .select()
          .from(timesheetEntry)
          .where(
            and(
              eq(timesheetEntry.locationId, id),
              isNull(timesheetEntry.deletedAt),
              gte(timesheetEntry.startedAt, range.start),
              lt(timesheetEntry.startedAt, range.end),
            ),
          )
          .orderBy(asc(timesheetEntry.startedAt));
        return entryItems(tx, rows);
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/locations/{id}/timesheets",
      tags: ["scheduling"],
      summary: "Enter time by hand",
      description: "A draft for someone else, never oneself.",
      security,
      request: { params: IdParam, body: jsonBody(CreateTimesheetEntry, "The entry") },
      responses: {
        201: jsonBody(TimesheetEntryItem, "Made"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, MANAGERS);
      const { id } = c.req.valid("param");
      requireLocationInScope(access, id);
      const body = c.req.valid("json");
      checkEntryFields(body);
      if (body.workerId === access.tenantUserId) {
        throw new HttpProblem(403, "separation_of_duties", "Someone else must enter your time.");
      }
      const item = await change(
        c,
        access,
        { action: A.created, resourceType: "location", id },
        async (tx) => {
          const [made] = await tx
            .insert(timesheetEntry)
            .values({
              workerId: body.workerId,
              locationId: id,
              shiftId: body.shiftId,
              kind: body.kind,
              startedAt: new Date(body.startedAt),
              endedAt: new Date(body.endedAt),
              breaks: body.breaks,
              travel: body.travel,
              mileageTenths: body.mileageTenths,
              source: "manual",
            })
            .returning();
          if (!made) throw new Error("entry not stored");
          await audit(c, tx, access, {
            action: A.created,
            resourceType: "timesheet_entry",
            resourceId: made.id,
            scopeExtra: { workerId: body.workerId },
          });
          return (await entryItems(tx, [made]))[0];
        },
      );
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/v1/timesheet-entries/{id}",
      tags: ["scheduling"],
      summary: "Change a draft entry",
      description: "Never one's own; an approved entry is corrected instead.",
      security,
      request: { params: IdParam, body: jsonBody(ChangeTimesheetEntry, "Against version") },
      responses: {
        200: jsonBody(TimesheetEntryItem, "Changed"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, MANAGERS);
      const { id } = c.req.valid("param");
      const { version, ...body } = c.req.valid("json");
      checkEntryFields(body);
      const item = await change(
        c,
        access,
        { action: A.changed, resourceType: "timesheet_entry", id },
        async (tx) => {
          const row = await loadEntry(tx, id);
          if (!row) return null;
          requireLocationInScope(access, row.locationId);
          if (row.workerId === access.tenantUserId) {
            throw new HttpProblem(
              403,
              "separation_of_duties",
              "Someone else must change your time.",
            );
          }
          if (row.status !== "draft") {
            throw new HttpProblem(409, "invalid_state", APPROVAL_MESSAGES.not_draft);
          }
          const [done] = await tx
            .update(timesheetEntry)
            .set({
              kind: body.kind,
              startedAt: new Date(body.startedAt),
              endedAt: new Date(body.endedAt),
              breaks: body.breaks,
              travel: body.travel,
              mileageTenths: body.mileageTenths,
            })
            .where(and(eq(timesheetEntry.id, id), eq(timesheetEntry.version, version)))
            .returning();
          if (!done) throw stale();
          await audit(c, tx, access, {
            action: A.changed,
            resourceType: "timesheet_entry",
            resourceId: id,
          });
          return (await entryItems(tx, [done]))[0];
        },
      );
      if (!item) throw problems.notFound();
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/timesheet-entries/{id}/approve",
      tags: ["scheduling"],
      summary: "Approve an entry",
      description:
        "By a holder of scheduling.rota.approve at the location, never the worker. Runs the working time check for the worker and stores the result (advice; a breach or conditional finding raises a task, never blocks).",
      security,
      request: { params: IdParam, body: jsonBody(ApproveTimesheetEntry, "Against version") },
      responses: {
        200: jsonBody(ApprovedTimesheet, "Approved"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "scheduling.rota.approve");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const result = await change(
        c,
        access,
        { action: A.approved, resourceType: "timesheet_entry", id },
        async (tx) => {
          const row = await loadEntry(tx, id);
          if (!row) return null;
          requireLocationInScope(access, row.locationId);
          const correctors = await tx
            .select({ status: timesheetEntry.status })
            .from(timesheetEntry)
            .where(eq(timesheetEntry.supersedesId, id));
          const superseded = new Set(correctors.some((x) => x.status === "approved") ? [id] : []);
          const problem = approvalProblem(timesheetFact(row), access.tenantUserId, superseded, {
            now: new Date(),
            enteredBy: row.source === "manual" || row.supersedesId ? row.createdBy : null,
            changedBy: row.version > 1 ? row.updatedBy : null,
          });
          if (problem) {
            await audit(c, tx, access, {
              action: A.approved,
              outcome: "denied",
              resourceType: "timesheet_entry",
              resourceId: id,
              reason: problem,
            });
            return {
              refused: new HttpProblem(
                problem === "own_entry" || problem === "entered_by_approver" ? 403 : 409,
                problem === "own_entry" || problem === "entered_by_approver"
                  ? "separation_of_duties"
                  : problem,
                APPROVAL_MESSAGES[problem],
              ),
            };
          }
          const now = new Date();
          const [done] = await tx
            .update(timesheetEntry)
            .set({ status: "approved", approvedBy: access.tenantUserId, approvedAt: now })
            .where(and(eq(timesheetEntry.id, id), eq(timesheetEntry.version, body.version)))
            .returning();
          if (!done) throw stale();
          const wt = await storeWorkingTimeResult(tx, done, "timesheet_approved");
          if (wt.breaches + wt.conditionals > 0) {
            await raiseWorkingTimeTask(tx, done.locationId, done.workerId, wt.id);
            await publish(tx, {
              context: "scheduling",
              aggregateType: "working_time_result",
              aggregateId: wt.id,
              type: "scheduling.working_time.finding_raised",
              payload: { resultId: wt.id, workerId: done.workerId },
            });
          }
          await publish(tx, {
            context: "scheduling",
            aggregateType: "timesheet_entry",
            aggregateId: done.id,
            type: "scheduling.timesheet_approved",
            payload: { entryId: done.id, workerId: done.workerId, locationId: done.locationId },
          });
          await audit(c, tx, access, {
            action: A.approved,
            resourceType: "timesheet_entry",
            resourceId: id,
            scopeExtra: { resultId: wt.id },
          });
          await audit(c, tx, access, {
            action: A.result,
            resourceType: "working_time_result",
            resourceId: wt.id,
          });
          const [entry] = await entryItems(tx, [done]);
          return {
            item: {
              entry: entry as z.infer<typeof TimesheetEntryItem>,
              workingTime: {
                resultId: wt.id,
                breaches: wt.breaches,
                conditionals: wt.conditionals,
                notes: wt.notes,
              },
            },
          };
        },
      );
      if (!result) throw problems.notFound();
      if ("refused" in result) throw result.refused;
      return c.json(result.item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/timesheet-entries/{id}/corrections",
      tags: ["scheduling"],
      summary: "Correct an approved entry",
      description:
        "A new draft superseding it, with a reason; once approved, the original is struck through. One open correction at a time; never one's own.",
      security,
      request: { params: IdParam, body: jsonBody(CorrectTimesheetEntry, "The correction") },
      responses: {
        201: jsonBody(TimesheetEntryItem, "Made"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, MANAGERS);
      const { id } = c.req.valid("param");
      const { reason, ...body } = c.req.valid("json");
      checkEntryFields(body);
      const item = await change(
        c,
        access,
        { action: A.corrected, resourceType: "timesheet_entry", id },
        async (tx) => {
          const row = await loadEntry(tx, id);
          if (!row) return null;
          requireLocationInScope(access, row.locationId);
          if (row.workerId === access.tenantUserId) {
            throw new HttpProblem(
              403,
              "separation_of_duties",
              "Someone else must correct your time.",
            );
          }
          if (row.status !== "approved") {
            throw new HttpProblem(
              409,
              "invalid_state",
              "Only an approved entry is corrected; change a draft instead.",
            );
          }
          const [open] = await tx
            .select({ id: timesheetEntry.id })
            .from(timesheetEntry)
            .where(eq(timesheetEntry.supersedesId, id));
          if (open) {
            throw new HttpProblem(409, "invalid_state", "This entry already has a correction.");
          }
          const [made] = await tx
            .insert(timesheetEntry)
            .values({
              workerId: row.workerId,
              locationId: row.locationId,
              shiftId: row.shiftId,
              kind: body.kind,
              startedAt: new Date(body.startedAt),
              endedAt: new Date(body.endedAt),
              breaks: body.breaks,
              travel: body.travel,
              mileageTenths: body.mileageTenths,
              source: "manual",
              supersedesId: id,
              correctionReason: reason,
            })
            .returning();
          if (!made) throw new Error("correction not stored");
          await audit(c, tx, access, {
            action: A.corrected,
            resourceType: "timesheet_entry",
            resourceId: made.id,
            scopeExtra: { supersedesId: id },
          });
          return (await entryItems(tx, [made]))[0];
        },
      );
      if (!item) throw problems.notFound();
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/timesheet-entries/{id}/awake-periods",
      tags: ["scheduling"],
      summary: "Record a time awake on a sleep-in",
      description: "On a sleep-in draft, inside it; never one's own.",
      security,
      request: { params: IdParam, body: jsonBody(RecordAwakePeriod, "The period") },
      responses: {
        201: jsonBody(TimesheetEntryItem, "Recorded"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, MANAGERS);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const item = await change(
        c,
        access,
        { action: A.awake, resourceType: "timesheet_entry", id },
        async (tx) => {
          const row = await loadEntry(tx, id);
          if (!row) return null;
          requireLocationInScope(access, row.locationId);
          if (row.kind !== "sleep_in" || row.status !== "draft") {
            throw new HttpProblem(
              409,
              "invalid_state",
              "Awake periods go on a sleep-in that is still a draft.",
            );
          }
          const start = new Date(body.start);
          const end = new Date(body.end);
          if (end <= start || start < row.startedAt || end > row.endedAt) {
            throw problems.invalid("The period lies inside the sleep-in and ends after it starts.");
          }
          await tx
            .insert(sleepInAwakePeriod)
            .values({ timesheetEntryId: id, startedAt: start, endedAt: end });
          await audit(c, tx, access, {
            action: A.awake,
            resourceType: "timesheet_entry",
            resourceId: id,
          });
          return (await entryItems(tx, [row]))[0];
        },
      );
      if (!item) throw problems.notFound();
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/locations/{id}/clock-exceptions",
      tags: ["scheduling"],
      summary: "Clock exceptions at a location",
      description: "Flagged clock events, and drafts waiting for approval, between two UK dates.",
      security,
      request: { params: IdParam, query: Range },
      responses: {
        200: jsonBody(ClockExceptionList, "Exceptions"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, MANAGERS);
      const { id } = c.req.valid("param");
      requireLocationInScope(access, id);
      const range = rangeOf(c.req.valid("query"));
      const out = await withTenant(c, async (tx) => {
        const events = await tx
          .select()
          .from(clockEvent)
          .where(
            and(
              eq(clockEvent.locationId, id),
              gte(clockEvent.deviceTime, range.start),
              lt(clockEvent.deviceTime, range.end),
              sql`cardinality(${clockEvent.flags}) > 0`,
            ),
          )
          .orderBy(asc(clockEvent.deviceTime));
        const drafts = await tx
          .select()
          .from(timesheetEntry)
          .where(
            and(
              eq(timesheetEntry.locationId, id),
              eq(timesheetEntry.status, "draft"),
              isNull(timesheetEntry.deletedAt),
              gte(timesheetEntry.startedAt, range.start),
              lt(timesheetEntry.startedAt, range.end),
            ),
          )
          .orderBy(asc(timesheetEntry.startedAt));
        return { events: events.map((e) => eventItem(e)), drafts: await entryItems(tx, drafts) };
      });
      return c.json(out, 200);
    },
  )
  // ----------------------------------------------------------------------------------------
  // Opt-outs and results (rules 7 and 8)
  // ----------------------------------------------------------------------------------------
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/members/{id}/working-time-opt-outs",
      tags: ["scheduling"],
      summary: "A member's opt-outs on file",
      description: "The member's own, or an approver's view; audited.",
      security,
      request: { params: IdParam },
      responses: { 200: jsonBody(OptOutList, "Opt-outs"), ...errorResponses },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const access =
        id === c.get("access").tenantUserId
          ? await requirePermission(c, "scheduling.timesheet.self")
          : await requirePermission(c, "scheduling.rota.approve");
      const items = await withTenant(c, async (tx) => {
        const rows = await tx
          .select()
          .from(workingTimeOptOut)
          .where(and(eq(workingTimeOptOut.workerId, id), isNull(workingTimeOptOut.deletedAt)))
          .orderBy(desc(workingTimeOptOut.signedOn));
        await audit(c, tx, access, {
          action: A.optOutViewed,
          resourceType: "tenant_user",
          resourceId: id,
        });
        return rows.map(optOutItem);
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/members/{id}/working-time-opt-outs",
      tags: ["scheduling"],
      summary: "Record an opt-out from the signed agreement",
      description: "By a holder of scheduling.rota.approve, never the worker (reg 4(1), 5).",
      security,
      request: { params: IdParam, body: jsonBody(RecordOptOut, "The agreement") },
      responses: { 201: jsonBody(OptOutItem, "Recorded"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, "scheduling.rota.approve");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      if (id === access.tenantUserId) {
        throw new HttpProblem(
          403,
          "separation_of_duties",
          "Someone else must record your opt-out.",
        );
      }
      if (body.signedOn > ukIsoDate(new Date())) {
        throw problems.invalid("An opt-out is recorded once it is signed.");
      }
      const item = await change(
        c,
        access,
        { action: A.optOut, resourceType: "tenant_user", id },
        async (tx) => {
          const [made] = await tx
            .insert(workingTimeOptOut)
            .values({ workerId: id, recordedBy: access.tenantUserId, ...body })
            .returning();
          if (!made) throw new Error("opt-out not stored");
          await audit(c, tx, access, {
            action: A.optOut,
            resourceType: "working_time_opt_out",
            resourceId: made.id,
            scopeExtra: { workerId: id },
          });
          return optOutItem(made);
        },
      );
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/members/{id}/working-time",
      tags: ["scheduling"],
      summary: "A member's stored working time results",
      description: "Newest first; the member's own, or an approver's view.",
      security,
      request: { params: IdParam },
      responses: { 200: jsonBody(WorkingTimeResultList, "Results"), ...errorResponses },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      if (id === c.get("access").tenantUserId) {
        await requirePermission(c, "scheduling.timesheet.self");
      } else {
        await requirePermission(c, "scheduling.rota.approve");
      }
      const { rows, memberName } = await withTenant(c, async (tx) => {
        const found = await tx
          .select()
          .from(workingTimeResult)
          .where(eq(workingTimeResult.workerId, id))
          .orderBy(desc(workingTimeResult.createdAt))
          .limit(50);
        // The name only beside results the reader may already see (row-level security decides).
        const names = found.length > 0 ? await staffNames(tx, [id]) : () => null;
        return { rows: found, memberName: names(id)?.displayName ?? null };
      });
      return c.json(
        {
          memberName,
          items: rows.map((r) => ({
            id: r.id,
            evaluateFrom: r.evaluateFrom,
            evaluateTo: r.evaluateTo,
            breaches: r.breaches,
            conditionals: r.conditionals,
            findings: r.findings as Record<string, unknown>[],
            trigger: r.trigger,
            createdAt: r.createdAt.toISOString(),
          })),
        },
        200,
      );
    },
  );

function optOutItem(o: typeof workingTimeOptOut.$inferSelect): z.infer<typeof OptOutItem> {
  return {
    id: o.id,
    version: o.version,
    workerId: o.workerId,
    signedOn: o.signedOn,
    endsOn: o.endsOn,
    noticeAmount: o.noticeAmount,
    noticeUnit: o.noticeUnit as "days" | "months" | null,
    noticeGivenOn: o.noticeGivenOn,
    recordedBy: o.recordedBy,
  };
}

/** A task for the Registered Manager when a working time finding stands (rule 5; advice). */
async function raiseWorkingTimeTask(
  tx: Transaction,
  locationId: string,
  workerId: string,
  resultId: string,
) {
  await withSystemRights(tx, async () => {
    // At most one open per worker (HZ-008): the latest result is on the member's working time.
    const [open] = await tx
      .select({ id: task.id })
      .from(task)
      .innerJoin(workingTimeResult, eq(workingTimeResult.id, task.sourceId))
      .where(
        and(
          eq(task.kind, "scheduling.working_time_finding"),
          eq(task.status, "open"),
          eq(workingTimeResult.workerId, workerId),
        ),
      )
      .limit(1);
    if (open) return;
    await tx.insert(task).values({
      kind: "scheduling.working_time_finding",
      title: "Review a working time finding",
      requiredPermission: "scheduling.rota.approve",
      locationId,
      sourceType: "working_time_result",
      sourceId: resultId,
      assigneeRoleKey: WORKING_TIME_FINDING_ROLE,
      dueAt: new Date(),
      priority: "routine",
    });
  });
}

/** Who working time findings go to (the organisation may give the role to anyone). */
export const WORKING_TIME_FINDING_ROLE = "registered_manager";
