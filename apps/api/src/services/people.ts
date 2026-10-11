import type { ExitDetails } from "@harbour/contracts";
import {
  aboutMeShareLink,
  bedOccupancy,
  carePlan,
  carePlanChange,
  dolsAuthorisation,
  exitChecklistItem,
  exitRecord,
  hospitalTransfer,
  keyIssue,
  location,
  notification,
  person,
  placement,
  preAdmissionAssessment,
  propertyItem,
  rateTable,
  reviewRecord,
  role,
  roleAssignment,
  room,
  sharingDecision,
  type Transaction,
  task,
  taskSeries,
  workflowInstance,
} from "@harbour/db";
import {
  type BedOccupancy,
  checkPersonRecordWrite,
  checkPersonStatusChange,
  EXIT_WORKFLOWS,
  type ExitContext,
  type ExitKind,
  exitChecklist,
  exitReturnDeadlines,
  type FamilyInvolvementKind,
  LIVE_PERSON_STATUSES,
  PEOPLE_RATE_KEYS,
  PERSON_LIFECYCLE,
  type PeopleRates,
  type PersonRecordKind,
  type PersonStatus,
  type PersonStatusChangeCheck,
  type PersonStatusProblem,
  type PlacementType,
  planBedRelease,
  type RateRow,
  type ReviewSchedule,
  type RoomView,
  resolvePeopleRates,
  returnFromHospitalChecks,
  roomLabelOn,
  scheduleReviews,
  ukDayBounds,
  ukIsoDate,
} from "@harbour/domain";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  or,
} from "drizzle-orm";
import { problems } from "../http/problem";
import { publish } from "../outbox";
import { bringPlanReviewForward } from "./care-planning";
import { bankHolidays, rateNumber } from "./rates";
import { withTenantWideScope } from "./safety";
import { materialiseSeries } from "./tasks";
import { moveWorkflow, startWorkflow, WorkflowMoveRefused } from "./workflow";

/**
 * The residential people lifecycle wired to the database (docs/specs/people.md sections 4 and 6;
 * slice 8). The rules are packages/domain's (`people/*`): this service gathers their inputs from
 * the record, refuses what they refuse, and carries out what a status change returns in the same
 * transaction: rounds, tasks, sharing, beds, the exit workflow and the outbox event.
 */

export type Nation = "england" | "wales" | "scotland" | "northern_ireland";

// ------------------------------------------------------------------------------------------------
// Rate-table figures
// ------------------------------------------------------------------------------------------------

async function rateRows(tx: Transaction, keys: readonly string[]): Promise<RateRow[]> {
  const rows = await tx
    .select()
    .from(rateTable)
    .where(inArray(rateTable.key, [...keys]));
  return rows.map((r) => ({
    key: r.key,
    value: r.value,
    unit: r.unit,
    nation: r.nation,
    validFrom: r.validFrom,
    validTo: r.validTo,
    tenantId: r.tenantId,
    verificationStatus: r.verificationStatus,
    source: r.source,
  }));
}

/**
 * Every people figure for a location's nation, or null when the nation has none yet (the review
 * figures are England rows until the Phase 7 nation packs, people.md section 11).
 */
export async function peopleRates(
  tx: Transaction,
  tenantId: string,
  nation: Nation,
  on: string,
): Promise<PeopleRates | null> {
  try {
    return resolvePeopleRates(
      await rateRows(tx, Object.values(PEOPLE_RATE_KEYS)),
      nation,
      on,
      tenantId,
    );
  } catch {
    return null;
  }
}

/** The return periods after an exit (nation `all` or `uk` rows, so every nation has them). */
export async function exitRates(tx: Transaction, tenantId: string, nation: Nation, on: string) {
  return {
    exitReturnDays: await rateNumber(tx, tenantId, PEOPLE_RATE_KEYS.exitReturnDays, nation, on),
    depositReturnDays: await rateNumber(
      tx,
      tenantId,
      PEOPLE_RATE_KEYS.depositReturnDays,
      nation,
      on,
    ),
  };
}

export const CLOCK_DRIFT_RATE_KEY = "sync.clock_drift_flag_minutes";

// ------------------------------------------------------------------------------------------------
// The person
// ------------------------------------------------------------------------------------------------

export type PersonRow = typeof person.$inferSelect;

export interface PersonRecord extends PersonRow {
  readonly nation: Nation;
  readonly regulator: string;
  readonly locationName: string;
  readonly locationPhone: string | null;
}

/** The person as the caller may see them (row-level security), or not found. */
export async function loadPerson(
  tx: Transaction,
  personId: string,
  forUpdate = false,
): Promise<PersonRecord> {
  const query = tx
    .select({
      person,
      nation: location.nation,
      regulator: location.regulator,
      locationName: location.name,
      locationPhone: location.phone,
    })
    .from(person)
    .innerJoin(location, eq(location.id, person.locationId))
    .where(and(eq(person.id, personId), isNull(person.deletedAt)));
  const [row] = forUpdate ? await query.for("update", { of: person }) : await query;
  if (!row) throw problems.notFound();
  return {
    ...row.person,
    nation: row.nation,
    regulator: row.regulator,
    locationName: row.locationName,
    locationPhone: row.locationPhone,
  };
}

/** 409 when the record changed since the caller loaded it. */
export function requireVersion(current: number, expected: number): void {
  if (current !== expected) throw problems.conflict();
}

/** When the person left or died (rule 3 compares event times with it). */
export function exitTime(p: PersonRow): Date {
  if (p.status === "deceased") return p.deceasedAt ?? p.statusChangedAt;
  if (p.status === "discharged") return p.dischargedAt ?? p.statusChangedAt;
  return p.statusChangedAt;
}

/**
 * What the person's status allows (people.md rules 1 and 3, care.md rule 12). Returns whether a
 * care event is being accepted after the person left or died.
 */
export function requireWrite(
  p: PersonRow,
  kind: PersonRecordKind,
  occurredAt: Date | null = null,
): { readonly recordedAfterExit: boolean } {
  const check = checkPersonRecordWrite(
    { status: p.status as PersonStatus, statusChangedAt: exitTime(p) },
    { kind, occurredAt },
  );
  if (!check.ok) throw problems.invalid(check.message);
  return { recordedAfterExit: check.recordedAfterStatusChange };
}

// ------------------------------------------------------------------------------------------------
// Status changes (rules 1 and 2)
// ------------------------------------------------------------------------------------------------

export interface Actor {
  readonly tenantId: string;
  readonly tenantUserId: string;
  readonly permissions: ReadonlySet<string>;
  readonly stepUpFresh: boolean;
}

export class PersonStatusRefused extends Error {
  constructor(
    readonly problem: PersonStatusProblem,
    message: string,
  ) {
    super(message);
    this.name = "PersonStatusRefused";
  }
}

export interface StatusChangeRequest {
  readonly to: PersonStatus;
  readonly effectiveAt: Date;
  readonly reason: string | null;
  readonly exitKind?: "discharge" | "transfer";
  readonly exit?: ExitDetails;
  /** For admission: `checkAdmissionReadiness` passed (admission route only). */
  readonly admissionReady?: boolean;
  readonly serviceId?: string;
  readonly placementTypeSought?: PlacementType;
}

export type StatusChangeOk = Extract<PersonStatusChangeCheck, { ok: true }>;

export interface StatusChangeOutcome {
  readonly person: PersonRow;
  readonly check: StatusChangeOk;
  readonly exitRecordId: string | null;
}

/** Effects the admission route carries out itself (it has the placement and the bed). */
const ADMISSION_EFFECTS = new Set([
  "open_placement_and_bed",
  "start_welcome_checklist",
  "schedule_first_care_plan",
]);

const EXIT_REASONS: Record<ExitKind, string> = {
  discharge: "The person left the service",
  transfer: "The person moved to another provider",
  death: "The person died",
};

/** Records the move on the workflow engine (PERSON_LIFECYCLE), resyncing an instance that lags. */
async function recordLifecycleMove(
  tx: Transaction,
  actor: Actor,
  p: PersonRow,
  req: StatusChangeRequest,
): Promise<void> {
  const subject = { subjectType: "person", subjectId: p.id, personId: p.id };
  const [instance] = await tx
    .select()
    .from(workflowInstance)
    .where(
      and(
        eq(workflowInstance.subjectType, "person"),
        eq(workflowInstance.subjectId, p.id),
        eq(workflowInstance.definitionKey, PERSON_LIFECYCLE.key),
      ),
    );
  if (!instance) {
    await tx.insert(workflowInstance).values({
      definitionKey: PERSON_LIFECYCLE.key,
      definitionVersion: PERSON_LIFECYCLE.version,
      subjectType: "person",
      subjectId: p.id,
      personId: p.id,
      state: p.status,
      enteredStateAt: p.statusChangedAt,
    });
  } else if (instance.state !== p.status) {
    // The status changed outside the API (a seed or an older app version): follow the record.
    await tx
      .update(workflowInstance)
      .set({ state: p.status, enteredStateAt: p.statusChangedAt })
      .where(eq(workflowInstance.id, instance.id));
  }
  await moveWorkflow(
    tx,
    actor.tenantId,
    PERSON_LIFECYCLE,
    subject,
    {
      to: req.to,
      actorTenantUserId: actor.tenantUserId,
      permissions: actor.permissions,
      reason: req.reason,
      stepUpFresh: actor.stepUpFresh,
    },
    req.effectiveAt,
  );
}

/**
 * Checks a status change with `checkPersonStatusChange` and carries out its effects in the
 * caller's transaction. Refusals throw `PersonStatusRefused` with the domain's words; nothing is
 * changed on refusal (the transaction rolls back).
 */
export async function applyStatusChange(
  tx: Transaction,
  actor: Actor,
  p: PersonRecord,
  req: StatusChangeRequest,
  now: Date,
): Promise<StatusChangeOutcome> {
  const from = p.status as PersonStatus;
  let exitWorkflowClosed: boolean | undefined;
  if (req.to === "archived" && (from === "discharged" || from === "deceased")) {
    const [latest] = await tx
      .select({ state: exitRecord.state })
      .from(exitRecord)
      .where(and(eq(exitRecord.personId, p.id), isNull(exitRecord.deletedAt)))
      .orderBy(desc(exitRecord.createdAt))
      .limit(1);
    exitWorkflowClosed = latest?.state === "closed";
  }
  const check = checkPersonStatusChange(
    {
      status: from,
      createdBy: p.createdBy ?? "",
      statusChangedAt: p.statusChangedAt,
      deceasedAt: p.deceasedAt,
    },
    {
      to: req.to,
      actorId: actor.tenantUserId,
      permissions: actor.permissions,
      reason: req.reason,
      stepUpFresh: actor.stepUpFresh,
      effectiveAt: req.effectiveAt,
      now,
      ...(req.exitKind ? { exitKind: req.exitKind } : {}),
      ...(req.admissionReady !== undefined ? { admissionReady: req.admissionReady } : {}),
      ...(exitWorkflowClosed !== undefined ? { exitWorkflowClosed } : {}),
      futureToleranceMinutes: await rateNumber(tx, actor.tenantId, CLOCK_DRIFT_RATE_KEY),
    },
  );
  if (!check.ok) throw new PersonStatusRefused(check.problem, check.message);
  if (check.exitKind === "death" && req.exit?.deathExpected === undefined) {
    throw problems.invalid("Say whether the death was expected.");
  }

  await recordLifecycleMove(tx, actor, p, req);
  const [updated] = await tx
    .update(person)
    .set({
      status: req.to,
      statusChangedAt: req.effectiveAt,
      ...(req.to === "discharged" ? { dischargedAt: req.effectiveAt } : {}),
      ...(req.to === "deceased" ? { deceasedAt: req.effectiveAt } : {}),
      ...(check.correction && from === "discharged" ? { dischargedAt: null } : {}),
      ...(check.correction && from === "deceased" ? { deceasedAt: null } : {}),
    })
    .where(and(eq(person.id, p.id), eq(person.version, p.version)))
    .returning();
  if (!updated) throw problems.conflict();

  const exitDate = ukIsoDate(req.effectiveAt);
  let exitRecordId: string | null = null;
  let roomLabel: string | null | undefined;
  for (const effect of check.effects) {
    if (ADMISSION_EFFECTS.has(effect)) continue;
    switch (effect) {
      case "start_pre_admission_assessment":
        await ensureAssessment(tx, p.id, req);
        break;
      case "pause_rounds":
        await pauseRounds(tx, p.id, req.effectiveAt);
        break;
      case "resume_rounds":
        await resumeRounds(tx, p.id, now);
        break;
      case "cancel_future_tasks":
        await cancelFutureTasks(
          tx,
          p.id,
          req.effectiveAt,
          EXIT_REASONS[check.exitKind ?? "discharge"],
        );
        break;
      case "close_sharing":
        await closeSharing(tx, p.id, req.effectiveAt, EXIT_REASONS[check.exitKind ?? "discharge"]);
        break;
      case "release_bed":
        if (await releaseBed(tx, p.id, exitDate, EXIT_REASONS[check.exitKind ?? "discharge"])) {
          roomLabel = null;
        }
        break;
      case "hold_room_for_clearance":
        await holdRoom(tx, p.id);
        break;
      case "start_exit_workflow":
        exitRecordId = await startExit(tx, actor, p, check.exitKind ?? "discharge", req, now);
        break;
      case "cancel_exit_workflow":
        exitRecordId = await cancelExit(tx, actor, p.id, req.reason ?? "Recorded in error", now);
        break;
      case "reopen_record":
        roomLabel = await reopenRecord(tx, p, from, now);
        break;
      case "start_return_from_hospital_checks":
        await recordHospitalReturn(tx, p, req.effectiveAt);
        break;
      case "raise_care_plan_review_on_change":
        await raiseReviewOnReturn(tx, p, req.effectiveAt, now);
        break;
      default:
        // offer_hospital_transfer_pack, start_retention_clock and close_enquiry need no write here:
        // the screen offers the pack, the retention clock reads the exit times, and the enquiry
        // is closed by the status itself.
        break;
    }
  }
  let current = updated;
  if (roomLabel !== undefined && roomLabel !== updated.roomLabel) {
    const [labelled] = await tx
      .update(person)
      .set({ roomLabel })
      .where(eq(person.id, p.id))
      .returning();
    if (labelled) current = labelled;
  }

  await publish(tx, {
    context: "people",
    aggregateType: "person",
    aggregateId: p.id,
    type: check.event,
    payload: {
      personId: p.id,
      locationId: p.locationId,
      from,
      to: req.to,
      effectiveAt: req.effectiveAt.toISOString(),
      exitKind: check.exitKind,
      exitRecordId,
      correction: check.correction,
      careEndedAt:
        check.event === "people.person.archived"
          ? (p.deceasedAt ?? p.dischargedAt ?? p.statusChangedAt).toISOString()
          : null,
    },
  });
  return { person: current, check, exitRecordId };
}

// ------------------------------------------------------------------------------------------------
// Effects
// ------------------------------------------------------------------------------------------------

/** Starts the pre-admission assessment, or keeps the open one (a re-referral continues it). */
async function ensureAssessment(tx: Transaction, personId: string, req: StatusChangeRequest) {
  const [open] = await tx
    .select({ id: preAdmissionAssessment.id })
    .from(preAdmissionAssessment)
    .where(
      and(
        eq(preAdmissionAssessment.personId, personId),
        notInArray(preAdmissionAssessment.status, ["decided"]),
        isNull(preAdmissionAssessment.deletedAt),
      ),
    );
  if (open) return open.id;
  const [created] = await tx
    .insert(preAdmissionAssessment)
    .values({
      personId,
      serviceId: req.serviceId ?? null,
      placementTypeSought: req.placementTypeSought ?? null,
    })
    .returning({ id: preAdmissionAssessment.id });
  return created?.id ?? null;
}

/** Rounds wait while the person is away; tasks cancelled here are reopened on return. */
export const PAUSED_ROUNDS_REASON = "Paused while the person is away";

async function pauseRounds(tx: Transaction, personId: string, from: Date) {
  await tx
    .update(task)
    .set({ status: "cancelled", statusReason: PAUSED_ROUNDS_REASON })
    .where(
      and(
        eq(task.personId, personId),
        isNotNull(task.seriesId),
        eq(task.status, "open"),
        gte(task.dueAt, from),
        isNull(task.deletedAt),
      ),
    );
}

async function resumeRounds(tx: Transaction, personId: string, now: Date) {
  await tx
    .update(task)
    .set({ status: "open", statusReason: null })
    .where(
      and(
        eq(task.personId, personId),
        eq(task.status, "cancelled"),
        eq(task.statusReason, PAUSED_ROUNDS_REASON),
        gte(task.dueAt, now),
      ),
    );
  const series = await tx
    .select()
    .from(taskSeries)
    .where(
      and(
        eq(taskSeries.personId, personId),
        eq(taskSeries.active, true),
        isNull(taskSeries.deletedAt),
      ),
    );
  for (const s of series) await materialiseSeries(tx, s, now);
}

/**
 * After a discharge or death: tasks due after the exit are cancelled and the person's recurring
 * tasks end. Tasks due before stay open, so an entry recorded offline before the exit can still
 * complete its task when it uploads (HZ-006).
 */
async function cancelFutureTasks(tx: Transaction, personId: string, at: Date, reason: string) {
  await tx
    .update(task)
    .set({ status: "cancelled", statusReason: reason })
    .where(
      and(
        eq(task.personId, personId),
        inArray(task.status, ["open", "in_progress"]),
        gt(task.dueAt, at),
        isNull(task.deletedAt),
      ),
    );
  await tx
    .update(taskSeries)
    .set({ active: false, endsOn: ukIsoDate(at) })
    .where(and(eq(taskSeries.personId, personId), eq(taskSeries.active, true)));
}

/**
 * Sharing closes when the person leaves or dies (rule 13, HZ-022): every decision in force is
 * withdrawn and every share link revoked. A manager reinstates sharing with new decisions.
 */
export async function closeSharing(tx: Transaction, personId: string, at: Date, reason: string) {
  const closed = await tx
    .update(sharingDecision)
    .set({ withdrawnAt: at, withdrawnReason: `Sharing closed: ${reason.toLowerCase()}` })
    .where(
      and(
        eq(sharingDecision.personId, personId),
        isNull(sharingDecision.withdrawnAt),
        gt(sharingDecision.validTo, at),
        isNull(sharingDecision.deletedAt),
      ),
    )
    .returning({ id: sharingDecision.id });
  await tx
    .update(aboutMeShareLink)
    .set({ revokedAt: at, revokedReason: `Sharing closed: ${reason.toLowerCase()}` })
    .where(and(eq(aboutMeShareLink.personId, personId), isNull(aboutMeShareLink.revokedAt)));
  if (closed.length > 0) {
    await publish(tx, {
      context: "people",
      aggregateType: "person",
      aggregateId: personId,
      type: "people.sharing.changed",
      payload: { personId, reason: "closed_at_exit", decisions: closed.length },
    });
  }
}

/** The person's bed history as the occupancy rules read it (tenant-wide: every occupant counts). */
export async function occupancyRows(
  tx: Transaction,
  filter: { personId?: string; roomIds?: readonly string[] },
) {
  return withTenantWideScope(tx, () =>
    tx
      .select()
      .from(bedOccupancy)
      .where(
        and(
          isNull(bedOccupancy.deletedAt),
          filter.personId ? eq(bedOccupancy.personId, filter.personId) : undefined,
          filter.roomIds
            ? inArray(bedOccupancy.roomId, filter.roomIds.length > 0 ? [...filter.roomIds] : [""])
            : undefined,
        ),
      )
      .orderBy(asc(bedOccupancy.fromDate)),
  );
}

export function toPeriod(row: typeof bedOccupancy.$inferSelect): BedOccupancy {
  return {
    id: row.id,
    personId: row.personId,
    roomId: row.roomId,
    bed: row.bed,
    from: row.fromDate,
    to: row.toDate,
  };
}

export function toRoomView(row: typeof room.$inferSelect): RoomView {
  return {
    id: row.id,
    label: row.label,
    beds: row.beds,
    status: row.status as RoomView["status"],
  };
}

/** Ends the person's open bed period on the exit day and the placement with it. */
async function releaseBed(tx: Transaction, personId: string, on: string, reason: string) {
  const periods = (await occupancyRows(tx, { personId })).map(toPeriod);
  const release = planBedRelease(periods, personId, on);
  if (release) {
    await tx
      .update(bedOccupancy)
      .set({ toDate: release.to })
      .where(eq(bedOccupancy.id, release.periodId));
  }
  await tx
    .update(placement)
    .set({ endDate: on, endReason: reason })
    .where(
      and(eq(placement.personId, personId), isNull(placement.endDate), isNull(placement.deletedAt)),
    );
  return release !== null;
}

/** After a death the room is held until it is cleared (rule 6). */
async function holdRoom(tx: Transaction, personId: string) {
  const [current] = (await occupancyRows(tx, { personId })).filter((r) => r.toDate === null);
  if (!current) return;
  await tx.update(room).set({ status: "awaiting_clearance" }).where(eq(room.id, current.roomId));
}

/**
 * A discharge or death corrected as recorded in error: the bed is re-checked before the person is
 * shown in it again (people.md section 4, rule 2). Returns the header's room label, or undefined
 * when it does not change.
 */
async function reopenRecord(
  tx: Transaction,
  p: PersonRecord,
  from: PersonStatus,
  now: Date,
): Promise<string | null | undefined> {
  const today = ukIsoDate(now);
  const periods = await occupancyRows(tx, { personId: p.id });
  const latest = periods.at(-1);
  if (from === "deceased") {
    if (latest && latest.toDate === null) {
      await tx
        .update(room)
        .set({ status: "available" })
        .where(and(eq(room.id, latest.roomId), eq(room.status, "awaiting_clearance")));
    }
    return undefined;
  }
  const exitDate = p.dischargedAt ? ukIsoDate(p.dischargedAt) : null;
  await tx
    .update(placement)
    .set({ endDate: null, endReason: null })
    .where(
      and(
        eq(placement.personId, p.id),
        exitDate ? eq(placement.endDate, exitDate) : undefined,
        isNull(placement.deletedAt),
      ),
    );
  if (!latest || latest.toDate === null) return undefined;
  const others = (await occupancyRows(tx, { roomIds: [latest.roomId] })).filter(
    (r) =>
      r.id !== latest.id &&
      r.bed === latest.bed &&
      (r.toDate === null || r.toDate > (latest.toDate ?? today)),
  );
  if (others.length > 0) return null;
  await tx.update(bedOccupancy).set({ toDate: null }).where(eq(bedOccupancy.id, latest.id));
  const rooms = await tx.select().from(room).where(eq(room.id, latest.roomId));
  return roomLabelOn([{ ...toPeriod(latest), to: null }], rooms.map(toRoomView), p.id, today);
}

// ------------------------------------------------------------------------------------------------
// Exits (rules 11 and 12)
// ------------------------------------------------------------------------------------------------

const EXIT_REGULATORS = ["cqc", "ciw", "care_inspectorate", "rqia"] as const;

/** Whether a DoLS authorisation is in force for the person now (the exit tells the body, HZ-020). */
async function dolsInForce(tx: Transaction, personId: string, now: Date): Promise<boolean> {
  const rows = await tx
    .select({ grantedTo: dolsAuthorisation.grantedTo })
    .from(dolsAuthorisation)
    .where(
      and(
        eq(dolsAuthorisation.personId, personId),
        eq(dolsAuthorisation.outcome, "granted"),
        isNull(dolsAuthorisation.endedAt),
        isNull(dolsAuthorisation.deletedAt),
      ),
    );
  return rows.some((r) => r.grantedTo === null || r.grantedTo.getTime() > now.getTime());
}

/** The `ExitContext` from the record and the flags the record cannot tell. */
export async function exitContextFor(
  tx: Transaction,
  p: PersonRecord,
  kind: ExitKind,
  details: ExitDetails | undefined,
  now: Date,
): Promise<ExitContext> {
  const regulator = EXIT_REGULATORS.find((r) => r === p.regulator);
  if (!regulator) {
    throw problems.invalid("Exit checklists are not available for this regulator yet.");
  }
  const [current] = await tx
    .select()
    .from(placement)
    .where(and(eq(placement.personId, p.id), isNull(placement.deletedAt)))
    .orderBy(desc(placement.startDate))
    .limit(1);
  return {
    kind,
    regulator,
    funding: {
      localAuthority: current?.localAuthorityFunded ?? false,
      nhs: current?.nhsFunded ?? false,
    },
    ...(kind === "death"
      ? {
          placeOfDeath:
            details?.placeOfDeath ?? (p.status === "in_hospital" ? "hospital" : "care_home"),
          ...(details?.deathExpected !== undefined ? { deathExpected: details.deathExpected } : {}),
        }
      : {}),
    learningDisabilityOrAutism: details?.learningDisabilityOrAutism ?? false,
    dolsInPlace: await dolsInForce(tx, p.id, now),
    homeIsDwpAppointee: details?.homeIsDwpAppointee ?? false,
    holdsResidentsMoney: details?.holdsResidentsMoney ?? false,
    holdsDeposit: details?.holdsDeposit ?? false,
    hasLoanEquipment: details?.hasLoanEquipment ?? false,
  };
}

function exitColumns(context: ExitContext, details: ExitDetails | undefined) {
  return {
    regulator: context.regulator,
    localAuthorityFunded: context.funding.localAuthority,
    nhsFunded: context.funding.nhs,
    placeOfDeath: context.kind === "death" ? (context.placeOfDeath ?? "care_home") : null,
    deathExpected: context.kind === "death" ? (context.deathExpected ?? null) : null,
    learningDisabilityOrAutism: context.learningDisabilityOrAutism,
    dolsInPlace: context.dolsInPlace,
    homeIsDwpAppointee: context.homeIsDwpAppointee,
    holdsResidentsMoney: context.holdsResidentsMoney,
    holdsDeposit: context.holdsDeposit,
    hasLoanEquipment: context.hasLoanEquipment,
    destinationType: details?.destinationType ?? null,
    receivingProviderName: details?.receivingProviderName ?? null,
    receivingProviderCqcLocationId: details?.receivingProviderCqcLocationId ?? null,
    receivingProviderOdsCode: details?.receivingProviderOdsCode ?? null,
    reason: details?.reason ?? null,
    verifiedByName: details?.verifiedByName ?? null,
    verifiedByRole: details?.verifiedByRole ?? null,
    verifiedAt: details?.verifiedAt ? new Date(details.verifiedAt) : null,
    presentAtDeath: details?.presentAtDeath ?? null,
    funeralDirector: details?.funeralDirector ?? null,
    collectionAt: details?.collectionAt ? new Date(details.collectionAt) : null,
    coronerReferredBy: details?.coronerReferredBy ?? null,
    coronerReference: details?.coronerReference ?? null,
  };
}

/** The exit record a stored row describes, as `ExitContext`. */
export function contextOfExit(row: typeof exitRecord.$inferSelect): ExitContext {
  return {
    kind: row.kind as ExitKind,
    regulator: row.regulator as ExitContext["regulator"],
    funding: { localAuthority: row.localAuthorityFunded, nhs: row.nhsFunded },
    ...(row.kind === "death"
      ? {
          placeOfDeath: (row.placeOfDeath ?? "care_home") as NonNullable<
            ExitContext["placeOfDeath"]
          >,
          ...(row.deathExpected !== null ? { deathExpected: row.deathExpected } : {}),
        }
      : {}),
    learningDisabilityOrAutism: row.learningDisabilityOrAutism,
    dolsInPlace: row.dolsInPlace,
    homeIsDwpAppointee: row.homeIsDwpAppointee,
    holdsResidentsMoney: row.holdsResidentsMoney,
    holdsDeposit: row.holdsDeposit,
    hasLoanEquipment: row.hasLoanEquipment,
  };
}

/** A planned discharge or transfer is put on its exit workflow before the person leaves. */
export async function planExit(
  tx: Transaction,
  actor: Actor,
  p: PersonRecord,
  kind: "discharge" | "transfer",
  details: ExitDetails,
  now: Date,
) {
  const context = await exitContextFor(tx, p, kind, details, now);
  const [row] = await tx
    .insert(exitRecord)
    .values({
      personId: p.id,
      locationId: p.locationId,
      kind,
      state: "planned",
      ...exitColumns(context, details),
    })
    .returning()
    .catch((error: unknown) => {
      const code =
        (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
      if (code === "23505") throw problems.invalid("This person already has an exit in progress.");
      throw error;
    });
  if (!row) throw problems.conflict();
  const instance = await startWorkflow(
    tx,
    actor.tenantId,
    EXIT_WORKFLOWS[kind],
    { subjectType: "exit_record", subjectId: row.id, personId: p.id },
    now,
  );
  await tx
    .update(exitRecord)
    .set({ workflowInstanceId: instance.id })
    .where(eq(exitRecord.id, row.id));
  await writeChecklist(tx, p.id, row.id, context);
  return row.id;
}

async function writeChecklist(
  tx: Transaction,
  personId: string,
  exitRecordId: string,
  context: ExitContext,
) {
  const items = exitChecklist(context);
  for (const [position, item] of items.entries()) {
    await tx
      .insert(exitChecklistItem)
      .values({
        personId,
        exitRecordId,
        itemKey: item.key,
        title: item.title,
        owner: item.owner,
        returnItem: item.returnItem,
        allowNotRequired: item.allowNotRequired,
        position,
      })
      .onConflictDoNothing();
  }
}

/** Moves an exit workflow as the system, for a planned discharge overtaken by a death. */
async function cancelPlannedAsSuperseded(tx: Transaction, row: typeof exitRecord.$inferSelect) {
  const reason = "The person died before the planned discharge";
  if (row.workflowInstanceId) {
    await tx
      .update(workflowInstance)
      .set({ state: "cancelled", enteredStateAt: new Date(), slaDueAt: null })
      .where(eq(workflowInstance.id, row.workflowInstanceId));
  }
  await tx
    .update(exitRecord)
    .set({ state: "cancelled", cancelledReason: reason })
    .where(eq(exitRecord.id, row.id));
}

/**
 * Starts the discharge, transfer or death workflow when the person leaves or dies: the record
 * with its `ExitContext`, the checklist, the return deadlines and one task for the manager.
 */
async function startExit(
  tx: Transaction,
  actor: Actor,
  p: PersonRecord,
  kind: ExitKind,
  req: StatusChangeRequest,
  now: Date,
): Promise<string> {
  const leftAt = req.effectiveAt;
  const [planned] = await tx
    .select()
    .from(exitRecord)
    .where(
      and(
        eq(exitRecord.personId, p.id),
        eq(exitRecord.state, "planned"),
        isNull(exitRecord.deletedAt),
      ),
    );
  if (planned && (kind === "death" || planned.kind !== kind)) {
    await cancelPlannedAsSuperseded(tx, planned);
  }
  const context = await exitContextFor(tx, p, kind, req.exit, now);
  const rates = await exitRates(tx, actor.tenantId, p.nation, ukIsoDate(leftAt));
  const deadlines = exitReturnDeadlines(leftAt, context, rates);
  let exitId: string;
  if (planned && planned.kind === kind && kind !== "death") {
    exitId = planned.id;
    await tx
      .update(exitRecord)
      .set({
        leftAt,
        ...exitColumns(context, req.exit ?? undefined),
        moneyAndPropertyDueAt: deadlines.moneyAndPropertyBy,
        depositDueAt: deadlines.depositBy,
      })
      .where(eq(exitRecord.id, planned.id));
  } else {
    const definition = EXIT_WORKFLOWS[kind];
    const [row] = await tx
      .insert(exitRecord)
      .values({
        personId: p.id,
        locationId: p.locationId,
        kind,
        state: definition.initial,
        leftAt,
        ...exitColumns(context, req.exit),
        moneyAndPropertyDueAt: deadlines.moneyAndPropertyBy,
        depositDueAt: deadlines.depositBy,
      })
      .returning();
    if (!row) throw problems.conflict();
    exitId = row.id;
    const instance = await startWorkflow(
      tx,
      actor.tenantId,
      definition,
      { subjectType: "exit_record", subjectId: row.id, personId: p.id },
      leftAt,
    );
    await tx
      .update(exitRecord)
      .set({ workflowInstanceId: instance.id })
      .where(eq(exitRecord.id, row.id));
  }
  if (kind !== "death") {
    await moveWorkflow(
      tx,
      actor.tenantId,
      EXIT_WORKFLOWS[kind],
      { subjectType: "exit_record", subjectId: exitId, personId: p.id },
      {
        to: "left",
        actorTenantUserId: actor.tenantUserId,
        permissions: actor.permissions,
        reason: null,
        stepUpFresh: actor.stepUpFresh,
      },
      leftAt,
    );
    await tx.update(exitRecord).set({ state: "left" }).where(eq(exitRecord.id, exitId));
  }
  await writeChecklist(tx, p.id, exitId, context);
  await tx.insert(task).values({
    kind: "people.exit_checklist",
    title: "Complete the exit checklist",
    requiredPermission: "people.admission.manage",
    personId: p.id,
    locationId: p.locationId,
    sourceType: "exit_record",
    sourceId: exitId,
    assigneeRoleKey: "registered_manager",
    dueAt: deadlines.moneyAndPropertyBy,
    priority: "routine",
  });
  return exitId;
}

/** Cancels the open exit when a discharge or death is corrected as recorded in error. */
async function cancelExit(
  tx: Transaction,
  actor: Actor,
  personId: string,
  reason: string,
  now: Date,
): Promise<string | null> {
  const [open] = await tx
    .select()
    .from(exitRecord)
    .where(
      and(
        eq(exitRecord.personId, personId),
        notInArray(exitRecord.state, ["closed", "cancelled"]),
        isNull(exitRecord.deletedAt),
      ),
    );
  if (!open) return null;
  await moveWorkflow(
    tx,
    actor.tenantId,
    EXIT_WORKFLOWS[open.kind as ExitKind],
    { subjectType: "exit_record", subjectId: open.id, personId },
    {
      to: "cancelled",
      actorTenantUserId: actor.tenantUserId,
      permissions: actor.permissions,
      reason,
      stepUpFresh: actor.stepUpFresh,
    },
    now,
  );
  await tx
    .update(exitRecord)
    .set({ state: "cancelled", cancelledReason: reason })
    .where(eq(exitRecord.id, open.id));
  await tx
    .update(task)
    .set({ status: "cancelled", statusReason: "The exit was recorded in error" })
    .where(
      and(
        eq(task.sourceId, open.id),
        eq(task.kind, "people.exit_checklist"),
        inArray(task.status, ["open", "in_progress"]),
      ),
    );
  return open.id;
}

export { WorkflowMoveRefused };

// ------------------------------------------------------------------------------------------------
// Return from hospital (rule 10) and reviews on change (rule 8)
// ------------------------------------------------------------------------------------------------

/** Marks the open transfer returned and raises the return checks (hospitals change things). */
async function recordHospitalReturn(tx: Transaction, p: PersonRow, at: Date) {
  const [open] = await tx
    .select()
    .from(hospitalTransfer)
    .where(
      and(
        eq(hospitalTransfer.personId, p.id),
        isNull(hospitalTransfer.returnedAt),
        isNull(hospitalTransfer.deletedAt),
      ),
    );
  if (!open) return null;
  const property = await tx
    .select({
      id: propertyItem.id,
      category: propertyItem.category,
      valuable: propertyItem.valuable,
      receivedOn: propertyItem.receivedOn,
      status: propertyItem.status,
    })
    .from(propertyItem)
    .where(and(eq(propertyItem.personId, p.id), isNull(propertyItem.deletedAt)));
  const checks = returnFromHospitalChecks(
    property.map((i) => ({ ...i, status: i.status as "held" })),
  );
  await tx
    .update(hospitalTransfer)
    .set({
      returnedAt: at < open.leftAt ? open.leftAt : at,
      returnChecks: Object.fromEntries(
        checks.map((c) => [
          c.key,
          { title: c.title, hazardIds: c.hazardIds, doneBy: null, doneAt: null },
        ]),
      ),
    })
    .where(eq(hospitalTransfer.id, open.id));
  return open.id;
}

/** A return from hospital is a change that needs the care plan reviewed (rule 8, HZ-008). */
async function raiseReviewOnReturn(tx: Transaction, p: PersonRow, at: Date, now: Date) {
  const [transfer] = await tx
    .select({ id: hospitalTransfer.id })
    .from(hospitalTransfer)
    .where(and(eq(hospitalTransfer.personId, p.id), isNull(hospitalTransfer.deletedAt)))
    .orderBy(desc(hospitalTransfer.leftAt))
    .limit(1);
  await recordCarePlanChange(
    tx,
    p,
    {
      kind: "return_from_hospital",
      occurredOn: ukIsoDate(at),
      sourceType: transfer ? "hospital_transfer" : null,
      sourceId: transfer?.id ?? null,
    },
    now,
  );
}

/**
 * Records a change in needs and refers it to the care plan: the active plan's review comes
 * forward and one review task is raised for the nurse in charge (care.md rule 1; HZ-008).
 */
export async function recordCarePlanChange(
  tx: Transaction,
  p: PersonRow,
  change: {
    kind: typeof carePlanChange.$inferInsert.kind;
    occurredOn: string;
    sourceType: string | null;
    sourceId: string | null;
  },
  now: Date,
) {
  const [row] = await tx
    .insert(carePlanChange)
    .values({ personId: p.id, ...change })
    .onConflictDoNothing()
    .returning();
  await bringPlanReviewForward(tx, {
    personId: p.id,
    locationId: p.locationId,
    reason: "A change in the person's needs",
    now,
  });
  return row ?? null;
}

// ------------------------------------------------------------------------------------------------
// Review scheduler (rule 8)
// ------------------------------------------------------------------------------------------------

/** Review records that a later record has not superseded. */
export function currentRecords<T extends { id: string; supersedesId: string | null }>(
  rows: readonly T[],
): T[] {
  const superseded = new Set(rows.flatMap((r) => (r.supersedesId ? [r.supersedesId] : [])));
  return rows.filter((r) => !superseded.has(r.id));
}

export async function currentPlacement(tx: Transaction, personId: string) {
  const [row] = await tx
    .select()
    .from(placement)
    .where(
      and(eq(placement.personId, personId), isNull(placement.endDate), isNull(placement.deletedAt)),
    )
    .orderBy(desc(placement.startDate))
    .limit(1);
  return row ?? null;
}

/** The review schedule for a person from the record, or null when the nation has no figures. */
export async function reviewScheduleFor(
  tx: Transaction,
  tenantId: string,
  p: PersonRecord,
  now: Date,
): Promise<{ readonly schedule: ReviewSchedule; readonly available: boolean }> {
  const today = ukIsoDate(now);
  const status = p.status as PersonStatus;
  const empty = (available: boolean): { schedule: ReviewSchedule; available: boolean } => ({
    schedule: {
      items: [],
      familyInvolvement: LIVE_PERSON_STATUSES.includes(status) ? "scheduled" : "not_receiving_care",
    },
    available,
  });
  if (!LIVE_PERSON_STATUSES.includes(status)) {
    return { schedule: { items: [], familyInvolvement: "not_receiving_care" }, available: true };
  }
  const rates = await peopleRates(tx, tenantId, p.nation, today);
  if (!rates) return empty(false);
  const current = await currentPlacement(tx, p.id);
  if (!current) return empty(true);
  const plans = await tx
    .select({ publishedAt: carePlan.publishedAt })
    .from(carePlan)
    .where(
      and(eq(carePlan.personId, p.id), isNotNull(carePlan.publishedAt), isNull(carePlan.deletedAt)),
    )
    .orderBy(asc(carePlan.publishedAt));
  const records = currentRecords(
    await tx.select().from(reviewRecord).where(eq(reviewRecord.personId, p.id)),
  );
  const changes = await tx
    .select()
    .from(carePlanChange)
    .where(and(eq(carePlanChange.personId, p.id), isNull(carePlanChange.deletedAt)));
  const firstPublishedAt = plans[0]?.publishedAt ?? null;
  const reviewedOn = [
    ...records.filter((r) => r.kind === "care_plan").map((r) => r.heldOn),
    ...plans.slice(1).flatMap((pl) => (pl.publishedAt ? [ukIsoDate(pl.publishedAt)] : [])),
  ].sort();
  const schedule = scheduleReviews({
    status,
    admittedAt: ukDayBounds(current.startDate).startsAt,
    placement: {
      type: current.type,
      startDate: current.startDate,
      trialEndsOn: current.trialEndsOn,
      trialReviewedOn: current.trialReviewedOn,
      localAuthorityFunded: current.localAuthorityFunded,
    },
    carePlan: { firstPublishedAt, lastReviewedOn: reviewedOn.at(-1) ?? null },
    laReviewsCompleted: records.filter((r) => r.kind === "la_review").map((r) => r.heldOn),
    changes: changes.map((c) => ({
      id: c.id,
      kind: c.kind as never,
      occurredOn: c.occurredOn,
      reviewedOn: c.reviewedOn,
    })),
    familyInvolvement: records
      .filter((r) => r.kind === "family_involvement" && r.familyInvolvementKind)
      .map((r) => ({
        kind: r.familyInvolvementKind as FamilyInvolvementKind,
        recordedOn: r.heldOn,
      })),
    today,
    holidays: await bankHolidays(tx, p.nation),
    rates,
  });
  return { schedule, available: true };
}

/** The tasks the people scheduler raises; the care plan's own reviews are the care module's. */
export const PEOPLE_REVIEW_TASKS = {
  la_review: { kind: "people.review.la_review", title: "Arrange the local authority review" },
  family_involvement: {
    kind: "people.review.family_involvement",
    title: "Record family involvement",
  },
  trial_review: { kind: "people.review.trial_review", title: "Review the trial placement" },
} as const;

/** Registered Managers at a location (tenant-wide ones too); the owner when there is none. */
export async function registeredManagersAt(tx: Transaction, locationId: string): Promise<string[]> {
  const holders = (keys: readonly string[]) =>
    tx
      .selectDistinct({ id: roleAssignment.tenantUserId })
      .from(roleAssignment)
      .innerJoin(role, eq(role.id, roleAssignment.roleId))
      .where(
        and(
          inArray(role.key, [...keys]),
          isNull(roleAssignment.deletedAt),
          or(isNull(roleAssignment.locationId), eq(roleAssignment.locationId, locationId)),
        ),
      );
  const managers = await holders(["registered_manager"]);
  return (managers.length > 0 ? managers : await holders(["owner"])).map((m) => m.id);
}

/**
 * The scheduled sweep for one tenant (people.md rule 8): one task, one alert to the Registered
 * Manager and one `people.review.due` event for each local authority review, family involvement
 * record and trial review that is due or overdue, never twice while one is open; and changes in
 * need referred to the care plan, whose review comes forward once (HZ-008). The first care plan
 * and the regular plan review are raised by the care module's sweep.
 */
export async function raisePeopleReviews(
  tx: Transaction,
  tenantId: string,
  now: Date,
): Promise<number> {
  const people = await tx
    .select({ id: person.id })
    .from(person)
    .where(
      and(isNull(person.deletedAt), inArray(person.status, ["active", "on_leave", "in_hospital"])),
    );
  let raised = 0;
  for (const { id } of people) {
    const p = await loadPerson(tx, id);
    const { schedule, available } = await reviewScheduleFor(tx, tenantId, p, now);
    if (!available) continue;
    for (const item of schedule.items) {
      if (item.state !== "due" && item.state !== "overdue") continue;
      if (item.kind === "care_plan_review_on_change") {
        const [plan] = await tx
          .select({ reviewDueOn: carePlan.reviewDueOn })
          .from(carePlan)
          .where(
            and(
              eq(carePlan.personId, p.id),
              eq(carePlan.status, "active"),
              isNull(carePlan.deletedAt),
            ),
          );
        if (plan && (plan.reviewDueOn === null || plan.reviewDueOn > item.dueOn)) {
          await bringPlanReviewForward(tx, {
            personId: p.id,
            locationId: p.locationId,
            reason: "A change in the person's needs",
            now,
          });
          raised++;
        }
        continue;
      }
      if (
        item.kind !== "la_review" &&
        item.kind !== "family_involvement" &&
        item.kind !== "trial_review"
      ) {
        continue;
      }
      const spec = PEOPLE_REVIEW_TASKS[item.kind];
      const [open] = await tx
        .select({ id: task.id })
        .from(task)
        .where(
          and(
            eq(task.kind, spec.kind),
            eq(task.personId, p.id),
            inArray(task.status, ["open", "in_progress"]),
            isNull(task.deletedAt),
          ),
        )
        .limit(1);
      if (open) continue;
      const due = ukDayBounds(item.dueOn);
      const [created] = await tx
        .insert(task)
        .values({
          kind: spec.kind,
          title: spec.title,
          requiredPermission: "care.plan.write",
          personId: p.id,
          locationId: p.locationId,
          sourceType: "person",
          sourceId: p.id,
          assigneeRoleKey: "registered_manager",
          dueAt: due.startsAt,
          windowStart: item.windowOpensOn ? ukDayBounds(item.windowOpensOn).startsAt : null,
          windowEnd: due.endsAt,
          priority: item.state === "overdue" ? "urgent" : "routine",
        })
        .returning({ id: task.id });
      for (const recipient of await registeredManagersAt(tx, p.locationId)) {
        await tx
          .insert(notification)
          .values({
            recipientTenantUserId: recipient,
            kind: "people.review.due",
            severity: item.state === "overdue" ? "warning" : "info",
            title: "A review is due",
            body: "Open the person's reviews to see what is due.",
            link: `/people/${p.id}/reviews`,
            channels: ["in_app"],
            sourceType: "task",
            sourceId: created?.id ?? null,
            dedupeKey: `${spec.kind}:${p.id}:${item.dueOn}`,
          })
          .onConflictDoNothing();
      }
      await publish(tx, {
        context: "people",
        aggregateType: "person",
        aggregateId: p.id,
        type: "people.review.due",
        payload: { personId: p.id, kind: item.kind, dueOn: item.dueOn, state: item.state },
      });
      raised++;
    }
  }
  return raised;
}

/** Completes the open people review task of a kind when its review is recorded. */
export async function completeReviewTask(
  tx: Transaction,
  input: {
    personId: string;
    kind: keyof typeof PEOPLE_REVIEW_TASKS;
    recordId: string;
    actor: string;
    now: Date;
  },
) {
  await tx
    .update(task)
    .set({
      status: "done",
      completedAt: input.now,
      completedBy: input.actor,
      evidenceType: "review_record",
      evidenceId: input.recordId,
    })
    .where(
      and(
        eq(task.personId, input.personId),
        eq(task.kind, PEOPLE_REVIEW_TASKS[input.kind].kind),
        inArray(task.status, ["open", "in_progress"]),
        isNull(task.deletedAt),
      ),
    );
}

// ------------------------------------------------------------------------------------------------
// Keys and property counted for the exit (rule 12)
// ------------------------------------------------------------------------------------------------

export async function personKeys(tx: Transaction, personId: string) {
  return tx
    .select()
    .from(keyIssue)
    .where(and(eq(keyIssue.personId, personId), isNull(keyIssue.deletedAt)))
    .orderBy(asc(keyIssue.issuedOn));
}

export async function personProperty(tx: Transaction, personId: string) {
  return tx
    .select()
    .from(propertyItem)
    .where(and(eq(propertyItem.personId, personId), isNull(propertyItem.deletedAt)))
    .orderBy(asc(propertyItem.receivedOn), asc(propertyItem.createdAt));
}
