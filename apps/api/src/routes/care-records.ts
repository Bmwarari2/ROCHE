import {
  ActivityRecordItem,
  ActivityRecordList,
  AdvanceCareItem,
  AdvanceCareList,
  AssessmentItem,
  AssessmentList,
  AssessmentToolKey,
  CreateActivityRecord,
  CreateAdvanceCareRecord,
  CreateAssessment,
  CreateVisit,
  UpdateAdvanceCareRecord,
  VisitItem,
  VisitList,
} from "@harbour/contracts";
import {
  activityRecord,
  advanceCareRecord,
  assessment,
  contact,
  document,
  type Transaction,
  visitLog,
} from "@harbour/db";
import {
  type ActivityEngagement,
  type AdvanceCareKind,
  type AssessmentInput,
  type CareTrigger,
  type CprDecision,
  checkActivity,
  checkAdvanceCareRecord,
  checkAssessmentCorrection,
  checkVisit,
  checkWithdrawal,
  currentResults,
  type AssessmentToolKey as DomainToolKey,
  needsPlanReview,
  resuscitationStatus,
  runAssessment,
  toolAvailable,
  toolFlag,
  ukIsoDate,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx } from "../http/audit";
import { type AppEnv, requirePermission, type TenantAccess, withTenant } from "../http/context";
import { problems } from "../http/problem";
import { publish } from "../outbox";
import {
  careRates,
  completeOpenTasks,
  completeTaskWithEvidence,
  type EvidenceType,
  entryTimes,
  personContext,
  raiseCareTriggers,
} from "../services/care";
import {
  bringPlanReviewForward,
  carePlanRates,
  flagsAt,
  REVIEW_TASKS,
  toRecordState,
} from "../services/care-planning";
import { loadPerson, requireWrite } from "../services/people";
import {
  entryOut,
  iso,
  PersonParam,
  permissionsOf,
  range,
  requireCorrection,
  requireOpenRecord,
  SENT_AT_HEADER,
  supersededIds,
  window,
} from "./care-shared";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";

/**
 * Stored results of the validated tools, activities, the Regulation 9A visiting log and advance
 * care records (docs/specs/care.md rules 5 and 12; register rows CARE-003, CARE-006, CARE-014 and
 * CARE-015). Assessments, activities and visits are append-only with device ids, so offline
 * uploads are idempotent; a correction supersedes with a reason. Audited by record id only.
 */

const RecordParams = PersonParam.extend({ recordId: z.uuid() });

type AssessmentRow = typeof assessment.$inferSelect;
type ActivityRow = typeof activityRecord.$inferSelect;
type VisitRow = typeof visitLog.$inferSelect;
type AdvanceCareRow = typeof advanceCareRecord.$inferSelect;

const TOOL_NAMES: Record<DomainToolKey, string> = {
  must: "MUST",
  waterlow: "Waterlow",
  braden: "Braden",
  ng249_falls: "The falls assessment",
};

function audit(
  c: Context<AppEnv>,
  tx: Transaction,
  access: TenantAccess,
  input: Parameters<typeof auditInTx>[2],
) {
  return auditInTx(tx, access, { ...input, requestId: c.get("requestId") });
}

/** The id of a replayed upload must belong to the same person (it may not be reused). */
function replayed<R extends { personId: string }>(row: R | undefined, personId: string): R {
  if (!row || row.personId !== personId) throw problems.invalid("That id is already used.");
  return row;
}

async function completeAnsweredTask(
  tx: Transaction,
  access: TenantAccess,
  input: {
    taskId: string | undefined;
    personId: string;
    evidenceType: EvidenceType;
    evidenceId: string;
    now: Date;
  },
) {
  if (!input.taskId) return;
  await completeTaskWithEvidence(tx, {
    taskId: input.taskId,
    personId: input.personId,
    actorTenantUserId: access.tenantUserId,
    actorPermissions: permissionsOf(access),
    evidenceType: input.evidenceType,
    evidenceId: input.evidenceId,
    now: input.now,
  });
}

/** A correction raises only the follow-ups the original did not already raise (HZ-008). */
function newFollowUps(
  triggers: readonly CareTrigger[],
  original: AssessmentRow | null,
): CareTrigger[] {
  if (!original) return [...triggers];
  const raised = new Set(
    (original.triggers as CareTrigger[]).map((t) =>
      t.kind === "task" ? `task:${t.task}` : t.kind === "urgent_alert" ? "urgent_alert" : null,
    ),
  );
  return triggers.filter((t) =>
    t.kind === "task"
      ? !raised.has(`task:${t.task}`)
      : t.kind === "urgent_alert"
        ? !raised.has("urgent_alert")
        : true,
  );
}

function assessmentItem(row: AssessmentRow, superseded: ReadonlySet<string>): AssessmentItem {
  return {
    ...entryOut(row, superseded),
    toolKey: row.toolKey as AssessmentItem["toolKey"],
    toolVersion: row.toolVersion,
    answers: row.answers as Record<string, unknown>,
    score: row.score,
    band: row.band,
    workings: row.workings as AssessmentItem["workings"],
    triggers: row.triggers as AssessmentItem["triggers"],
    details: row.details as Record<string, unknown>,
    nextDueOn: row.nextDueOn,
  };
}

function activityItem(row: ActivityRow, superseded: ReadonlySet<string>): ActivityRecordItem {
  return {
    ...entryOut(row, superseded),
    activity: row.activity,
    format: row.format as ActivityRecordItem["format"],
    groupSessionId: row.groupSessionId,
    attendance: row.attendance as ActivityRecordItem["attendance"],
    engagement: row.engagement as ActivityRecordItem["engagement"],
    durationMinutes: row.durationMinutes,
    notes: row.notes,
  };
}

function visitItem(row: VisitRow, superseded: ReadonlySet<string>): VisitItem {
  return {
    ...entryOut(row, superseded),
    kind: row.kind as VisitItem["kind"],
    contactId: row.contactId,
    visitorName: row.visitorName,
    visitorRelationship: row.visitorRelationship,
    endedAt: iso(row.endedAt),
    restrictionsApplied: row.restrictionsApplied,
    restrictionReason: row.restrictionReason,
    notes: row.notes,
  };
}

function advanceCareItem(row: AdvanceCareRow, today: string): AdvanceCareItem {
  return {
    id: row.id,
    personId: row.personId,
    kind: row.kind as AdvanceCareItem["kind"],
    status: row.status as AdvanceCareItem["status"],
    cprDecision: row.cprDecision as AdvanceCareItem["cprDecision"],
    clinicianName: row.clinicianName,
    clinicianRole: row.clinicianRole,
    completedOn: row.completedOn,
    reviewDueOn: row.reviewDueOn,
    reviewOverdue: row.status === "active" && row.reviewDueOn !== null && today > row.reviewDueOn,
    documentId: row.documentId,
    details: row.details,
    withdrawnAt: iso(row.withdrawnAt),
    withdrawnReason: row.withdrawnReason,
    supersededByRecordId: row.supersededByRecordId,
    version: row.version,
  };
}

async function requireDocument(tx: Transaction, personId: string, documentId: string | null) {
  if (!documentId) return;
  const [found] = await tx
    .select({ personId: document.personId })
    .from(document)
    .where(and(eq(document.id, documentId), isNull(document.deletedAt)));
  if (!found || (found.personId !== null && found.personId !== personId)) {
    throw problems.invalid("The document was not found.");
  }
}

export const careRecordsRouter = createRouter()
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/assessments",
      tags: ["care"],
      summary: "Complete a validated tool (MUST, Waterlow, Braden or the NG249 falls questions)",
      description:
        "The server calculates the result exactly as published and stores the tool version, answers, score, band, workings, the follow-ups raised and when the tool is next due. MUST schedules the next screening and the weight checks; a changed band or a fall brings the care plan review forward. Waterlow and Braden are refused while their licence flags are off. Append-only: a correction supersedes with a reason.",
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: CreateAssessment } } },
      },
      responses: {
        201: jsonBody(AssessmentItem, "Saved (or the earlier copy of a replayed upload)"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.assessment.write");
      const { id: personId } = c.req.valid("param");
      const body = c.req.valid("json");
      requireCorrection(body);
      const now = new Date();
      const item = await withTenant(c, async (tx) => {
        const person = await personContext(tx, personId);
        const record = await loadPerson(tx, personId);
        if (!toolAvailable(body.toolKey, await flagsAt(tx, person.locationId))) {
          throw problems.featureDisabled(
            `${TOOL_NAMES[body.toolKey]} is switched off until its licence is confirmed (${toolFlag(body.toolKey)}).`,
          );
        }
        const rates = await careRates(tx, access.tenantId, person.nation);
        const times = entryTimes(body, c.req.header(SENT_AT_HEADER), now, rates);
        // people.md rule 3 (HZ-006): an assessment made before the person left, died or went to
        // hospital is accepted afterwards and flagged; one made later is refused.
        const { recordedAfterExit } = requireWrite(record, "assessment", times.occurredAt);
        let original: AssessmentRow | null = null;
        if (body.supersedesId) {
          const [found] = await tx
            .select()
            .from(assessment)
            .where(eq(assessment.id, body.supersedesId));
          original = found?.personId === personId ? found : null;
          const check = checkAssessmentCorrection(original, body.toolKey, body.correctionReason);
          if (!check.ok) throw problems.invalid(check.message);
        }
        const assessedOn = ukIsoDate(times.occurredAt);
        const planRates = await carePlanRates(tx, access.tenantId, person.nation, assessedOn);
        const outcome = runAssessment(
          { toolKey: body.toolKey, answers: body.answers } as AssessmentInput,
          { assessedOn, rates, reviewIntervalMonths: planRates.reviewIntervalMonths },
        );
        if (!outcome.ok) {
          throw problems.invalid(
            [outcome.message, ...outcome.issues.map((i) => i.message)].join(" "),
          );
        }
        const result = outcome.result;
        const history = await tx
          .select()
          .from(assessment)
          .where(and(eq(assessment.personId, personId), eq(assessment.toolKey, body.toolKey)))
          .orderBy(desc(assessment.occurredAt))
          .limit(50);
        const [previous] = currentResults(history);
        const [inserted] = await tx
          .insert(assessment)
          .values({
            ...(body.id ? { id: body.id } : {}),
            personId,
            locationId: person.locationId,
            toolKey: result.toolKey,
            toolVersion: result.toolVersion,
            answers: body.answers,
            score: result.score,
            band: result.band,
            workings: result.workings,
            triggers: result.triggers,
            details: result.details,
            nextDueOn: result.nextDueOn,
            occurredAt: times.occurredAt,
            deviceTime: times.deviceTime,
            deviceId: access.deviceId,
            lateEntry: times.lateEntry,
            clockDrift: times.clockDrift,
            recordedAfterExit,
            supersedesId: body.supersedesId ?? null,
            correctionReason: body.correctionReason ?? null,
          })
          .onConflictDoNothing()
          .returning();
        const row = replayed(
          inserted ??
            (
              await tx
                .select()
                .from(assessment)
                .where(eq(assessment.id, body.id ?? ""))
            )[0],
          personId,
        );
        if (inserted) {
          await completeAnsweredTask(tx, access, {
            taskId: body.taskId,
            personId,
            evidenceType: "assessment",
            evidenceId: row.id,
            now,
          });
          // The new result answers the scheduled repeat of the same tool.
          await completeOpenTasks(tx, {
            personId,
            kind: `care.rescreen.${result.toolKey}`,
            evidenceType: "assessment",
            evidenceId: row.id,
            actorTenantUserId: access.tenantUserId,
            now,
          });
          await raiseCareTriggers(
            tx,
            {
              personId,
              locationId: person.locationId,
              sourceType: "assessment",
              sourceId: row.id,
              occurredOn: assessedOn,
            },
            recordedAfterExit ? [] : newFollowUps(result.triggers, original),
            now,
          );
          if (
            !recordedAfterExit &&
            needsPlanReview(
              previous ? { toolKey: result.toolKey, band: previous.band } : null,
              result,
            )
          ) {
            await bringPlanReviewForward(tx, {
              personId,
              locationId: person.locationId,
              reason:
                result.toolKey === "ng249_falls"
                  ? "A fall was reported"
                  : `${TOOL_NAMES[result.toolKey]} result changed`,
              now,
            });
          }
          await audit(c, tx, access, {
            action: body.supersedesId ? "care.assessment.correct" : "care.assessment.create",
            resourceType: "assessment",
            resourceId: row.id,
            reason: body.correctionReason,
            scope: { toolKey: result.toolKey },
          });
          await publish(tx, {
            context: "care",
            aggregateType: "person",
            aggregateId: personId,
            type: "care.assessment.completed",
            payload: {
              assessmentId: row.id,
              toolKey: result.toolKey,
              supersedesId: body.supersedesId ?? null,
            },
          });
        }
        return assessmentItem(row, new Set());
      });
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/assessments",
      tags: ["care"],
      summary: "Stored validated tool results, newest first, or the current result per tool",
      security,
      request: {
        params: PersonParam,
        query: z.object({
          toolKey: AssessmentToolKey.optional(),
          /** `true`: only the latest result for each tool that no correction supersedes. */
          latest: z.enum(["true", "false"]).default("false"),
        }),
      },
      responses: {
        200: jsonBody(AssessmentList, "Results"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.plan.read");
      const { id: personId } = c.req.valid("param");
      const q = c.req.valid("query");
      const items = await withTenant(c, async (tx) => {
        await personContext(tx, personId);
        const rows = await tx
          .select()
          .from(assessment)
          .where(
            and(
              eq(assessment.personId, personId),
              q.toolKey ? eq(assessment.toolKey, q.toolKey) : undefined,
            ),
          )
          .orderBy(desc(assessment.occurredAt), desc(assessment.recordedAt))
          .limit(500);
        const superseded = supersededIds(rows);
        const shown = q.latest === "true" ? currentResults(rows) : rows;
        await audit(c, tx, access, {
          action: "care.assessment.list",
          resourceType: "person",
          resourceId: personId,
          scope: { count: shown.length, toolKey: q.toolKey ?? null, latest: q.latest === "true" },
        });
        return shown.map((r) => assessmentItem(r, superseded));
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/activities",
      tags: ["care"],
      summary: "Record an activity: attendance and engagement (group sessions per person)",
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: CreateActivityRecord } } },
      },
      responses: {
        201: jsonBody(ActivityRecordItem, "Saved (or the earlier copy of a replayed upload)"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.note.write");
      const { id: personId } = c.req.valid("param");
      const body = c.req.valid("json");
      requireCorrection(body);
      const check = checkActivity({
        format: body.format,
        groupSessionId: body.groupSessionId ?? null,
        attendance: body.attendance,
        engagement: (body.engagement ?? null) as ActivityEngagement | null,
      });
      if (!check.ok) throw problems.invalid(check.message);
      const now = new Date();
      const item = await withTenant(c, async (tx) => {
        const person = await personContext(tx, personId);
        const rates = await careRates(tx, access.tenantId, person.nation);
        const times = entryTimes(body, c.req.header(SENT_AT_HEADER), now, rates);
        // An activity is a care event (people.md rule 3): accepted after an exit only for a time
        // at or before it, flagged as recorded after it.
        const { recordedAfterExit } = requireWrite(
          await loadPerson(tx, personId),
          "care_note",
          times.occurredAt,
        );
        if (body.supersedesId) {
          const [original] = await tx
            .select({ personId: activityRecord.personId })
            .from(activityRecord)
            .where(eq(activityRecord.id, body.supersedesId));
          if (original?.personId !== personId) {
            throw problems.invalid("The entry being corrected was not found.");
          }
        }
        const [inserted] = await tx
          .insert(activityRecord)
          .values({
            ...(body.id ? { id: body.id } : {}),
            personId,
            locationId: person.locationId,
            activity: body.activity,
            format: body.format,
            groupSessionId: body.groupSessionId ?? null,
            attendance: body.attendance,
            engagement: body.engagement ?? null,
            durationMinutes: body.durationMinutes ?? null,
            notes: body.notes ?? null,
            occurredAt: times.occurredAt,
            deviceTime: times.deviceTime,
            deviceId: access.deviceId,
            lateEntry: times.lateEntry,
            clockDrift: times.clockDrift,
            recordedAfterExit,
            supersedesId: body.supersedesId ?? null,
            correctionReason: body.correctionReason ?? null,
          })
          .onConflictDoNothing()
          .returning();
        const row = replayed(
          inserted ??
            (
              await tx
                .select()
                .from(activityRecord)
                .where(eq(activityRecord.id, body.id ?? ""))
            )[0],
          personId,
        );
        if (inserted) {
          await completeAnsweredTask(tx, access, {
            taskId: body.taskId,
            personId,
            evidenceType: "activity_record",
            evidenceId: row.id,
            now,
          });
          await audit(c, tx, access, {
            action: body.supersedesId ? "care.activity.correct" : "care.activity.create",
            resourceType: "activity_record",
            resourceId: row.id,
            reason: body.correctionReason,
          });
        }
        return activityItem(row, new Set());
      });
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/activities",
      tags: ["care"],
      summary: "Activities, newest first (default: the last three days)",
      security,
      request: { params: PersonParam, query: range },
      responses: {
        200: jsonBody(ActivityRecordList, "Activities"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.note.read");
      const { id: personId } = c.req.valid("param");
      const { from, to } = window(c.req.valid("query"), new Date());
      const items = await withTenant(c, async (tx) => {
        await personContext(tx, personId);
        const rows = await tx
          .select()
          .from(activityRecord)
          .where(
            and(
              eq(activityRecord.personId, personId),
              gte(activityRecord.occurredAt, from),
              lt(activityRecord.occurredAt, to),
            ),
          )
          .orderBy(desc(activityRecord.occurredAt))
          .limit(1000);
        await audit(c, tx, access, {
          action: "care.activity.list",
          resourceType: "person",
          resourceId: personId,
          scope: { count: rows.length },
        });
        const superseded = supersededIds(rows);
        return rows.map((r) => activityItem(r, superseded));
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/visits",
      tags: ["care"],
      summary: "Record a visit, a visit out or an accompaniment (Regulation 9A)",
      description:
        "`occurredAt` is when the visit started. A restriction applied to the visit needs the reason it was necessary. A visit is late when it is recorded long after it ended.",
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: CreateVisit } } },
      },
      responses: {
        201: jsonBody(VisitItem, "Saved (or the earlier copy of a replayed upload)"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.note.write");
      const { id: personId } = c.req.valid("param");
      const body = c.req.valid("json");
      requireCorrection(body);
      const now = new Date();
      const check = checkVisit(
        {
          kind: body.kind,
          contactId: body.contactId ?? null,
          visitorName: body.visitorName ?? null,
          startedAt: new Date(body.occurredAt),
          endedAt: body.endedAt ? new Date(body.endedAt) : null,
          restrictionsApplied: body.restrictionsApplied,
          restrictionReason: body.restrictionReason ?? null,
        },
        now,
      );
      if (!check.ok) throw problems.invalid(check.message);
      const item = await withTenant(c, async (tx) => {
        const person = await personContext(tx, personId);
        // A visit is a care event (people.md rule 3), placed in time by when it began.
        const { recordedAfterExit } = requireWrite(
          await loadPerson(tx, personId),
          "care_note",
          new Date(body.occurredAt),
        );
        const rates = await careRates(tx, access.tenantId, person.nation);
        // Late means recorded long after the visit ended (or started, while it goes on).
        const times = entryTimes(
          { occurredAt: body.endedAt ?? body.occurredAt, deviceTime: body.deviceTime },
          c.req.header(SENT_AT_HEADER),
          now,
          rates,
        );
        if (body.contactId) {
          const [found] = await tx
            .select({ id: contact.id })
            .from(contact)
            .where(and(eq(contact.id, body.contactId), eq(contact.personId, personId)));
          if (!found) throw problems.invalid("The contact was not found.");
        }
        if (body.supersedesId) {
          const [original] = await tx
            .select({ personId: visitLog.personId })
            .from(visitLog)
            .where(eq(visitLog.id, body.supersedesId));
          if (original?.personId !== personId) {
            throw problems.invalid("The entry being corrected was not found.");
          }
        }
        const [inserted] = await tx
          .insert(visitLog)
          .values({
            ...(body.id ? { id: body.id } : {}),
            personId,
            locationId: person.locationId,
            kind: body.kind,
            contactId: body.contactId ?? null,
            visitorName: body.visitorName ?? null,
            visitorRelationship: body.visitorRelationship ?? null,
            endedAt: body.endedAt ? new Date(body.endedAt) : null,
            restrictionsApplied: body.restrictionsApplied,
            restrictionReason: body.restrictionReason ?? null,
            notes: body.notes ?? null,
            occurredAt: new Date(body.occurredAt),
            deviceTime: times.deviceTime,
            deviceId: access.deviceId,
            lateEntry: times.lateEntry,
            clockDrift: times.clockDrift,
            recordedAfterExit,
            supersedesId: body.supersedesId ?? null,
            correctionReason: body.correctionReason ?? null,
          })
          .onConflictDoNothing()
          .returning();
        const row = replayed(
          inserted ??
            (
              await tx
                .select()
                .from(visitLog)
                .where(eq(visitLog.id, body.id ?? ""))
            )[0],
          personId,
        );
        if (inserted) {
          await completeAnsweredTask(tx, access, {
            taskId: body.taskId,
            personId,
            evidenceType: "visit_log",
            evidenceId: row.id,
            now,
          });
          await audit(c, tx, access, {
            action: body.supersedesId ? "care.visit.correct" : "care.visit.create",
            resourceType: "visit_log",
            resourceId: row.id,
            reason: body.correctionReason,
            scope: { kind: row.kind, restrictionsApplied: row.restrictionsApplied },
          });
        }
        return visitItem(row, new Set());
      });
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/visits",
      tags: ["care"],
      summary: "The visiting log, newest first (default: the last three days)",
      security,
      request: { params: PersonParam, query: range },
      responses: { 200: jsonBody(VisitList, "Visits"), ...errorResponses, ...notFoundResponse },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.note.read");
      const { id: personId } = c.req.valid("param");
      const { from, to } = window(c.req.valid("query"), new Date());
      const items = await withTenant(c, async (tx) => {
        await personContext(tx, personId);
        const rows = await tx
          .select()
          .from(visitLog)
          .where(
            and(
              eq(visitLog.personId, personId),
              gte(visitLog.occurredAt, from),
              lt(visitLog.occurredAt, to),
            ),
          )
          .orderBy(desc(visitLog.occurredAt))
          .limit(1000);
        await audit(c, tx, access, {
          action: "care.visit.list",
          resourceType: "person",
          resourceId: personId,
          scope: { count: rows.length },
        });
        const superseded = supersededIds(rows);
        return rows.map((r) => visitItem(r, superseded));
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/advance-care",
      tags: ["care"],
      summary:
        "ReSPECT, DNACPR, ADRT and advance care plans, with the resuscitation status in force",
      security,
      request: {
        params: PersonParam,
        query: z.object({ includeInactive: z.enum(["true", "false"]).default("false") }),
      },
      responses: {
        200: jsonBody(AdvanceCareList, "Records"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.plan.read");
      const { id: personId } = c.req.valid("param");
      const { includeInactive } = c.req.valid("query");
      const list = await withTenant(c, async (tx) => {
        await personContext(tx, personId);
        const rows = await tx
          .select()
          .from(advanceCareRecord)
          .where(and(eq(advanceCareRecord.personId, personId), isNull(advanceCareRecord.deletedAt)))
          .orderBy(desc(advanceCareRecord.completedOn), desc(advanceCareRecord.createdAt));
        const today = ukIsoDate(new Date());
        const shown = includeInactive === "true" ? rows : rows.filter((r) => r.status === "active");
        await audit(c, tx, access, {
          action: "care.advance_care.list",
          resourceType: "person",
          resourceId: personId,
          scope: { count: shown.length },
        });
        return {
          items: shown.map((r) => advanceCareItem(r, today)),
          resuscitation: resuscitationStatus(rows.map(toRecordState), today),
        };
      });
      return c.json(list, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/advance-care",
      tags: ["care"],
      summary: "Record a ReSPECT plan, DNACPR decision, ADRT or advance care plan",
      description:
        "Records the clinician, the date completed, the review date and the scanned form. A new record supersedes the active one of the same kind. The signed original stays with the person.",
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: CreateAdvanceCareRecord } } },
      },
      responses: {
        201: jsonBody(AdvanceCareItem, "Recorded"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.respect.record");
      const { id: personId } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const today = ukIsoDate(now);
      const check = checkAdvanceCareRecord({
        kind: body.kind,
        cprDecision: (body.cprDecision ?? null) as CprDecision | null,
        clinicianName: body.clinicianName ?? null,
        clinicianRole: body.clinicianRole ?? null,
        completedOn: body.completedOn,
        reviewDueOn: body.reviewDueOn ?? null,
        today,
      });
      if (!check.ok) throw problems.invalid(check.issues.map((i) => i.message).join(" "));
      const item = await withTenant(c, async (tx) => {
        const person = await personContext(tx, personId);
        requireOpenRecord(person);
        await requireDocument(tx, personId, body.documentId ?? null);
        const { rows } = await tx.execute<{ id: string }>(sql`SELECT app.uuid_v7() AS id`);
        const id = rows[0]?.id;
        if (!id) throw new Error("No id generated");
        // The superseded-by link is checked at commit, so the old record can point at the new one.
        const superseded = await tx
          .update(advanceCareRecord)
          .set({ status: "superseded", supersededByRecordId: id })
          .where(
            and(
              eq(advanceCareRecord.personId, personId),
              eq(advanceCareRecord.kind, body.kind),
              eq(advanceCareRecord.status, "active"),
              isNull(advanceCareRecord.deletedAt),
            ),
          )
          .returning({ id: advanceCareRecord.id });
        const [row] = await tx
          .insert(advanceCareRecord)
          .values({
            id,
            personId,
            kind: body.kind as AdvanceCareKind,
            status: "active",
            cprDecision: check.cprDecision,
            clinicianName: body.clinicianName ?? null,
            clinicianRole: body.clinicianRole ?? null,
            completedOn: body.completedOn,
            reviewDueOn: body.reviewDueOn ?? null,
            documentId: body.documentId ?? null,
            details: body.details ?? null,
          })
          .returning();
        if (!row) throw problems.conflict();
        for (const old of superseded) {
          await completeOpenTasks(tx, {
            personId,
            kind: REVIEW_TASKS.advanceCareReview.kind,
            sourceId: old.id,
            evidenceType: "advance_care_record",
            evidenceId: row.id,
            actorTenantUserId: access.tenantUserId,
            now,
          });
        }
        await bringPlanReviewForward(tx, {
          personId,
          locationId: person.locationId,
          reason: "Advance care record changed",
          now,
        });
        await audit(c, tx, access, {
          action: "care.advance_care.create",
          resourceType: "advance_care_record",
          resourceId: row.id,
          scope: { kind: row.kind, supersededRecordIds: superseded.map((s) => s.id) },
        });
        return advanceCareItem(row, today);
      });
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/people/{id}/advance-care/{recordId}",
      tags: ["care"],
      summary:
        "Change the review date, clinician or form of a record, or withdraw it with the reason",
      description: "A changed CPR decision is a new record, which supersedes this one.",
      security,
      request: {
        params: RecordParams,
        body: { content: { "application/json": { schema: UpdateAdvanceCareRecord } } },
      },
      responses: {
        200: jsonBody(AdvanceCareItem, "Saved"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.respect.record");
      const { id: personId, recordId } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const today = ukIsoDate(now);
      const item = await withTenant(c, async (tx) => {
        const person = await personContext(tx, personId);
        requireOpenRecord(person);
        const [current] = await tx
          .select()
          .from(advanceCareRecord)
          .where(and(eq(advanceCareRecord.id, recordId), isNull(advanceCareRecord.deletedAt)));
        if (current?.personId !== personId) throw problems.notFound();
        if (current.status !== "active") {
          throw problems.invalid("Only a record in force can change; this one is kept as history.");
        }
        if (current.version !== body.version) throw problems.conflict();
        const withdrawing = body.withdrawnReason !== undefined;
        let values: Partial<typeof advanceCareRecord.$inferInsert>;
        if (withdrawing) {
          const check = checkWithdrawal(body.withdrawnReason);
          if (!check.ok) throw problems.invalid(check.message);
          values = { status: "withdrawn", withdrawnAt: now, withdrawnReason: body.withdrawnReason };
        } else {
          values = {
            ...(body.clinicianName !== undefined ? { clinicianName: body.clinicianName } : {}),
            ...(body.clinicianRole !== undefined ? { clinicianRole: body.clinicianRole } : {}),
            ...(body.reviewDueOn !== undefined ? { reviewDueOn: body.reviewDueOn } : {}),
            ...(body.documentId !== undefined ? { documentId: body.documentId } : {}),
            ...(body.details !== undefined ? { details: body.details } : {}),
          };
          const check = checkAdvanceCareRecord({
            kind: current.kind as AdvanceCareKind,
            cprDecision: current.cprDecision as CprDecision | null,
            clinicianName: values.clinicianName ?? current.clinicianName,
            clinicianRole: values.clinicianRole ?? current.clinicianRole,
            completedOn: current.completedOn,
            reviewDueOn:
              values.reviewDueOn !== undefined ? values.reviewDueOn : current.reviewDueOn,
            today: current.completedOn > today ? current.completedOn : today,
          });
          if (!check.ok) throw problems.invalid(check.issues.map((i) => i.message).join(" "));
          await requireDocument(tx, personId, values.documentId ?? null);
        }
        const [row] = await tx
          .update(advanceCareRecord)
          .set(values)
          .where(
            and(eq(advanceCareRecord.id, recordId), eq(advanceCareRecord.version, body.version)),
          )
          .returning();
        if (!row) throw problems.conflict();
        await completeOpenTasks(tx, {
          personId,
          kind: REVIEW_TASKS.advanceCareReview.kind,
          sourceId: row.id,
          evidenceType: "advance_care_record",
          evidenceId: row.id,
          actorTenantUserId: access.tenantUserId,
          now,
        });
        await audit(c, tx, access, {
          action: withdrawing ? "care.advance_care.withdraw" : "care.advance_care.update",
          resourceType: "advance_care_record",
          resourceId: row.id,
          reason: withdrawing ? body.withdrawnReason : undefined,
        });
        return advanceCareItem(row, today);
      });
      return c.json(item, 200);
    },
  );
