import {
  auditEvent,
  carePlan,
  carePlanAction,
  carePlanSection,
  location,
  person,
  type Transaction,
  task,
  taskSeries,
} from "@harbour/db";
import {
  CARE_PLAN_TASK_RATE_KEYS,
  isClosedRecord,
  type PcspDomain,
  PLAN_ACTION_SOURCE_TYPE,
  PLAN_ACTION_TASK_KIND,
  PLAN_ACTION_TASK_PERMISSION,
  type PlanTaskAction,
  type PlanTaskSeries,
  planActionTaskSeries,
  planActionTaskTitle,
  planActionTaskWindow,
  type Recurrence,
  ukIsoDate,
} from "@harbour/domain";
import { and, asc, eq, gte, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { rateNumber } from "./rates";
import { materialiseSeries } from "./tasks";

/**
 * Care plan rounds (care.md rule 14; register row CARE-013): each task-generating action of the
 * person's active plan drives one task series in the task engine. Publishing a version and an
 * hourly sweep both call `syncPlanTaskSeries`, which is idempotent: the domain rule
 * (`planActionTaskSeries`) keeps what already runs, carries an unchanged action's series to the
 * new version, creates what is missing and ends the rest.
 */

/** Why a round of a series the care plan no longer drives was cancelled. */
export const PLAN_CHANGED_REASON = "Ended: the care plan changed";

export interface PlanTaskSync {
  readonly created: number;
  readonly adopted: number;
  readonly kept: number;
  readonly ended: number;
  readonly notGenerated: number;
}

const NOTHING: PlanTaskSync = { created: 0, adopted: 0, kept: 0, ended: 0, notGenerated: 0 };

export const changedAnything = (s: PlanTaskSync) => s.created + s.adopted + s.ended > 0;

/** A series the plan no longer drives ends; its rounds from now are cancelled with the reason. */
async function endPlanSeries(
  tx: Transaction,
  series: typeof taskSeries.$inferSelect,
  now: Date,
): Promise<void> {
  const today = ukIsoDate(now);
  await tx
    .update(taskSeries)
    .set({
      active: false,
      inactiveCode: null,
      stoppedByExitId: null,
      endsOn: series.startsOn > today ? series.startsOn : today,
    })
    .where(eq(taskSeries.id, series.id));
  await tx
    .update(task)
    .set({ status: "cancelled", statusReason: PLAN_CHANGED_REASON })
    .where(
      and(
        eq(task.seriesId, series.id),
        inArray(task.status, ["open", "in_progress"]),
        gte(task.dueAt, now),
        isNull(task.deletedAt),
      ),
    );
  // Rounds the lifecycle paused or ended lose their code, so a return or a correction never
  // brings back a schedule the plan has dropped (HZ-003).
  await tx
    .update(task)
    .set({ statusReason: PLAN_CHANGED_REASON, cancelCode: null, stoppedByExitId: null })
    .where(
      and(
        eq(task.seriesId, series.id),
        eq(task.status, "cancelled"),
        isNotNull(task.cancelCode),
        isNull(task.deletedAt),
      ),
    );
}

/**
 * Makes the person's care plan rounds match their active plan (care.md rule 14). A closed record
 * is left alone: the people lifecycle ended its series and a correction restores them.
 */
export async function syncPlanTaskSeries(
  tx: Transaction,
  personId: string,
  now: Date,
): Promise<PlanTaskSync> {
  const [who] = await tx
    .select({
      id: person.id,
      tenantId: person.tenantId,
      status: person.status,
      locationId: person.locationId,
      nation: location.nation,
    })
    .from(person)
    .innerJoin(location, eq(location.id, person.locationId))
    .where(and(eq(person.id, personId), isNull(person.deletedAt)));
  if (!who || isClosedRecord(who.status)) return NOTHING;

  const [plan] = await tx
    .select({ id: carePlan.id })
    .from(carePlan)
    .where(
      and(
        eq(carePlan.personId, personId),
        eq(carePlan.status, "active"),
        isNull(carePlan.deletedAt),
      ),
    );
  const actions = plan
    ? await tx
        .select({ action: carePlanAction, domain: carePlanSection.domain })
        .from(carePlanAction)
        .innerJoin(carePlanSection, eq(carePlanSection.id, carePlanAction.sectionId))
        .where(and(eq(carePlanAction.planId, plan.id), isNull(carePlanAction.deletedAt)))
        .orderBy(asc(carePlanAction.createdAt), asc(carePlanAction.id))
    : [];
  const series = await tx
    .select()
    .from(taskSeries)
    .where(
      and(
        eq(taskSeries.personId, personId),
        eq(taskSeries.sourceType, PLAN_ACTION_SOURCE_TYPE),
        isNull(taskSeries.deletedAt),
        or(eq(taskSeries.active, true), isNotNull(taskSeries.inactiveCode)),
      ),
    )
    .orderBy(asc(taskSeries.createdAt));

  const byAction = new Map(actions.map((a) => [a.action.id, a]));
  const changes = planActionTaskSeries(
    {
      status: plan ? "active" : "superseded",
      actions: actions.map(
        ({ action, domain }): PlanTaskAction => ({
          id: action.id,
          basedOnActionId: action.basedOnActionId,
          domain: domain as PcspDomain,
          generatesTasks: action.generatesTasks,
          recurrence: action.recurrence as Recurrence | null,
          roleKey: action.roleKey,
          evidenceRequired: action.evidenceRequired,
        }),
      ),
    },
    series.map(
      (s): PlanTaskSeries => ({
        id: s.id,
        actionId: s.sourceId ?? "",
        active: s.active,
        lifecycleStopped: s.inactiveCode !== null,
        title: s.title,
        recurrence: s.recurrence as Recurrence,
        roleKey: s.assigneeRoleKey,
        evidenceRequired: s.evidenceRequired,
      }),
    ),
  );

  for (const id of changes.end) {
    const s = series.find((x) => x.id === id);
    if (s) await endPlanSeries(tx, s, now);
  }
  const link = (actionId: string, seriesId: string) =>
    tx
      .update(carePlanAction)
      .set({ taskSeriesId: seriesId })
      .where(
        and(eq(carePlanAction.id, actionId), sql`task_series_id IS DISTINCT FROM ${seriesId}`),
      );
  for (const { actionId, seriesId } of changes.keep) await link(actionId, seriesId);
  for (const { actionId, seriesId } of changes.adopt) {
    // The series and its rounds still to come now carry out the new version's action.
    await tx.update(taskSeries).set({ sourceId: actionId }).where(eq(taskSeries.id, seriesId));
    await tx
      .update(task)
      .set({ sourceId: actionId })
      .where(
        and(
          eq(task.seriesId, seriesId),
          inArray(task.status, ["open", "in_progress"]),
          isNull(task.deletedAt),
        ),
      );
    await link(actionId, seriesId);
  }
  if (changes.create.length > 0) {
    const nation = who.nation;
    const defaults = {
      beforeMinutes: await rateNumber(
        tx,
        who.tenantId,
        CARE_PLAN_TASK_RATE_KEYS.windowBeforeMinutes,
        nation,
      ),
      afterMinutes: await rateNumber(
        tx,
        who.tenantId,
        CARE_PLAN_TASK_RATE_KEYS.windowAfterMinutes,
        nation,
      ),
    };
    for (const actionId of changes.create) {
      const row = byAction.get(actionId);
      const rule = row?.action.recurrence as Recurrence | null;
      if (!row || !rule) continue;
      const window = planActionTaskWindow(rule, defaults);
      const [created] = await tx
        .insert(taskSeries)
        .values({
          locationId: who.locationId,
          personId,
          kind: PLAN_ACTION_TASK_KIND,
          title: planActionTaskTitle(row.domain as PcspDomain),
          requiredPermission: PLAN_ACTION_TASK_PERMISSION,
          sourceType: PLAN_ACTION_SOURCE_TYPE,
          sourceId: actionId,
          assigneeRoleKey: row.action.roleKey,
          recurrence: rule,
          startsOn: ukIsoDate(now),
          windowBeforeMinutes: window.beforeMinutes,
          windowAfterMinutes: window.afterMinutes,
          evidenceRequired: row.action.evidenceRequired,
        })
        // Another run made it first (the sweep and a publication at once): one series per action.
        .onConflictDoNothing()
        .returning();
      if (!created) continue;
      await link(actionId, created.id);
      await materialiseSeries(tx, created, now);
    }
  }
  return {
    created: changes.create.length,
    adopted: changes.adopt.length,
    kept: changes.keep.length,
    ended: changes.end.length,
    notGenerated: changes.notGenerated.length,
  };
}

/**
 * The hourly sweep (care.md rule 14): every person with an active plan, or with care plan rounds
 * still running, has their rounds matched to the plan. It catches plans published before slice 5
 * and anything a failed publication left behind. Each change is audited as the system.
 */
export async function generatePlanTasks(
  tx: Transaction,
  tenantId: string,
  now: Date,
): Promise<number> {
  const withPlans = await tx
    .selectDistinct({ personId: carePlan.personId })
    .from(carePlan)
    .where(and(eq(carePlan.status, "active"), isNull(carePlan.deletedAt)));
  const withSeries = await tx
    .selectDistinct({ personId: taskSeries.personId })
    .from(taskSeries)
    .where(
      and(
        eq(taskSeries.sourceType, PLAN_ACTION_SOURCE_TYPE),
        eq(taskSeries.active, true),
        isNull(taskSeries.deletedAt),
      ),
    );
  const people = new Set(
    [...withPlans, ...withSeries].map((r) => r.personId).filter((id): id is string => !!id),
  );
  let changed = 0;
  for (const personId of people) {
    const result = await syncPlanTaskSeries(tx, personId, now);
    if (!changedAnything(result)) continue;
    changed += result.created + result.adopted + result.ended;
    await tx.insert(auditEvent).values({
      tenantId,
      action: "care.plan.tasks.generate",
      resourceType: "person",
      resourceId: personId,
      scope: { ...result },
    });
  }
  return changed;
}
