import { type NotARound, type PlanActionRef, type RoundTask, RoundView } from "@harbour/contracts";
import {
  bedOccupancy,
  carePlan,
  carePlanAction,
  carePlanSection,
  room,
  task,
  taskSeries,
} from "@harbour/db";
import {
  type CarePlanStatus,
  DOMAINS_WITHOUT_PLAN_TASKS,
  type RoundTask as DomainRoundTask,
  NOT_A_ROUND_NOTICE,
  type PcspDomain,
  PLAN_ACTION_SOURCE_TYPE,
  planRoundNotice,
  type RoundPerson,
  roundView,
  shiftAt,
  type TaskStatus,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { auditInTx } from "../http/audit";
import { requirePermission, withTenant } from "../http/context";
import { problems } from "../http/problem";
import { locationInScope, shiftPatternFor } from "../services/handover";
import { escalationMinutes, toTaskItem } from "../services/tasks";
import { createRouter, errorResponses, jsonBody, notFoundResponse, security } from "./openapi";
import { personSummaries } from "./people";

/**
 * The round view (care.md rule 8; master prompt 10.1 "round view by corridor or run"; register row
 * CARE-013): the location's open tasks for the shift running now, by floor or unit and room, each
 * stop with the point-of-care header (HZ-001, HZ-016) and each care plan round with the action as
 * its plan words it, marked when that is an earlier plan (HZ-024). Each stop lists the person's
 * active plan actions that are not rounds (medicines, HZ-003). Tasks and people follow the
 * viewer's scope (row-level security).
 */

const LocationParam = z.object({ id: z.uuid() });
const HOUR_MS = 3_600_000;
const MAX_TASKS = 2000;

export const roundsRouter = createRouter().openapi(
  createRoute({
    method: "get",
    path: "/v1/locations/{id}/round",
    tags: ["care"],
    summary: "The round: open tasks for the shift running now, by floor, room and time",
    description:
      "Unfinished tasks from earlier rounds stay on it until they are done or skipped with a reason. Give `from` and `to` (at most 24 hours) for another window.",
    security,
    request: {
      params: LocationParam,
      query: z.object({
        from: z.iso.datetime({ offset: true }).optional(),
        to: z.iso.datetime({ offset: true }).optional(),
      }),
    },
    responses: {
      200: jsonBody(RoundView, "The round as you may see it"),
      ...errorResponses,
      ...notFoundResponse,
    },
  }),
  async (c) => {
    const access = await requirePermission(c, "care.plan.read");
    const { id: locationId } = c.req.valid("param");
    const q = c.req.valid("query");
    if ((q.from === undefined) !== (q.to === undefined)) {
      throw problems.invalid("Give both from and to, or neither for the shift running now.");
    }
    const now = new Date();
    const view = await withTenant(c, async (tx) => {
      const loc = await locationInScope(tx, locationId);
      if (!loc) throw problems.notFound();
      const shift = shiftAt(now, await shiftPatternFor(tx, access.tenantId, loc.nation));
      const from = q.from ? new Date(q.from) : shift.start;
      const to = q.to ? new Date(q.to) : shift.end;
      if (to.getTime() <= from.getTime()) {
        throw problems.invalid("Ask for a period that ends after it starts.");
      }
      if (to.getTime() - from.getTime() > 24 * HOUR_MS) {
        throw problems.invalid("Ask for 24 hours or fewer.");
      }
      const rows = await tx
        .select()
        .from(task)
        .where(
          and(
            eq(task.locationId, locationId),
            inArray(task.status, ["open", "in_progress"]),
            isNull(task.deletedAt),
            or(lt(task.dueAt, to), lte(sql`coalesce(${task.windowStart}, ${task.dueAt})`, now)),
          ),
        )
        .orderBy(asc(task.dueAt))
        .limit(MAX_TASKS + 1);
      // Never silently short: the view says when it could not list every open task.
      const complete = rows.length <= MAX_TASKS;
      if (!complete) rows.pop();
      const personIds = [
        ...new Set(rows.map((r) => r.personId).filter((p): p is string => p !== null)),
      ];
      const people = personIds.length === 0 ? [] : await personSummaries(tx, personIds);
      const beds =
        personIds.length === 0
          ? []
          : await tx
              .select({
                personId: bedOccupancy.personId,
                floor: room.floor,
                unitName: room.unitName,
              })
              .from(bedOccupancy)
              .innerJoin(room, eq(room.id, bedOccupancy.roomId))
              .where(
                and(
                  inArray(bedOccupancy.personId, personIds),
                  isNull(bedOccupancy.toDate),
                  isNull(bedOccupancy.deletedAt),
                ),
              );
      const roundPeople: RoundPerson[] = people.map((p) => {
        const bed = beds.find((b) => b.personId === p.id);
        return {
          personId: p.id,
          area: bed?.floor ?? bed?.unitName ?? null,
          roomLabel: p.roomLabel,
        };
      });
      const actions = await planActions(
        tx,
        rows.filter((r) => r.seriesId !== null).map((r) => r.seriesId as string),
      );
      const notRounds = await actionsNotRounds(tx, personIds);
      const minutes = await escalationMinutes(tx, access.tenantId);
      const areas = roundView(
        rows.map(
          (r): DomainRoundTask => ({
            id: r.id,
            personId: r.personId,
            title: r.title,
            status: r.status as TaskStatus,
            dueAt: r.dueAt,
            windowStart: r.windowStart,
            windowEnd: r.windowEnd,
          }),
        ),
        roundPeople,
        { from, to },
        now,
        minutes,
      );
      const byId = new Map(rows.map((r) => [r.id, r]));
      const byPerson = new Map(people.map((p) => [p.id, p]));
      const result = areas.map((area) => ({
        area: area.area,
        stops: area.stops
          // A task about someone the viewer cannot see never reaches them (row-level security
          // already hides it); a stop always carries the header of the person it is about.
          .filter((s) => s.personId === null || byPerson.has(s.personId))
          .map((stop) => ({
            personId: stop.personId,
            roomLabel: stop.roomLabel,
            person: stop.personId ? (byPerson.get(stop.personId) ?? null) : null,
            notRounds: stop.personId ? (notRounds.get(stop.personId) ?? []) : [],
            tasks: stop.tasks.map((entry): RoundTask => {
              const row = byId.get(entry.id);
              if (!row) throw new Error("Round task vanished");
              return {
                ...toTaskItem(row, now, minutes),
                planAction: row.seriesId ? (actions.get(row.seriesId) ?? null) : null,
              };
            }),
          })),
      }));
      const taskCount = result.reduce(
        (n, a) => n + a.stops.reduce((m, s) => m + s.tasks.length, 0),
        0,
      );
      await auditInTx(tx, access, {
        action: "care.round.view",
        resourceType: "task",
        scope: { locationId, count: taskCount, people: personIds.length, complete },
        requestId: c.get("requestId"),
      });
      return {
        locationId,
        shift: { name: shift.name, start: shift.start.toISOString(), end: shift.end.toISOString() },
        from: from.toISOString(),
        to: to.toISOString(),
        readAt: now.toISOString(),
        taskCount,
        complete,
        areas: result,
      };
    });
    return c.json(view, 200);
  },
);

/**
 * The care plan action each series carries out, as its plan words it: through the series, whose
 * source moves to the new version's action when a version carries it forward (rule 14). A round
 * of a series the active plan no longer drives says it is from an earlier plan (HZ-024).
 */
async function planActions(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  seriesIds: readonly string[],
): Promise<Map<string, PlanActionRef>> {
  const ids = [...new Set(seriesIds)];
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({
      seriesId: taskSeries.id,
      actionId: carePlanAction.id,
      planId: carePlanAction.planId,
      publishedVersion: carePlan.publishedVersion,
      domain: carePlanSection.domain,
      action: carePlanAction.action,
      whenText: carePlanAction.whenText,
      planStatus: carePlan.status,
      seriesActive: taskSeries.active,
      seriesStoppedCode: taskSeries.inactiveCode,
    })
    .from(taskSeries)
    .innerJoin(carePlanAction, sql`${carePlanAction.id} = ${taskSeries.sourceId}`)
    .innerJoin(carePlanSection, eq(carePlanSection.id, carePlanAction.sectionId))
    .innerJoin(carePlan, eq(carePlan.id, carePlanAction.planId))
    .where(and(inArray(taskSeries.id, ids), eq(taskSeries.sourceType, PLAN_ACTION_SOURCE_TYPE)));
  return new Map(
    rows.map((r) => [
      r.seriesId,
      {
        actionId: r.actionId,
        planId: r.planId,
        publishedVersion: r.publishedVersion,
        domain: r.domain as PlanActionRef["domain"],
        action: r.action,
        whenText: r.whenText,
        planStatus: r.planStatus as CarePlanStatus,
        notice: planRoundNotice({
          planStatus: r.planStatus as CarePlanStatus,
          // Paused while the person is away, a series still belongs to its action.
          seriesLive: r.seriesActive || r.seriesStoppedCode !== null,
        }),
      },
    ]),
  );
}

/**
 * Each person's active plan actions in a domain that never generates rounds (medicines, until the
 * eMAR): listed on their stop as not a round, so the round never reads as all of their care
 * (HZ-003, H-151).
 */
async function actionsNotRounds(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  personIds: readonly string[],
): Promise<Map<string, NotARound[]>> {
  if (personIds.length === 0) return new Map();
  const rows = await tx
    .select({
      personId: carePlan.personId,
      actionId: carePlanAction.id,
      domain: carePlanSection.domain,
      action: carePlanAction.action,
      whenText: carePlanAction.whenText,
    })
    .from(carePlanAction)
    .innerJoin(carePlanSection, eq(carePlanSection.id, carePlanAction.sectionId))
    .innerJoin(carePlan, eq(carePlan.id, carePlanAction.planId))
    .where(
      and(
        inArray(carePlan.personId, [...personIds]),
        eq(carePlan.status, "active"),
        isNull(carePlan.deletedAt),
        isNull(carePlanAction.deletedAt),
        inArray(carePlanSection.domain, [...DOMAINS_WITHOUT_PLAN_TASKS]),
      ),
    )
    .orderBy(asc(carePlanAction.createdAt), asc(carePlanAction.id));
  const out = new Map<string, NotARound[]>();
  for (const r of rows) {
    out.set(r.personId, [
      ...(out.get(r.personId) ?? []),
      {
        actionId: r.actionId,
        domain: r.domain as PcspDomain,
        action: r.action,
        whenText: r.whenText,
        notice: NOT_A_ROUND_NOTICE,
      },
    ]);
  }
  return out;
}
