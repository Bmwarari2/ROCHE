import type { CarePlanDue, ResuscitationStatus } from "@harbour/contracts";
import {
  advanceCareRecord,
  assessment,
  carePlan,
  featureFlag,
  location,
  notification,
  person,
  placement,
  rateTable,
  riskAssessment,
  type Transaction,
  task,
} from "@harbour/db";
import {
  type AdvanceCareRecordState,
  BED_RAIL_RATE_KEYS,
  type BedRailLimits,
  CARE_PLAN_RATE_KEYS,
  type CarePlanRates,
  carePlanDue,
  currentResults,
  evaluateFlag,
  type FlagKey,
  firstCarePlanDue,
  LIVE_PERSON_STATUSES,
  type RateNation,
  type RateRow,
  resolveBedRailLimits,
  resolveCarePlanRates,
  resuscitationStatus,
  reviewOnChange,
  ukIsoDate,
} from "@harbour/domain";
import { and, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { nurseInCharge } from "./care";
import { bankHolidays } from "./rates";

/**
 * Care planning rules wired to the database (docs/specs/care.md rules 1, 2 and 5; hazards HZ-008,
 * HZ-014 and HZ-015): rate-table figures, the licence flags for validated tools, when the first
 * plan or the next review is due, the resuscitation status the point-of-care header shows, and the
 * review tasks raised for the nurse in charge.
 */

type Nation = Exclude<RateNation, "uk" | "all">;

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

export async function carePlanRates(
  tx: Transaction,
  tenantId: string,
  nation: Nation,
  on: string,
): Promise<CarePlanRates> {
  return resolveCarePlanRates(
    await rateRows(tx, Object.values(CARE_PLAN_RATE_KEYS)),
    nation,
    on,
    tenantId,
  );
}

export async function bedRailLimits(
  tx: Transaction,
  tenantId: string,
  nation: Nation,
  on: string,
): Promise<BedRailLimits> {
  return resolveBedRailLimits(
    await rateRows(tx, Object.values(BED_RAIL_RATE_KEYS)),
    nation,
    on,
    tenantId,
  );
}

/** Flags in force at a location (location row, then tenant row, then the catalogue default). */
export async function flagsAt(
  tx: Transaction,
  locationId: string,
): Promise<(flag: FlagKey) => boolean> {
  const rows = await tx
    .select({
      flagKey: featureFlag.flagKey,
      locationId: featureFlag.locationId,
      enabled: featureFlag.enabled,
    })
    .from(featureFlag)
    .where(isNull(featureFlag.deletedAt));
  return (flag) => evaluateFlag(flag, rows, locationId);
}

/** The start of the person's current placement (admission), or null when none is recorded. */
export async function admittedOn(tx: Transaction, personId: string): Promise<string | null> {
  const [current] = await tx
    .select({ startDate: placement.startDate })
    .from(placement)
    .where(
      and(eq(placement.personId, personId), isNull(placement.endDate), isNull(placement.deletedAt)),
    )
    .orderBy(desc(placement.startDate))
    .limit(1);
  return current?.startDate ?? null;
}

/** When the first plan is due for a person, or null when no deadline applies. */
export async function firstPlanDueOn(
  tx: Transaction,
  personId: string,
  nation: Nation,
  rates: CarePlanRates,
): Promise<string | null> {
  const admitted = await admittedOn(tx, personId);
  if (admitted === null || rates.initialWorkingDays === null) return null;
  return firstCarePlanDue(admitted, rates.initialWorkingDays, await bankHolidays(tx, nation)).dueOn;
}

/** What is due next for a person's plan: the first plan until one is active, then its review. */
export async function carePlanDueFor(
  tx: Transaction,
  input: { personId: string; nation: Nation; tenantId: string; now: Date },
): Promise<CarePlanDue> {
  const today = ukIsoDate(input.now);
  const [active] = await tx
    .select({ reviewDueOn: carePlan.reviewDueOn })
    .from(carePlan)
    .where(
      and(
        eq(carePlan.personId, input.personId),
        eq(carePlan.status, "active"),
        isNull(carePlan.deletedAt),
      ),
    );
  if (active?.reviewDueOn) {
    return carePlanDue({ today, activeReviewDueOn: active.reviewDueOn, firstPlanDueOn: null });
  }
  const rates = await carePlanRates(tx, input.tenantId, input.nation, today);
  return carePlanDue({
    today,
    activeReviewDueOn: null,
    firstPlanDueOn: await firstPlanDueOn(tx, input.personId, input.nation, rates),
  });
}

/** The person's current MUST band (latest result not superseded), or null with no result yet. */
export async function latestMustBand(
  tx: Transaction,
  personId: string,
): Promise<"low" | "medium" | "high" | null> {
  const rows = await tx
    .select({
      id: assessment.id,
      toolKey: assessment.toolKey,
      occurredAt: assessment.occurredAt,
      supersedesId: assessment.supersedesId,
      band: assessment.band,
    })
    .from(assessment)
    .where(and(eq(assessment.personId, personId), eq(assessment.toolKey, "must")))
    .orderBy(desc(assessment.occurredAt))
    .limit(50);
  const [current] = currentResults(rows);
  return (current?.band ?? null) as "low" | "medium" | "high" | null;
}

/** The resuscitation status for each person (HZ-015); `not_recorded` when nothing is in force. */
export async function resuscitationFor(
  tx: Transaction,
  personIds: readonly string[],
  now: Date,
): Promise<Map<string, ResuscitationStatus>> {
  const rows =
    personIds.length === 0
      ? []
      : await tx
          .select()
          .from(advanceCareRecord)
          .where(
            and(
              inArray(advanceCareRecord.personId, [...personIds]),
              eq(advanceCareRecord.status, "active"),
              isNull(advanceCareRecord.deletedAt),
              inArray(advanceCareRecord.kind, ["respect", "dnacpr"]),
            ),
          );
  const today = ukIsoDate(now);
  return new Map(
    personIds.map((id) => [
      id,
      resuscitationStatus(rows.filter((r) => r.personId === id).map(toRecordState), today),
    ]),
  );
}

export function toRecordState(row: typeof advanceCareRecord.$inferSelect): AdvanceCareRecordState {
  return {
    id: row.id,
    kind: row.kind as AdvanceCareRecordState["kind"],
    status: row.status as AdvanceCareRecordState["status"],
    cprDecision: row.cprDecision as AdvanceCareRecordState["cprDecision"],
    completedOn: row.completedOn,
    clinicianName: row.clinicianName,
    clinicianRole: row.clinicianRole,
    reviewDueOn: row.reviewDueOn,
  };
}

// ------------------------------------------------------------------------------------------------
// Review tasks for the nurse in charge (care.md rule 1; HZ-008: one task and one alert each)
// ------------------------------------------------------------------------------------------------

export const REVIEW_TASKS = {
  firstPlan: {
    kind: "care.care_plan_first",
    title: "Write the first care plan",
    permission: "care.plan.write",
    sourceType: "person",
  },
  planReview: {
    kind: "care.care_plan_review",
    title: "Review the care plan",
    permission: "care.plan.write",
    sourceType: "care_plan",
  },
  riskReview: {
    kind: "care.risk_assessment_review",
    title: "Review a risk assessment",
    permission: "care.plan.write",
    sourceType: "risk_assessment",
  },
  advanceCareReview: {
    kind: "care.advance_care_review",
    title: "Review an advance care record",
    permission: "care.respect.record",
    sourceType: "advance_care_record",
  },
} as const;

type ReviewTask = (typeof REVIEW_TASKS)[keyof typeof REVIEW_TASKS];

/**
 * Raises a review task for the nurse in charge unless one is already open for the same record, and
 * tells them once. Returns true when a task was raised.
 */
export async function raiseReviewTask(
  tx: Transaction,
  spec: ReviewTask,
  target: { personId: string; locationId: string; sourceId: string; dueOn: string | null },
  now: Date,
): Promise<boolean> {
  const [open] = await tx
    .select({ id: task.id })
    .from(task)
    .where(
      and(
        eq(task.kind, spec.kind),
        eq(task.sourceId, target.sourceId),
        inArray(task.status, ["open", "in_progress"]),
        isNull(task.deletedAt),
      ),
    )
    .limit(1);
  if (open) return false;
  const [created] = await tx
    .insert(task)
    .values({
      kind: spec.kind,
      title: spec.title,
      requiredPermission: spec.permission,
      personId: target.personId,
      locationId: target.locationId,
      sourceType: spec.sourceType,
      sourceId: target.sourceId,
      assigneeRoleKey: "clinical_lead",
      dueAt: now,
      priority: "routine",
    })
    .returning({ id: task.id });
  for (const recipient of await nurseInCharge(tx, target.locationId)) {
    await tx
      .insert(notification)
      .values({
        recipientTenantUserId: recipient,
        kind: spec.kind,
        severity: "warning",
        title: spec.title,
        body: "Open the person's record to see what is due.",
        link: `/people/${target.personId}`,
        channels: ["in_app"],
        sourceType: "task",
        sourceId: created?.id ?? null,
        dedupeKey: `${spec.kind}:${target.sourceId}:${target.dueOn ?? "none"}`,
      })
      .onConflictDoNothing();
  }
  return true;
}

/**
 * A change in the person's needs brings the active plan's review forward to today and raises the
 * review task now (care.md rule 1, "and on change"). Returns the plan reviewed, if any.
 */
export async function bringPlanReviewForward(
  tx: Transaction,
  input: { personId: string; locationId: string; reason: string; now: Date },
): Promise<string | null> {
  const [plan] = await tx
    .select()
    .from(carePlan)
    .where(
      and(
        eq(carePlan.personId, input.personId),
        eq(carePlan.status, "active"),
        isNull(carePlan.deletedAt),
      ),
    );
  if (!plan) return null;
  const today = ukIsoDate(input.now);
  const dueOn = reviewOnChange(plan.reviewDueOn, today);
  await tx
    .update(carePlan)
    .set({ reviewDueOn: dueOn, reviewReason: input.reason, reviewRequestedAt: input.now })
    .where(eq(carePlan.id, plan.id));
  await raiseReviewTask(
    tx,
    REVIEW_TASKS.planReview,
    { personId: plan.personId, locationId: plan.locationId, sourceId: plan.id, dueOn },
    input.now,
  );
  return plan.id;
}

/**
 * The scheduled sweep for one tenant: overdue first plans and plan reviews, and overdue reviews of
 * risk assessments and advance care records (HZ-015). People whose record is closed are skipped.
 * Idempotent: an open task for the same record stops a second one.
 */
export async function raiseOverdueCareReviews(
  tx: Transaction,
  tenantId: string,
  now: Date,
): Promise<number> {
  const today = ukIsoDate(now);
  let raised = 0;
  const people = await tx
    .select({
      id: person.id,
      status: person.status,
      locationId: person.locationId,
      nation: location.nation,
    })
    .from(person)
    .innerJoin(location, eq(location.id, person.locationId))
    .where(isNull(person.deletedAt));
  // People receiving care; care plan reviews wait while the person is in hospital, and their
  // return raises a review on change instead (people.md rule 8).
  const open = people.filter(
    (p) => LIVE_PERSON_STATUSES.includes(p.status) && p.status !== "in_hospital",
  );
  const byId = new Map(open.map((p) => [p.id, p]));

  const activePlans = await tx
    .select()
    .from(carePlan)
    .where(and(eq(carePlan.status, "active"), isNull(carePlan.deletedAt)));
  const withActivePlan = new Set(activePlans.map((p) => p.personId));
  for (const plan of activePlans) {
    const who = byId.get(plan.personId);
    if (!who || plan.reviewDueOn === null || plan.reviewDueOn >= today) continue;
    if (
      await raiseReviewTask(
        tx,
        REVIEW_TASKS.planReview,
        {
          personId: who.id,
          locationId: who.locationId,
          sourceId: plan.id,
          dueOn: plan.reviewDueOn,
        },
        now,
      )
    ) {
      raised++;
    }
  }

  const ratesByNation = new Map<Nation, CarePlanRates>();
  for (const who of open) {
    if (withActivePlan.has(who.id)) continue;
    const rates =
      ratesByNation.get(who.nation) ?? (await carePlanRates(tx, tenantId, who.nation, today));
    ratesByNation.set(who.nation, rates);
    const dueOn = await firstPlanDueOn(tx, who.id, who.nation, rates);
    if (dueOn === null || dueOn >= today) continue;
    if (
      await raiseReviewTask(
        tx,
        REVIEW_TASKS.firstPlan,
        { personId: who.id, locationId: who.locationId, sourceId: who.id, dueOn },
        now,
      )
    ) {
      raised++;
    }
  }

  const risks = await tx
    .select({
      id: riskAssessment.id,
      personId: riskAssessment.personId,
      reviewDueOn: riskAssessment.reviewDueOn,
    })
    .from(riskAssessment)
    .where(
      and(
        eq(riskAssessment.status, "active"),
        isNull(riskAssessment.deletedAt),
        lt(riskAssessment.reviewDueOn, today),
      ),
    );
  const records = await tx
    .select({
      id: advanceCareRecord.id,
      personId: advanceCareRecord.personId,
      reviewDueOn: advanceCareRecord.reviewDueOn,
    })
    .from(advanceCareRecord)
    .where(
      and(
        eq(advanceCareRecord.status, "active"),
        isNull(advanceCareRecord.deletedAt),
        lt(advanceCareRecord.reviewDueOn, today),
      ),
    );
  const reviews = [
    ...risks.map((r) => ({ ...r, spec: REVIEW_TASKS.riskReview })),
    ...records.map((r) => ({ ...r, spec: REVIEW_TASKS.advanceCareReview })),
  ];
  for (const review of reviews) {
    const who = byId.get(review.personId);
    if (!who) continue;
    if (
      await raiseReviewTask(
        tx,
        review.spec,
        {
          personId: who.id,
          locationId: who.locationId,
          sourceId: review.id,
          dueOn: review.reviewDueOn,
        },
        now,
      )
    ) {
      raised++;
    }
  }
  return raised;
}
