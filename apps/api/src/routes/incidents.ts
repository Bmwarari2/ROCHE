import {
  AnswerClassifier,
  type CandourItem,
  CandourStep,
  CandourView,
  ClassifierState,
  CloseIncident,
  CreateIncident,
  IncidentDetail,
  IncidentList,
  type IncidentPersonInput,
  IncidentStatus,
  IncidentType,
  type InvestigationItem,
  InvestigationView,
  ReviewIncident,
  UpdateCandour,
  UpdateIncident,
  UpdateInvestigation,
} from "@harbour/contracts";
import {
  bodyMapMark,
  candourRecord,
  classifierAnswer,
  document,
  incident,
  incidentPerson,
  investigation,
  location,
  statutoryNotification,
  type Transaction,
  task,
} from "@harbour/db";
import {
  CANDOUR_WORKFLOW,
  type CandourRecordView,
  type CandourState,
  type ClassifierQuestionKey,
  candourClocks,
  candourStepProblems,
  classifierAnswerProblem,
  INCIDENT_WORKFLOW,
  type IncidentNation,
  incidentCloseProblems,
  type NotificationStatus,
  ukDayBounds,
  ukIsoDate,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx } from "../http/audit";
import {
  type AppEnv,
  mfaRefusal,
  requirePermission,
  type TenantAccess,
  withTenant,
} from "../http/context";
import { problems } from "../http/problem";
import { publish } from "../outbox";
import { careRates, entryTimes, personContext } from "../services/care";
import { CLOCK_DRIFT_RATE_KEY, loadPerson, requireWrite } from "../services/people";
import { bankHolidays, rateNumber } from "../services/rates";
import {
  classifyAndStore,
  safetyRates,
  toClassifierAnswers,
  withTenantWideScope,
} from "../services/safety";
import { mayBeGiven } from "../services/tasks";
import { startWorkflow } from "../services/workflow";
import { iso, range, SENT_AT_HEADER, withLateEntryReview } from "./care-shared";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import {
  classifierView,
  incidentDetail,
  incidentSummaries,
  managesAt,
  managesIncident,
  mayChange,
  readIncident,
} from "./safety-shared";
import { moveOrRefuse } from "./workflow-shared";

/**
 * Incidents (master prompt 11.1; docs/specs/safety.md; register rows SAFE-001, SAFE-002,
 * SAFE-007, SAFE-009, SAFE-010; hazards HZ-013 and HZ-027). Capture works offline: a device id
 * makes a replayed upload a no-op, and every clock starts at `occurred_at`. The classifier runs on
 * the server whenever an incident is created, changed or answered. Reads and writes are audited
 * by record id, never content.
 */

const IncidentParam = z.object({ id: z.uuid() });

/** Questions a reporter answers at the point of care; the rest need `safety.incident.manage`. */
const POINT_OF_CARE_QUESTIONS: readonly ClassifierQuestionKey[] = [
  "falls.head_injury",
  "falls.anticoagulant",
];

/** Why an investigation action with an owner and a date cannot become that owner's task. */
const ACTION_OWNER_REFUSED =
  "The action's owner cannot be given its task: they do not manage incidents at this location.";

type CandourRow = typeof candourRecord.$inferSelect;
type InvestigationRow = typeof investigation.$inferSelect;

function audit(
  c: Context<AppEnv>,
  tx: Transaction,
  access: TenantAccess,
  input: Parameters<typeof auditInTx>[2],
) {
  return auditInTx(tx, access, { ...input, requestId: c.get("requestId") });
}

function dbCode(error: unknown): string | undefined {
  return (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
}

const onForeignKey = (what: string) => (error: unknown) => {
  if (dbCode(error) === "23503") throw problems.invalid(`The ${what} was not found.`);
  throw error;
};

/**
 * Answers must be valid, and a reporter may answer only the point-of-care questions; the others
 * need `safety.incident.manage` where the incident is (`manages`, ADR-0071).
 */
function checkAnswers(
  manages: boolean,
  answers: readonly { key: ClassifierQuestionKey; value: unknown }[],
) {
  for (const answer of answers) {
    if (!manages && !POINT_OF_CARE_QUESTIONS.includes(answer.key)) throw problems.forbidden();
    const problem = classifierAnswerProblem(
      answer.key,
      answer.value as Parameters<typeof classifierAnswerProblem>[1],
    );
    if (problem) throw problems.invalid(`${answer.key}: ${problem}`);
  }
}

/** A person on an incident: someone the reporter can see, with marks from their own body map. */
/**
 * A person on an incident. A person using the service follows people.md rule 3 like any care
 * event (HZ-006): an incident at or before their discharge, death or move away (within the clock
 * tolerance) is accepted; a later one is refused with a review task for the nurse in charge.
 */
async function checkPerson(
  tx: Transaction,
  p: IncidentPersonInput,
  when: { readonly occurredAt: Date; readonly toleranceMinutes: number },
) {
  if (p.kind === "service_user") {
    if (!p.personId) throw problems.invalid("Choose the person using the service.");
    await personContext(tx, p.personId);
    requireWrite(
      await loadPerson(tx, p.personId),
      "incident",
      when.occurredAt,
      when.toleranceMinutes,
    );
  } else if (p.personId) {
    throw problems.invalid("Only a person using the service is chosen from the records.");
  }
  if (p.kind === "worker" && !p.tenantUserId && !p.otherName) {
    throw problems.invalid("Say which member of staff, or give the worker's name.");
  }
  if (p.kind === "other_not_at_work" && !p.otherName) {
    throw problems.invalid("Give the name of the visitor or other person.");
  }
  if (p.bodyMapMarkIds.length > 0) {
    if (!p.personId) throw problems.invalid("Body-map marks belong to a person using the service.");
    const marks = await tx
      .select({ personId: bodyMapMark.personId })
      .from(bodyMapMark)
      .where(inArray(bodyMapMark.id, p.bodyMapMarkIds));
    if (
      marks.length !== new Set(p.bodyMapMarkIds).size ||
      marks.some((m) => m.personId !== p.personId)
    ) {
      throw problems.invalid("A body-map mark was not found on this person's body map.");
    }
  }
}

function personValues(p: IncidentPersonInput) {
  return {
    kind: p.kind,
    role: p.role,
    personId: p.kind === "service_user" ? (p.personId ?? null) : null,
    tenantUserId: p.kind === "worker" ? (p.tenantUserId ?? null) : null,
    otherName: p.otherName ?? null,
    injuryDetails: p.injuryDetails ?? null,
    died: p.died,
    learningDisability: p.learningDisability ?? null,
    autistic: p.autistic ?? null,
    subjectToMentalHealthAct: p.subjectToMentalHealthAct ?? null,
    bodyMapMarkIds: p.bodyMapMarkIds,
    infection: p.infection ?? null,
  };
}

/** An incident about a person is part of their care record: MFA applies (section 5.3). */
function requireMfaForPeople(access: TenantAccess, people: number) {
  if (people > 0 && !access.mfaSatisfied) throw mfaRefusal(access);
}

async function loadForChange(c: Context<AppEnv>, tx: Transaction, incidentId: string) {
  const access = c.get("access");
  const found = await readIncident(tx, incidentId);
  requireMfaForPeople(access, found.row.personIds.length);
  if (!(await mayChange(tx, access, found.row))) throw problems.forbidden();
  if (found.restricted) {
    throw problems.forbidden();
  }
  return found;
}

/** The candour record's times say when something was done, so none may be later than now. */
function candourTimeProblems(body: UpdateCandour, now: Date) {
  const future = (iso: string | null | undefined) => Boolean(iso && new Date(iso) > now);
  if (future(body.verbal?.at)) {
    throw problems.invalid("The time they were told cannot be in the future.");
  }
  if (future(body.written?.sentAt)) {
    throw problems.invalid("The time the written notification was sent cannot be in the future.");
  }
  if ((body.contactAttempts ?? []).some((a) => future(a.at))) {
    throw problems.invalid("The time of an attempt to contact them cannot be in the future.");
  }
  if (future(body.enquiryResultsSharedAt)) {
    throw problems.invalid("The time the results were shared cannot be in the future.");
  }
}

/**
 * Every document the candour record cites (the written record of the conversation, the written
 * notification's copy, the correspondence) must be a document about the relevant person that the
 * caller can see (review L5).
 */
async function checkCandourDocuments(
  tx: Transaction,
  body: UpdateCandour,
  personId: string | null,
) {
  const ids = [
    ...(body.verbal?.writtenRecordId ? [body.verbal.writtenRecordId] : []),
    ...(body.written?.documentId ? [body.written.documentId] : []),
    ...(body.correspondenceDocumentIds ?? []),
  ];
  if (ids.length === 0) return;
  const unique = [...new Set(ids)];
  const found = personId
    ? await tx
        .select({ id: document.id })
        .from(document)
        .where(
          and(
            inArray(document.id, unique),
            eq(document.personId, personId),
            isNull(document.deletedAt),
          ),
        )
    : [];
  if (found.length !== unique.length) {
    throw problems.invalid("A document cited must be on the relevant person's record.");
  }
}

// ------------------------------------------------------------------------------------------------
// Candour and investigation output
// ------------------------------------------------------------------------------------------------

function candourView(row: CandourRow): CandourRecordView {
  const verbal = row.verbal as CandourItem["verbal"];
  const written = row.written as CandourItem["written"];
  return {
    threshold:
      row.thresholdNotifiable === null || !row.thresholdDecidedAt
        ? null
        : {
            notifiable: row.thresholdNotifiable,
            decidedAt: row.thresholdDecidedAt,
            decidedBy: row.thresholdDecidedBy ?? "",
          },
    verbal: verbal ? { ...verbal, at: new Date(verbal.at) } : null,
    contactAttempts: (row.contactAttempts as { at: string; note: string }[]).map((a) => ({
      at: new Date(a.at),
      note: a.note,
    })),
    written: written ? { ...written, sentAt: new Date(written.sentAt) } : null,
    enquiryResultsSharedAt: row.enquiryResultsSharedAt,
    correspondenceDocumentIds: row.correspondenceDocumentIds,
  };
}

async function candourItem(
  tx: Transaction,
  tenantId: string,
  row: CandourRow,
  occurredAt: Date,
  nation: IncidentNation,
): Promise<CandourItem> {
  const rates = await safetyRates(tx, tenantId, ukIsoDate(occurredAt));
  const decidedAt = row.thresholdNotifiable === true ? (row.thresholdDecidedAt ?? null) : null;
  const clocks = candourClocks(occurredAt, decidedAt, rates, await bankHolidays(tx, nation));
  return {
    id: row.id,
    incidentId: row.incidentId,
    personId: row.personId,
    state: row.state as CandourItem["state"],
    threshold:
      row.thresholdNotifiable === null || !row.thresholdDecidedAt
        ? null
        : {
            notifiable: row.thresholdNotifiable,
            decidedAt: row.thresholdDecidedAt.toISOString(),
            decidedBy: row.thresholdDecidedBy ?? "",
          },
    verbal: (row.verbal ?? null) as CandourItem["verbal"],
    contactAttempts: row.contactAttempts as CandourItem["contactAttempts"],
    written: (row.written ?? null) as CandourItem["written"],
    enquiryResultsSharedAt: iso(row.enquiryResultsSharedAt),
    correspondenceDocumentIds: row.correspondenceDocumentIds,
    outcome: row.outcome,
    clocks: {
      verbalDueAt: clocks.verbalDueAt.toISOString(),
      writtenTargetAt: clocks.writtenTargetAt.toISOString(),
      writtenTargetWording: clocks.writtenTargetWording,
      provisional: clocks.provisional,
    },
    version: row.version,
  };
}

function investigationItem(row: InvestigationRow): InvestigationItem {
  return {
    id: row.id,
    incidentId: row.incidentId,
    leadTenantUserId: row.leadTenantUserId,
    method: (row.method ?? null) as InvestigationItem["method"],
    findings: row.findings,
    contributingFactors: row.contributingFactors,
    actions: row.actions as InvestigationItem["actions"],
    lessons: row.lessons,
    bulletinPublishedAt: iso(row.bulletinPublishedAt),
    status: row.status as InvestigationItem["status"],
    completedAt: iso(row.completedAt),
    version: row.version,
  };
}

async function nationOf(tx: Transaction, locationId: string): Promise<IncidentNation> {
  const [row] = await tx
    .select({ nation: location.nation })
    .from(location)
    .where(eq(location.id, locationId));
  if (!row) throw problems.invalid("The location was not found.");
  return row.nation;
}

// ------------------------------------------------------------------------------------------------
// Routes
// ------------------------------------------------------------------------------------------------

export const incidentsRouter = createRouter()
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/incidents",
      tags: ["safety"],
      summary: "Record an incident or near miss (works for an offline upload)",
      description:
        "A device-generated id makes a replayed upload return the earlier copy without side effects. The classifier runs on the server: drafts with clocks from occurred_at (never the sync time), provisional drafts for 'not sure', a task for unanswered questions, and the post-fall checklist for a fall (HZ-013, HZ-027). Publishes safety.incident.recorded.",
      security,
      request: { body: { content: { "application/json": { schema: CreateIncident } } } },
      responses: {
        201: jsonBody(IncidentDetail, "Recorded (or the earlier copy of a replayed upload)"),
        ...errorResponses,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "safety.incident.report");
      const body = c.req.valid("json");
      const now = new Date();
      requireMfaForPeople(access, body.people.filter((p) => p.kind === "service_user").length);
      checkAnswers(managesAt(access, body.locationId), body.answers);
      const detail = await withLateEntryReview(
        c,
        { kind: "incident", clientId: body.id, occurredAt: body.occurredAt },
        () =>
          withTenant(c, async (tx) => {
            if (body.id) {
              const [replayed] = await tx
                .select({ id: incident.id })
                .from(incident)
                .where(eq(incident.id, body.id));
              if (replayed) return incidentDetail(tx, replayed.id, now);
            }
            const nation = await nationOf(tx, body.locationId);
            const rates = await careRates(tx, access.tenantId, nation);
            const times = entryTimes(body, c.req.header(SENT_AT_HEADER), now, rates);
            if (body.foundAt && new Date(body.foundAt) < times.occurredAt) {
              throw problems.invalid("The person cannot be found before the incident happened.");
            }
            for (const p of body.people) {
              await checkPerson(tx, p, {
                occurredAt: times.occurredAt,
                toleranceMinutes: rates.clockDriftMinutes,
              });
            }
            const personIds = body.people.flatMap((p) =>
              p.kind === "service_user" && p.personId ? [p.personId] : [],
            );
            if (new Set(personIds).size !== personIds.length) {
              throw problems.invalid("Each person is added to an incident once.");
            }
            const [row] = await tx
              .insert(incident)
              .values({
                ...(body.id ? { id: body.id } : {}),
                locationId: body.locationId,
                type: body.type,
                occurredAt: times.occurredAt,
                deviceTime: times.deviceTime,
                deviceId: access.deviceId,
                lateEntry: times.lateEntry,
                clockDrift: times.clockDrift,
                foundAt: body.foundAt ? new Date(body.foundAt) : null,
                severity: body.severity ?? null,
                harmGrade: body.harmGrade ?? null,
                description: body.description,
                immediateActions: body.immediateActions ?? null,
                emergencyServicesCalled: body.emergencyServicesCalled,
                gpContacted: body.gpContacted,
                contactNotes: body.contactNotes ?? null,
                familyInformedWho: body.familyInformed?.who ?? null,
                familyInformedAt: body.familyInformed ? new Date(body.familyInformed.at) : null,
                raisedBy: access.tenantUserId,
                personIds,
              })
              .onConflictDoNothing()
              .returning();
            if (!row) throw problems.invalid("That id is already used.");
            for (const p of body.people) {
              await tx
                .insert(incidentPerson)
                .values({ incidentId: row.id, ...personValues(p) })
                .catch(onForeignKey("member of staff"));
            }
            for (const answer of body.answers) {
              await tx.insert(classifierAnswer).values({
                incidentId: row.id,
                questionKey: answer.key,
                value: answer.value,
                answeredAt: now,
                answeredBy: access.tenantUserId,
                deviceId: access.deviceId,
              });
            }
            await startWorkflow(
              tx,
              access.tenantId,
              INCIDENT_WORKFLOW,
              { subjectType: "incident", subjectId: row.id, personId: null },
              now,
            );
            const outcome = await classifyAndStore(tx, {
              tenantId: access.tenantId,
              incidentId: row.id,
              actorTenantUserId: access.tenantUserId,
              now,
            });
            await publish(tx, {
              context: "safety",
              aggregateType: "incident",
              aggregateId: row.id,
              type: "safety.incident.recorded",
              payload: {
                incidentId: row.id,
                type: row.type,
                locationId: row.locationId,
                occurredAt: row.occurredAt.toISOString(),
                lateEntry: row.lateEntry,
                notificationsDrafted: outcome.notificationsCreated,
              },
            });
            await audit(c, tx, access, {
              action: "safety.incident.create",
              resourceType: "incident",
              resourceId: row.id,
              scope: { type: row.type, people: personIds.length },
            });
            return incidentDetail(tx, row.id, now);
          }),
      );
      return c.json(detail, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/incidents",
      tags: ["safety"],
      summary: "Incidents in your scope, newest first",
      description:
        "An incident is listed when you can see one of its people, you raised it, or it involves nobody using the service and happened at one of your locations. When it involves people outside your scope it is marked restricted.",
      security,
      request: {
        query: range.extend({
          status: IncidentStatus.optional(),
          type: IncidentType.optional(),
          locationId: z.uuid().optional(),
          personId: z.uuid().optional(),
        }),
      },
      responses: { 200: jsonBody(IncidentList, "Incidents"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, "safety.incident.read");
      const q = c.req.valid("query");
      const items = await withTenant(c, async (tx) => {
        const rows = await tx
          .select()
          .from(incident)
          .where(
            and(
              isNull(incident.deletedAt),
              q.status ? eq(incident.status, q.status) : undefined,
              q.type ? eq(incident.type, q.type) : undefined,
              q.locationId ? eq(incident.locationId, q.locationId) : undefined,
              q.personId ? sql`${incident.personIds} @> ARRAY[${q.personId}]::uuid[]` : undefined,
              q.from ? gte(incident.occurredAt, new Date(q.from)) : undefined,
              q.to ? lt(incident.occurredAt, new Date(q.to)) : undefined,
            ),
          )
          .orderBy(desc(incident.occurredAt))
          .limit(500);
        await audit(c, tx, access, {
          action: "safety.incident.list",
          scope: { count: rows.length },
        });
        return incidentSummaries(tx, rows);
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/incidents/{id}",
      tags: ["safety"],
      summary: "One incident, its people in your scope, and its notifications and clocks",
      security,
      request: { params: IncidentParam },
      responses: {
        200: jsonBody(IncidentDetail, "Incident"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "safety.incident.read");
      const { id } = c.req.valid("param");
      const detail = await withTenant(c, async (tx) => {
        const out = await incidentDetail(tx, id, new Date());
        await audit(c, tx, access, {
          action: "safety.incident.view",
          resourceType: "incident",
          resourceId: id,
          scope: { restricted: out.restricted },
        });
        return out;
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/incidents/{id}",
      tags: ["safety"],
      summary: "Add to or correct an incident (the classifier runs again)",
      description:
        "The person who raised it, or a holder of safety.incident.manage, may change an open incident whose people are all in their scope.",
      security,
      request: {
        params: IncidentParam,
        body: { content: { "application/json": { schema: UpdateIncident } } },
      },
      responses: {
        200: jsonBody(IncidentDetail, "Updated"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "safety.incident.report");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const detail = await withLateEntryReview(c, { kind: "incident", clientId: id }, () =>
        withTenant(c, async (tx) => {
          const { row, people } = await loadForChange(c, tx, id);
          if (row.version !== body.version) throw problems.conflict();
          if (row.status === "closed")
            throw problems.invalid("A closed incident cannot be changed.");
          if (body.foundAt && new Date(body.foundAt) < row.occurredAt) {
            throw problems.invalid("The person cannot be found before the incident happened.");
          }
          const changes = body.people ?? [];
          const toleranceMinutes = await rateNumber(tx, access.tenantId, CLOCK_DRIFT_RATE_KEY);
          for (const p of changes.filter((p) => !p.removed)) {
            await checkPerson(tx, p, { occurredAt: row.occurredAt, toleranceMinutes });
          }
          const removed = new Set(changes.filter((p) => p.removed && p.id).map((p) => p.id));
          const kept = people.filter((p) => !removed.has(p.id));
          const personIds = [
            ...new Set([
              ...kept.flatMap((p) => {
                const change = changes.find((x) => x.id === p.id);
                const personId = change ? change.personId : p.personId;
                return personId && (change ? change.kind : p.kind) === "service_user"
                  ? [personId]
                  : [];
              }),
              ...changes
                .filter((p) => !p.id && !p.removed && p.kind === "service_user" && p.personId)
                .map((p) => p.personId as string),
            ]),
          ];
          const [updated] = await tx
            .update(incident)
            .set({
              ...(body.severity !== undefined ? { severity: body.severity } : {}),
              ...(body.harmGrade !== undefined ? { harmGrade: body.harmGrade } : {}),
              ...(body.description !== undefined ? { description: body.description } : {}),
              ...(body.immediateActions !== undefined
                ? { immediateActions: body.immediateActions }
                : {}),
              ...(body.foundAt !== undefined
                ? { foundAt: body.foundAt ? new Date(body.foundAt) : null }
                : {}),
              ...(body.emergencyServicesCalled !== undefined
                ? { emergencyServicesCalled: body.emergencyServicesCalled }
                : {}),
              ...(body.gpContacted !== undefined ? { gpContacted: body.gpContacted } : {}),
              ...(body.contactNotes !== undefined ? { contactNotes: body.contactNotes } : {}),
              ...(body.familyInformed !== undefined
                ? {
                    familyInformedWho: body.familyInformed?.who ?? null,
                    familyInformedAt: body.familyInformed ? new Date(body.familyInformed.at) : null,
                  }
                : {}),
              // People are listed before their rows are written (the listing trigger checks this).
              personIds: [...new Set([...row.personIds, ...personIds])],
            })
            .where(and(eq(incident.id, id), eq(incident.version, body.version)))
            .returning();
          if (!updated) throw problems.conflict();
          for (const change of changes) {
            if (change.id) {
              const existing = people.find((p) => p.id === change.id);
              if (!existing) throw problems.invalid("That person is not on this incident.");
              await tx
                .update(incidentPerson)
                .set(change.removed ? { deletedAt: now } : personValues(change))
                .where(eq(incidentPerson.id, change.id))
                .catch(onForeignKey("member of staff"));
            } else if (!change.removed) {
              await tx
                .insert(incidentPerson)
                .values({ incidentId: id, ...personValues(change) })
                .catch(onForeignKey("member of staff"));
            }
          }
          if (personIds.length !== updated.personIds.length) {
            await tx.update(incident).set({ personIds }).where(eq(incident.id, id));
          }
          await classifyAndStore(tx, {
            tenantId: access.tenantId,
            incidentId: id,
            actorTenantUserId: access.tenantUserId,
            now,
          });
          await audit(c, tx, access, {
            action: "safety.incident.update",
            resourceType: "incident",
            resourceId: id,
            scope: { peopleChanged: changes.length },
          });
          return incidentDetail(tx, id, now);
        }),
      );
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/incidents/{id}/review",
      tags: ["safety"],
      summary: "Move an incident under review, or back to open with a reason",
      security,
      request: {
        params: IncidentParam,
        body: { content: { "application/json": { schema: ReviewIncident } } },
      },
      responses: {
        200: jsonBody(IncidentDetail, "Moved"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "safety.incident.manage");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const detail = await withTenant(c, async (tx) => {
        const { row } = await loadForChange(c, tx, id);
        if (row.version !== body.version) throw problems.conflict();
        await moveOrRefuse(
          c,
          tx,
          INCIDENT_WORKFLOW,
          { subjectType: "incident", subjectId: id, personId: null },
          body.to,
          body.reason,
          now,
        );
        const [updated] = await tx
          .update(incident)
          .set({ status: body.to })
          .where(and(eq(incident.id, id), eq(incident.version, body.version)))
          .returning();
        if (!updated) throw problems.conflict();
        await audit(c, tx, access, {
          action: `safety.incident.${body.to}`,
          resourceType: "incident",
          resourceId: id,
        });
        return incidentDetail(tx, id, now);
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/incidents/{id}/close",
      tags: ["safety"],
      summary: "Close an incident (someone other than the person who raised it)",
      description:
        "Refused while a notification is a draft or ready, a classifier question is open, the duty of candour may apply and no candour record has finished, the candour record is open, or more than one person we support was affected by a notifiable incident (one candour record covers one person) (incidentCloseProblems); and refused to the person who raised it (separation of duties, safety.md rule 11).",
      security,
      request: {
        params: IncidentParam,
        body: { content: { "application/json": { schema: CloseIncident } } },
      },
      responses: {
        200: jsonBody(IncidentDetail, "Closed"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "safety.incident.manage");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const detail = await withTenant(c, async (tx) => {
        const { row } = await loadForChange(c, tx, id);
        if (row.version !== body.version) throw problems.conflict();
        // Every notification and the candour record count, including ones about people the
        // closer cannot see.
        const blockers = await withTenantWideScope(tx, async () => {
          const notifications = await tx
            .select({
              kind: statutoryNotification.kind,
              status: statutoryNotification.status,
              noLongerIndicated: statutoryNotification.noLongerIndicated,
            })
            .from(statutoryNotification)
            .where(
              and(
                eq(statutoryNotification.incidentId, id),
                isNull(statutoryNotification.deletedAt),
              ),
            );
          const [candour] = await tx
            .select({
              state: candourRecord.state,
              notifiable: candourRecord.thresholdNotifiable,
              personId: candourRecord.personId,
            })
            .from(candourRecord)
            .where(eq(candourRecord.incidentId, id));
          // The duty of candour applies to the people we support affected by the incident; one
          // candour record covers one of them (HZ-013, review H1 and H2).
          const affected = await tx
            .select({ personId: incidentPerson.personId })
            .from(incidentPerson)
            .where(
              and(
                eq(incidentPerson.incidentId, id),
                eq(incidentPerson.kind, "service_user"),
                eq(incidentPerson.role, "affected"),
                isNull(incidentPerson.deletedAt),
              ),
            );
          const stored = row.classifierResult as { outputs?: { kind: string }[] } | null;
          return incidentCloseProblems({
            notifications: notifications.map((n) => ({
              kind: n.kind,
              status: n.status as NotificationStatus,
            })),
            openQuestions: row.openQuestions,
            candourState: candour?.state ?? null,
            candour: {
              indicated:
                (stored?.outputs ?? []).some((o) => o.kind === "candour") ||
                notifications.some(
                  (n) =>
                    n.kind === "candour" && n.status !== "not_required" && !n.noLongerIndicated,
                ),
              notifiable: candour?.notifiable ?? null,
              personId: candour?.personId ?? null,
              people: [...new Set(affected.flatMap((p) => (p.personId ? [p.personId] : [])))],
            },
          });
        });
        if (blockers.length > 0) throw problems.invalid(blockers.join(" "));
        await moveOrRefuse(
          c,
          tx,
          INCIDENT_WORKFLOW,
          { subjectType: "incident", subjectId: id, personId: null },
          "closed",
          body.reason,
          now,
        );
        const [updated] = await tx
          .update(incident)
          .set({
            status: "closed",
            closedBy: access.tenantUserId,
            closedAt: now,
            closedReason: body.reason,
          })
          .where(and(eq(incident.id, id), eq(incident.version, body.version)))
          .returning();
        if (!updated) throw problems.conflict();
        await audit(c, tx, access, {
          action: "safety.incident.close",
          resourceType: "incident",
          resourceId: id,
        });
        return incidentDetail(tx, id, now);
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/incidents/{id}/classifier",
      tags: ["safety"],
      summary: "The classifier's answers so far and its last result, with open questions",
      security,
      request: { params: IncidentParam },
      responses: {
        200: jsonBody(ClassifierState, "Classifier"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "safety.incident.read");
      const { id } = c.req.valid("param");
      const now = new Date();
      const state = await withTenant(c, async (tx) => {
        const { row, restricted } = await readIncident(tx, id);
        if (restricted) throw problems.forbidden();
        const answers = await tx
          .select()
          .from(classifierAnswer)
          .where(eq(classifierAnswer.incidentId, id))
          .orderBy(asc(classifierAnswer.answeredAt));
        const notifications = await tx
          .select()
          .from(statutoryNotification)
          .where(eq(statutoryNotification.incidentId, id))
          .orderBy(asc(statutoryNotification.dueAt));
        await audit(c, tx, access, {
          action: "safety.incident.classifier.view",
          resourceType: "incident",
          resourceId: id,
        });
        return {
          answers: answers.map((a) => ({
            id: a.id,
            key: a.questionKey as ClassifierQuestionKey,
            value: a.value as ClassifierState["answers"][number]["value"],
            answeredAt: a.answeredAt.toISOString(),
            answeredBy: a.answeredBy,
          })),
          result: classifierView(row, notifications, now),
        };
      });
      return c.json(state, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/incidents/{id}/classifier",
      tags: ["safety"],
      summary: "Answer notification questions; returns the required outputs and their due times",
      description:
        "Answers are append-only (the latest per question counts). 'Not sure' drafts a provisional notification so its clock shows. Without safety.incident.manage only the point-of-care falls questions may be answered.",
      security,
      request: {
        params: IncidentParam,
        body: { content: { "application/json": { schema: AnswerClassifier } } },
      },
      responses: {
        200: jsonBody(ClassifierState, "Answered and classified"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "safety.incident.report");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      checkAnswers(await withTenant(c, (tx) => managesIncident(tx, access, id)), body.answers);
      const now = new Date();
      const state = await withTenant(c, async (tx) => {
        const { row } = await loadForChange(c, tx, id);
        if (row.status === "closed") throw problems.invalid("A closed incident cannot be changed.");
        for (const answer of body.answers) {
          await tx.insert(classifierAnswer).values({
            incidentId: id,
            questionKey: answer.key,
            value: answer.value,
            answeredAt: now,
            answeredBy: access.tenantUserId,
            deviceId: access.deviceId,
          });
        }
        await classifyAndStore(tx, {
          tenantId: access.tenantId,
          incidentId: id,
          actorTenantUserId: access.tenantUserId,
          now,
        });
        await audit(c, tx, access, {
          action: "safety.incident.classifier.answer",
          resourceType: "incident",
          resourceId: id,
          scope: { answers: body.answers.length },
        });
        const answers = await tx
          .select()
          .from(classifierAnswer)
          .where(eq(classifierAnswer.incidentId, id))
          .orderBy(asc(classifierAnswer.answeredAt));
        const [fresh] = await tx.select().from(incident).where(eq(incident.id, id));
        const notifications = await tx
          .select()
          .from(statutoryNotification)
          .where(eq(statutoryNotification.incidentId, id))
          .orderBy(asc(statutoryNotification.dueAt));
        return {
          answers: toClassifierAnswers(answers).map((a, i) => ({
            id: answers[i]?.id ?? "",
            key: a.key,
            value: a.value as ClassifierState["answers"][number]["value"],
            answeredAt: a.answeredAt.toISOString(),
            answeredBy: answers[i]?.answeredBy ?? null,
          })),
          result: fresh ? classifierView(fresh, notifications, now) : null,
        };
      });
      return c.json(state, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/incidents/{id}/candour",
      tags: ["safety"],
      summary: "The duty of candour record and its clocks (regulation 20)",
      security,
      request: { params: IncidentParam },
      responses: { 200: jsonBody(CandourView, "Candour"), ...errorResponses, ...notFoundResponse },
    }),
    async (c) => {
      const access = await requirePermission(c, "safety.incident.read");
      const { id } = c.req.valid("param");
      const view = await withTenant(c, async (tx) => {
        const { row, restricted } = await readIncident(tx, id);
        if (restricted) throw problems.forbidden();
        const [record] = await tx
          .select()
          .from(candourRecord)
          .where(eq(candourRecord.incidentId, id));
        await audit(c, tx, access, {
          action: "safety.candour.view",
          resourceType: "incident",
          resourceId: id,
        });
        return {
          record: record
            ? await candourItem(
                tx,
                access.tenantId,
                record,
                row.occurredAt,
                await nationOf(tx, row.locationId),
              )
            : null,
        };
      });
      return c.json(view, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/incidents/{id}/candour",
      tags: ["safety"],
      summary: "Record the candour threshold decision, notifications, enquiries and correspondence",
      description:
        "Version 0 starts the record. The threshold decision wins over the classifier's answers, so recording it classifies the incident again (ADR-0021 written target from the decision).",
      security,
      request: {
        params: IncidentParam,
        body: { content: { "application/json": { schema: UpdateCandour } } },
      },
      responses: {
        200: jsonBody(CandourView, "Saved"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "safety.incident.manage");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const view = await withTenant(c, async (tx) => {
        const { row } = await loadForChange(c, tx, id);
        if (body.personId && !row.personIds.includes(body.personId)) {
          throw problems.invalid("The relevant person must be on the incident.");
        }
        if (body.threshold && new Date(body.threshold.decidedAt) > now) {
          throw problems.invalid("The decision cannot be dated in the future.");
        }
        if (body.threshold && new Date(body.threshold.decidedAt) < row.occurredAt) {
          throw problems.invalid("The decision cannot be dated before the incident happened.");
        }
        candourTimeProblems(body, now);
        let [record] = await tx
          .select()
          .from(candourRecord)
          .where(eq(candourRecord.incidentId, id))
          .for("update");
        if ((record?.version ?? 0) !== body.version) throw problems.conflict();
        if (!record) {
          [record] = await tx.insert(candourRecord).values({ incidentId: id }).returning();
          if (!record) throw problems.conflict();
          await startWorkflow(
            tx,
            access.tenantId,
            CANDOUR_WORKFLOW,
            { subjectType: "candour_record", subjectId: record.id, personId: null },
            now,
          );
        }
        // A document cited must be on the relevant person's record, as the reader sees it.
        await checkCandourDocuments(
          tx,
          body,
          body.personId !== undefined ? body.personId : record.personId,
        );
        const thresholdChanged =
          body.threshold !== undefined &&
          (body.threshold?.notifiable ?? null) !== record.thresholdNotifiable;
        const [saved] = await tx
          .update(candourRecord)
          .set({
            ...(body.personId !== undefined ? { personId: body.personId } : {}),
            ...(body.threshold !== undefined
              ? {
                  thresholdNotifiable: body.threshold?.notifiable ?? null,
                  thresholdDecidedAt: body.threshold ? new Date(body.threshold.decidedAt) : null,
                  thresholdDecidedBy: body.threshold?.decidedBy ?? null,
                }
              : {}),
            ...(body.verbal !== undefined ? { verbal: body.verbal } : {}),
            ...(body.contactAttempts !== undefined
              ? { contactAttempts: body.contactAttempts }
              : {}),
            ...(body.written !== undefined ? { written: body.written } : {}),
            ...(body.enquiryResultsSharedAt !== undefined
              ? {
                  enquiryResultsSharedAt: body.enquiryResultsSharedAt
                    ? new Date(body.enquiryResultsSharedAt)
                    : null,
                }
              : {}),
            ...(body.correspondenceDocumentIds !== undefined
              ? { correspondenceDocumentIds: body.correspondenceDocumentIds }
              : {}),
            ...(body.outcome !== undefined ? { outcome: body.outcome } : {}),
          })
          .where(and(eq(candourRecord.id, record.id), eq(candourRecord.version, record.version)))
          .returning();
        if (!saved) throw problems.conflict();
        if (thresholdChanged || body.version === 0) {
          await classifyAndStore(tx, {
            tenantId: access.tenantId,
            incidentId: id,
            actorTenantUserId: access.tenantUserId,
            now,
          });
        }
        await audit(c, tx, access, {
          action: "safety.candour.update",
          resourceType: "candour_record",
          resourceId: saved.id,
          scope: { incidentId: id },
        });
        return {
          record: await candourItem(
            tx,
            access.tenantId,
            saved,
            row.occurredAt,
            await nationOf(tx, row.locationId),
          ),
        };
      });
      return c.json(view, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/incidents/{id}/candour/step",
      tags: ["safety"],
      summary: "Take the next candour step (candourStepProblems says what each step needs)",
      security,
      request: {
        params: IncidentParam,
        body: { content: { "application/json": { schema: CandourStep } } },
      },
      responses: {
        200: jsonBody(CandourView, "Moved"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "safety.incident.manage");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const view = await withTenant(c, async (tx) => {
        const { row } = await loadForChange(c, tx, id);
        const [record] = await tx
          .select()
          .from(candourRecord)
          .where(eq(candourRecord.incidentId, id));
        if (!record) throw problems.notFound();
        if (record.version !== body.version) throw problems.conflict();
        const needs = candourStepProblems(body.to as CandourState, candourView(record));
        if (needs.length > 0) throw problems.invalid(needs.join(" "));
        await moveOrRefuse(
          c,
          tx,
          CANDOUR_WORKFLOW,
          { subjectType: "candour_record", subjectId: record.id, personId: null },
          body.to as CandourState,
          body.reason,
          now,
        );
        const [saved] = await tx
          .update(candourRecord)
          .set({ state: body.to })
          .where(and(eq(candourRecord.id, record.id), eq(candourRecord.version, body.version)))
          .returning();
        if (!saved) throw problems.conflict();
        await audit(c, tx, access, {
          action: `safety.candour.${body.to}`,
          resourceType: "candour_record",
          resourceId: saved.id,
        });
        return {
          record: await candourItem(
            tx,
            access.tenantId,
            saved,
            row.occurredAt,
            await nationOf(tx, row.locationId),
          ),
        };
      });
      return c.json(view, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/incidents/{id}/investigation",
      tags: ["safety"],
      summary: "The investigation: method, findings, actions and lessons",
      security,
      request: { params: IncidentParam },
      responses: {
        200: jsonBody(InvestigationView, "Investigation"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "safety.incident.read");
      const { id } = c.req.valid("param");
      const view = await withTenant(c, async (tx) => {
        const { restricted } = await readIncident(tx, id);
        if (restricted) throw problems.forbidden();
        const [record] = await tx
          .select()
          .from(investigation)
          .where(eq(investigation.incidentId, id));
        await audit(c, tx, access, {
          action: "safety.investigation.view",
          resourceType: "incident",
          resourceId: id,
        });
        return { record: record ? investigationItem(record) : null };
      });
      return c.json(view, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/incidents/{id}/investigation",
      tags: ["safety"],
      summary: "Record the investigation; each action with an owner and date becomes a task",
      description:
        "Version 0 starts the record. An open action with an owner and a due date becomes a task for its owner, who must manage incidents at the incident's location (as the task engine requires of every assignee); otherwise the save is refused. Completing it needs the findings and the lessons.",
      security,
      request: {
        params: IncidentParam,
        body: { content: { "application/json": { schema: UpdateInvestigation } } },
      },
      responses: {
        200: jsonBody(InvestigationView, "Saved"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "safety.incident.manage");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const view = await withTenant(c, async (tx) => {
        const { row } = await loadForChange(c, tx, id);
        let [record] = await tx
          .select()
          .from(investigation)
          .where(eq(investigation.incidentId, id))
          .for("update");
        if ((record?.version ?? 0) !== body.version) throw problems.conflict();
        if (!record) {
          [record] = await tx.insert(investigation).values({ incidentId: id }).returning();
          if (!record) throw problems.conflict();
        }
        const previous = record.actions as InvestigationItem["actions"];
        const actions: InvestigationItem["actions"] = [];
        for (const action of body.actions ?? previous) {
          const before = previous.find((p) => p.id === action.id);
          const actionId = action.id ?? crypto.randomUUID();
          let taskId = before?.taskId ?? null;
          // An action done or cancelled and now open again gets a new task: its old one is
          // finished (review L1), so without a new one it would never be done.
          const reopened = Boolean(before && before.status !== "open" && action.status === "open");
          if (reopened) taskId = null;
          if (!taskId && action.status === "open" && action.ownerTenantUserId && action.dueOn) {
            // Being the assignee lets someone complete the task, so its owner must hold the
            // task's permission where the incident is, as the task engine requires of every
            // assignee (HZ-091; a task its owner could never complete would sit open unseen).
            const given = await mayBeGiven(
              tx,
              action.ownerTenantUserId,
              {
                requiredPermission: "safety.incident.manage",
                locationId: row.locationId,
                personId: null,
              },
              now,
            );
            if (!given) throw problems.invalid(ACTION_OWNER_REFUSED);
            const day = ukDayBounds(action.dueOn);
            const [created] = await tx
              .insert(task)
              .values({
                kind: "safety.investigation_action",
                title: "Complete an investigation action",
                requiredPermission: "safety.incident.manage",
                locationId: row.locationId,
                sourceType: "investigation",
                sourceId: record.id,
                assigneeTenantUserId: action.ownerTenantUserId,
                dueAt: day.startsAt,
                windowStart: day.startsAt,
                windowEnd: day.endsAt,
              })
              .returning({ id: task.id })
              .catch(onForeignKey("action owner"));
            taskId = created?.id ?? null;
          } else if (taskId && action.status !== "open" && before?.status === "open") {
            await tx
              .update(task)
              .set(
                action.status === "done"
                  ? { status: "done", completedAt: now, completedBy: access.tenantUserId }
                  : { status: "cancelled", statusReason: "Investigation action cancelled" },
              )
              .where(and(eq(task.id, taskId), inArray(task.status, ["open", "in_progress"])));
          }
          actions.push({
            id: actionId,
            action: action.action,
            ownerTenantUserId: action.ownerTenantUserId,
            dueOn: action.dueOn,
            status: action.status,
            taskId,
          });
        }
        const findings = body.findings !== undefined ? body.findings : record.findings;
        const lessons = body.lessons !== undefined ? body.lessons : record.lessons;
        const status = body.status ?? record.status;
        if (status === "completed" && (!findings || !lessons)) {
          throw problems.invalid("Record the findings and the lessons before completing it.");
        }
        const [saved] = await tx
          .update(investigation)
          .set({
            ...(body.leadTenantUserId !== undefined
              ? { leadTenantUserId: body.leadTenantUserId }
              : {}),
            ...(body.method !== undefined ? { method: body.method } : {}),
            ...(body.contributingFactors !== undefined
              ? { contributingFactors: body.contributingFactors }
              : {}),
            findings,
            lessons,
            actions,
            status,
            completedAt: status === "completed" ? (record.completedAt ?? now) : null,
            ...(body.bulletinPublished
              ? { bulletinPublishedAt: record.bulletinPublishedAt ?? now }
              : {}),
          })
          .where(and(eq(investigation.id, record.id), eq(investigation.version, record.version)))
          .returning()
          .catch(onForeignKey("investigation lead"));
        if (!saved) throw problems.conflict();
        await audit(c, tx, access, {
          action: "safety.investigation.update",
          resourceType: "investigation",
          resourceId: saved.id,
          scope: { incidentId: id, actions: actions.length },
        });
        return { record: investigationItem(saved) };
      });
      return c.json(view, 200);
    },
  );
