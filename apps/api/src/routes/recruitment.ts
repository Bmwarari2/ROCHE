import {
  ApplicationDetail,
  ApplicationList,
  type ApplicationSummary,
  CloseApplication,
  CreateApplication,
  CreateJobTemplate,
  CreateVacancy,
  EqualityMonitoringForm,
  EqualityMonitoringSummary,
  JobTemplateItem,
  JobTemplateList,
  MakeOffer,
  RecordInterview,
  RespondToOffer,
  ShortlistDecision,
  TalentPoolConsent,
  UpdateJobTemplate,
  UpdateVacancy,
  VacancyItem,
  VacancyList,
} from "@harbour/contracts";
import {
  applicant,
  application,
  applicationEvent,
  equalityMonitoring,
  interview,
  jobOffer,
  jobTemplate,
  retentionClass,
  staffProfile,
  type Transaction,
  vacancy,
} from "@harbour/db";
import {
  type ApplicationMove,
  type ApplicationStage,
  applicantRetainUntil,
  checkApplicationMove,
  checkNewApplication,
  EQUALITY_MONITORING_MIN_COUNT,
  equalityMonitoringSummary,
  interviewTotal,
  type JobTemplateFacts,
  offerConditions,
  type RetentionPeriod,
  type RoleRegistration,
  ukIsoDate,
  type VacancyStatus,
  type ValuesQuestion,
  validEqualityAnswers,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Context } from "hono";
import { AuditedRefusal, withAuditedRefusal, writeAudit } from "../http/audit";
import { type AppEnv, requirePermission, type TenantAccess, withTenant } from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import { audit, dbCode } from "./people-shared";

/**
 * Applicant tracking (workforce.md section 2b, rules 11 to 13 and section 5; WORK-001; plan
 * slice 23). Everything needs workforce.recruitment.manage (MFA); accepting an offer also needs
 * workforce.staff_file.manage, as it creates the staff profile. The database enforces the same
 * (migration 0085). Audit events carry opaque ids and codes only: never names, contact details,
 * scores, notes or equality answers.
 */

const MANAGE = "workforce.recruitment.manage";
const STAFF_FILE = "workforce.staff_file.manage";
const A = {
  templateCreated: "workforce.job_template.created",
  templateUpdated: "workforce.job_template.updated",
  vacancyCreated: "workforce.vacancy.created",
  vacancyUpdated: "workforce.vacancy.updated",
  applicationCreated: "workforce.application.created",
  applicationViewed: "workforce.application.viewed",
  shortlisted: "workforce.application.shortlisted",
  closed: "workforce.application.closed",
  interview: "workforce.interview.recorded",
  offerMade: "workforce.offer.made",
  offerResponded: "workforce.offer.responded",
  talentPool: "workforce.applicant.talent_pool",
  monitoringAdded: "workforce.equality_monitoring.added",
  monitoringSummarised: "workforce.equality_monitoring.summarised",
} as const;

const IdParam = z.object({ id: z.uuid() });

type TemplateRow = typeof jobTemplate.$inferSelect;
type VacancyRow = typeof vacancy.$inferSelect;
type ApplicationRow = typeof application.$inferSelect;
type ApplicantRow = typeof applicant.$inferSelect;

const refused = (problem: HttpProblem, action: string, type: string, id: string, reason: string) =>
  new AuditedRefusal(problem, {
    action,
    outcome: "denied",
    resourceType: type,
    resourceId: id,
    reason,
  });

/** Runs a change; refusals and the database's own are audited. */
async function change<T>(
  c: Context<AppEnv>,
  access: TenantAccess,
  action: string,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  try {
    return await withAuditedRefusal(c, access, () => withTenant(c, fn));
  } catch (error) {
    const code = dbCode(error);
    if (!["42501", "23000", "23505", "23503", "23514"].includes(code ?? "")) throw error;
    await writeAudit(c.get("services").appPool, access, {
      action,
      outcome: "denied",
      reason: code === "42501" ? "refused_by_database" : `invalid_${code}`,
      requestId: c.get("requestId"),
    });
    if (code === "42501") throw problems.forbidden();
    if (code === "23505") {
      throw new HttpProblem(409, "already_recorded", "This is already recorded.");
    }
    if (code === "23503") throw problems.invalid("Choose records of this organisation.");
    throw problems.invalid("Those details cannot be saved together. Check them and try again.");
  }
}

const today = () => ukIsoDate(new Date());

function templateFacts(row: TemplateRow): JobTemplateFacts {
  return {
    essentialCriteria: row.essentialCriteria as string[],
    valuesQuestions: row.valuesQuestions as ValuesQuestion[],
    registration: (row.registrationBody ?? null) as RoleRegistration,
  };
}

function templateItem(row: TemplateRow): JobTemplateItem {
  return {
    id: row.id,
    title: row.title,
    pathwayCategory: row.pathwayCategory as JobTemplateItem["pathwayCategory"],
    registrationBody: (row.registrationBody ?? null) as JobTemplateItem["registrationBody"],
    essentialCriteria: row.essentialCriteria as string[],
    valuesQuestions: row.valuesQuestions as JobTemplateItem["valuesQuestions"],
    archived: row.archivedAt !== null,
    version: row.version,
  };
}

function summaryOf(row: ApplicationRow, person: ApplicantRow | undefined): ApplicationSummary {
  const name =
    person && person.redactedAt === null ? `${person.givenName} ${person.familyName}` : null;
  return {
    id: row.id,
    vacancyId: row.vacancyId,
    applicantId: row.applicantId,
    applicantName: name,
    stage: row.stage as ApplicationSummary["stage"],
    stageReason: (row.stageReason ?? null) as ApplicationSummary["stageReason"],
    closedOn: row.closedOn,
    version: row.version,
  };
}

async function retentionPeriod(tx: Transaction, recordClass: string): Promise<RetentionPeriod> {
  const rows = await tx
    .select()
    .from(retentionClass)
    .where(eq(retentionClass.recordClass, recordClass))
    .orderBy(sql`${retentionClass.tenantId} IS NULL`);
  const row = rows[0];
  if (!row) throw new Error(`retention class ${recordClass} is not seeded`);
  return { period: row.period, unit: row.unit as RetentionPeriod["unit"] };
}

/** Sets how long the applicant is kept, from all their applications (rule 13). */
async function refreshRetainUntil(tx: Transaction, applicantId: string): Promise<void> {
  const [person] = await tx.select().from(applicant).where(eq(applicant.id, applicantId));
  if (!person || person.redactedAt) return;
  const rows = await tx
    .select({ stage: application.stage, closedOn: application.closedOn })
    .from(application)
    .where(and(eq(application.applicantId, applicantId), isNull(application.deletedAt)));
  const retainUntil = applicantRetainUntil({
    applications: rows.map((r) => ({ stage: r.stage as ApplicationStage, closedOn: r.closedOn })),
    talentPoolUntil: person.talentPoolUntil,
    unsuccessful: await retentionPeriod(tx, "applicant.unsuccessful"),
  });
  if (retainUntil !== person.retainUntil) {
    await tx.update(applicant).set({ retainUntil }).where(eq(applicant.id, applicantId));
  }
}

async function loadApplication(tx: Transaction, action: string, id: string) {
  const [row] = await tx
    .select()
    .from(application)
    .where(and(eq(application.id, id), isNull(application.deletedAt)));
  if (!row) throw refused(problems.notFound(), action, "application", id, "not_found");
  const [vac] = await tx.select().from(vacancy).where(eq(vacancy.id, row.vacancyId));
  const [template] = vac
    ? await tx.select().from(jobTemplate).where(eq(jobTemplate.id, vac.jobTemplateId))
    : [];
  if (!vac || !template) throw refused(problems.notFound(), action, "application", id, "not_found");
  return { row, vacancy: vac, template };
}

/** Records a stage move checked by the domain, its event, and the applicant's keep-until date. */
async function moveApplication(
  c: Context<AppEnv>,
  tx: Transaction,
  access: TenantAccess,
  action: string,
  loaded: Awaited<ReturnType<typeof loadApplication>>,
  move: ApplicationMove,
  expectedVersion: number,
  extra: Partial<typeof application.$inferInsert> = {},
) {
  const { row, template } = loaded;
  if (row.version !== expectedVersion) {
    throw refused(problems.conflict(), action, "application", row.id, "version_conflict");
  }
  const check = checkApplicationMove(row.stage as ApplicationStage, templateFacts(template), move);
  if (!check.ok) {
    throw refused(problems.invalid(check.message), action, "application", row.id, check.problem);
  }
  const reason = "reason" in move ? move.reason : null;
  const [updated] = await tx
    .update(application)
    .set({
      stage: check.to,
      stageReason: reason ?? (check.to === "declined" ? "offer_declined" : null),
      closedOn: check.closes ? today() : null,
      ...extra,
    })
    .where(and(eq(application.id, row.id), eq(application.version, expectedVersion)))
    .returning();
  if (!updated)
    throw refused(problems.conflict(), action, "application", row.id, "version_conflict");
  if (check.to !== row.stage) {
    await tx.insert(applicationEvent).values({
      applicationId: row.id,
      fromStage: row.stage,
      toStage: check.to,
      reason: updated.stageReason,
    });
  }
  if (check.closes) await refreshRetainUntil(tx, row.applicantId);
  await audit(c, tx, access, {
    action,
    resourceType: "application",
    resourceId: row.id,
    scopeExtra: { from: row.stage, to: check.to, ...(reason ? { reason } : {}) },
  });
  return updated;
}

async function detailOf(tx: Transaction, id: string): Promise<ApplicationDetail> {
  const [row] = await tx.select().from(application).where(eq(application.id, id));
  if (!row) throw problems.notFound();
  const [person] = await tx.select().from(applicant).where(eq(applicant.id, row.applicantId));
  if (!person) throw problems.notFound();
  const [vac] = await tx.select().from(vacancy).where(eq(vacancy.id, row.vacancyId));
  const [template] = vac
    ? await tx.select().from(jobTemplate).where(eq(jobTemplate.id, vac.jobTemplateId))
    : [];
  const questions = (template?.valuesQuestions ?? []) as ValuesQuestion[];
  const events = await tx
    .select()
    .from(applicationEvent)
    .where(eq(applicationEvent.applicationId, id))
    .orderBy(asc(applicationEvent.occurredAt), asc(applicationEvent.id));
  const interviews = await tx
    .select()
    .from(interview)
    .where(eq(interview.applicationId, id))
    .orderBy(asc(interview.heldOn), asc(interview.id));
  const [offer] = await tx.select().from(jobOffer).where(eq(jobOffer.applicationId, id));
  const shortlist = row.shortlist as ApplicationDetail["shortlist"];
  return {
    application: summaryOf(row, person),
    applicant: {
      id: person.id,
      givenName: person.givenName,
      familyName: person.familyName,
      email: person.email,
      phone: person.phone,
      talentPoolUntil: person.talentPoolUntil,
      retainUntil: person.retainUntil,
      redacted: person.redactedAt !== null,
      version: person.version,
    },
    shortlist: shortlist ?? null,
    history: events.map((e) => ({
      fromStage: (e.fromStage ?? null) as ApplicationStage | null,
      toStage: e.toStage as ApplicationStage,
      reason: e.reason,
      occurredAt: e.occurredAt.toISOString(),
    })),
    interviews: interviews.map((i) => {
      const scores = i.scores as Record<string, number>;
      return {
        id: i.id,
        heldOn: i.heldOn,
        panel: i.panel,
        scores,
        ...interviewTotal(scores, questions),
        notes: i.notes,
        recommendation: i.recommendation as "proceed" | "do_not_proceed",
      };
    }),
    offer: offer
      ? {
          id: offer.id,
          madeOn: offer.madeOn,
          proposedStartOn: offer.proposedStartOn,
          conditions: offer.conditions as NonNullable<ApplicationDetail["offer"]>["conditions"],
          status: offer.status as "made" | "accepted" | "declined" | "withdrawn",
          respondedOn: offer.respondedOn,
          staffProfileId: offer.staffProfileId,
          version: offer.version,
        }
      : null,
  };
}

async function vacancyItem(tx: Transaction, row: VacancyRow): Promise<VacancyItem> {
  const rows = await tx
    .select({ stage: application.stage, n: sql<number>`count(*)::int` })
    .from(application)
    .where(and(eq(application.vacancyId, row.id), isNull(application.deletedAt)))
    .groupBy(application.stage);
  return {
    id: row.id,
    jobTemplateId: row.jobTemplateId,
    locationId: row.locationId,
    title: row.title,
    positions: row.positions,
    opensOn: row.opensOn,
    closesOn: row.closesOn,
    status: row.status as VacancyStatus,
    counts: Object.fromEntries(rows.map((r) => [r.stage, r.n])),
    version: row.version,
  };
}

const detailResponses = {
  200: jsonBody(ApplicationDetail, "The application"),
  ...errorResponses,
  ...notFoundResponse,
  ...conflictResponse,
};

export const recruitmentRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/workforce/job-templates",
      tags: ["workforce"],
      summary: "Job templates",
      description: "workforce.recruitment.manage. Templates by Care Workforce Pathway role.",
      security,
      responses: { 200: jsonBody(JobTemplateList, "Templates"), ...errorResponses },
    }),
    async (c) => {
      await requirePermission(c, MANAGE);
      const items = await withTenant(c, async (tx) =>
        (
          await tx
            .select()
            .from(jobTemplate)
            .where(isNull(jobTemplate.deletedAt))
            .orderBy(asc(jobTemplate.title))
        ).map(templateItem),
      );
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/job-templates",
      tags: ["workforce"],
      summary: "Create a job template",
      description:
        "workforce.recruitment.manage. The essential criteria (2 to 20) assessed at shortlisting and the values-based questions (2 to 12) asked at interview. Audited.",
      security,
      request: { body: { content: { "application/json": { schema: CreateJobTemplate } } } },
      responses: { 201: jsonBody(JobTemplateItem, "Created"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const body = c.req.valid("json");
      const item = await change(c, access, A.templateCreated, async (tx) => {
        const [row] = await tx
          .insert(jobTemplate)
          .values({
            title: body.title,
            pathwayCategory: body.pathwayCategory,
            registrationBody: body.registrationBody,
            essentialCriteria: body.essentialCriteria,
            valuesQuestions: body.valuesQuestions,
          })
          .returning();
        if (!row) throw new Error("job template not stored");
        await audit(c, tx, access, {
          action: A.templateCreated,
          resourceType: "job_template",
          resourceId: row.id,
        });
        return templateItem(row);
      });
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/v1/workforce/job-templates/{id}",
      tags: ["workforce"],
      summary: "Change or archive a job template",
      description:
        "workforce.recruitment.manage, with expectedVersion. A template an open vacancy uses is not archived. Audited.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: UpdateJobTemplate } } },
      },
      responses: {
        200: jsonBody(JobTemplateItem, "Saved"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const item = await change(c, access, A.templateUpdated, async (tx) => {
        const [row] = await tx.select().from(jobTemplate).where(eq(jobTemplate.id, id));
        if (!row)
          throw refused(problems.notFound(), A.templateUpdated, "job_template", id, "not_found");
        if (row.version !== body.expectedVersion) {
          throw refused(
            problems.conflict(),
            A.templateUpdated,
            "job_template",
            id,
            "version_conflict",
          );
        }
        if (body.archived === true) {
          const [open] = await tx
            .select({ id: vacancy.id })
            .from(vacancy)
            .where(and(eq(vacancy.jobTemplateId, id), eq(vacancy.status, "open")))
            .limit(1);
          if (open) {
            throw refused(
              problems.invalid("Close the open vacancies that use this template first."),
              A.templateUpdated,
              "job_template",
              id,
              "template_in_use",
            );
          }
        }
        const [updated] = await tx
          .update(jobTemplate)
          .set({
            ...(body.title !== undefined ? { title: body.title } : {}),
            ...(body.pathwayCategory !== undefined
              ? { pathwayCategory: body.pathwayCategory }
              : {}),
            ...(body.registrationBody !== undefined
              ? { registrationBody: body.registrationBody }
              : {}),
            ...(body.essentialCriteria !== undefined
              ? { essentialCriteria: body.essentialCriteria }
              : {}),
            ...(body.valuesQuestions !== undefined
              ? { valuesQuestions: body.valuesQuestions }
              : {}),
            ...(body.archived !== undefined
              ? { archivedAt: body.archived ? (row.archivedAt ?? new Date()) : null }
              : {}),
          })
          .where(and(eq(jobTemplate.id, id), eq(jobTemplate.version, body.expectedVersion)))
          .returning();
        if (!updated) {
          throw refused(
            problems.conflict(),
            A.templateUpdated,
            "job_template",
            id,
            "version_conflict",
          );
        }
        await audit(c, tx, access, {
          action: A.templateUpdated,
          resourceType: "job_template",
          resourceId: id,
        });
        return templateItem(updated);
      });
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/workforce/vacancies",
      tags: ["workforce"],
      summary: "Vacancies",
      description:
        "workforce.recruitment.manage. Every vacancy with how many applications are at each stage.",
      security,
      responses: { 200: jsonBody(VacancyList, "Vacancies"), ...errorResponses },
    }),
    async (c) => {
      await requirePermission(c, MANAGE);
      const items = await withTenant(c, async (tx) => {
        const rows = await tx
          .select()
          .from(vacancy)
          .where(isNull(vacancy.deletedAt))
          .orderBy(desc(vacancy.opensOn), asc(vacancy.title));
        const out: VacancyItem[] = [];
        for (const row of rows) out.push(await vacancyItem(tx, row));
        return out;
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/vacancies",
      tags: ["workforce"],
      summary: "Create a vacancy",
      description:
        "workforce.recruitment.manage. From a template that is not archived; draft or open. Audited.",
      security,
      request: { body: { content: { "application/json": { schema: CreateVacancy } } } },
      responses: { 201: jsonBody(VacancyItem, "Created"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const body = c.req.valid("json");
      const item = await change(c, access, A.vacancyCreated, async (tx) => {
        const [template] = await tx
          .select()
          .from(jobTemplate)
          .where(and(eq(jobTemplate.id, body.jobTemplateId), isNull(jobTemplate.archivedAt)));
        if (!template) throw problems.invalid("Choose a job template that is in use.");
        const [row] = await tx
          .insert(vacancy)
          .values({
            jobTemplateId: body.jobTemplateId,
            locationId: body.locationId,
            title: body.title,
            positions: body.positions,
            opensOn: body.opensOn,
            closesOn: body.closesOn,
            status: body.status,
          })
          .returning();
        if (!row) throw new Error("vacancy not stored");
        await audit(c, tx, access, {
          action: A.vacancyCreated,
          resourceType: "vacancy",
          resourceId: row.id,
        });
        return vacancyItem(tx, row);
      });
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/v1/workforce/vacancies/{id}",
      tags: ["workforce"],
      summary: "Change a vacancy or its status",
      description:
        "workforce.recruitment.manage, with expectedVersion. Withdrawing or filling a vacancy closes nothing by itself: each open application is closed with its reason. Audited.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: UpdateVacancy } } },
      },
      responses: {
        200: jsonBody(VacancyItem, "Saved"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const item = await change(c, access, A.vacancyUpdated, async (tx) => {
        const [updated] = await tx
          .update(vacancy)
          .set({
            ...(body.title !== undefined ? { title: body.title } : {}),
            ...(body.positions !== undefined ? { positions: body.positions } : {}),
            ...(body.closesOn !== undefined ? { closesOn: body.closesOn } : {}),
            ...(body.status !== undefined ? { status: body.status } : {}),
          })
          .where(and(eq(vacancy.id, id), eq(vacancy.version, body.expectedVersion)))
          .returning();
        if (!updated) {
          const [exists] = await tx
            .select({ id: vacancy.id })
            .from(vacancy)
            .where(eq(vacancy.id, id));
          throw refused(
            exists ? problems.conflict() : problems.notFound(),
            A.vacancyUpdated,
            "vacancy",
            id,
            exists ? "version_conflict" : "not_found",
          );
        }
        await audit(c, tx, access, {
          action: A.vacancyUpdated,
          resourceType: "vacancy",
          resourceId: id,
          scopeExtra: body.status ? { status: body.status } : {},
        });
        return vacancyItem(tx, updated);
      });
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/workforce/vacancies/{id}/applications",
      tags: ["workforce"],
      summary: "Applications to a vacancy",
      description:
        "workforce.recruitment.manage. Each application with its applicant's name and stage.",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(ApplicationList, "Applications"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const items = await withTenant(c, async (tx) => {
        const [vac] = await tx.select({ id: vacancy.id }).from(vacancy).where(eq(vacancy.id, id));
        if (!vac) throw problems.notFound();
        const rows = await tx
          .select()
          .from(application)
          .where(and(eq(application.vacancyId, id), isNull(application.deletedAt)))
          .orderBy(asc(application.createdAt));
        const people =
          rows.length === 0
            ? []
            : await tx
                .select()
                .from(applicant)
                .where(
                  inArray(
                    applicant.id,
                    rows.map((r) => r.applicantId),
                  ),
                );
        return rows.map((r) =>
          summaryOf(
            r,
            people.find((p) => p.id === r.applicantId),
          ),
        );
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/vacancies/{id}/applications",
      tags: ["workforce"],
      summary: "Record an application",
      description:
        "workforce.recruitment.manage. Only while the vacancy is open. An applicant already recorded with the same email (and not redacted) is used again; one application per vacancy each (409). Audited with ids only.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: CreateApplication } } },
      },
      responses: {
        201: jsonBody(ApplicationDetail, "Recorded"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const detail = await change(c, access, A.applicationCreated, async (tx) => {
        const [vac] = await tx.select().from(vacancy).where(eq(vacancy.id, id));
        if (!vac)
          throw refused(problems.notFound(), A.applicationCreated, "vacancy", id, "not_found");
        const check = checkNewApplication(vac.status as VacancyStatus);
        if (!check.ok) {
          throw refused(
            problems.invalid(check.message),
            A.applicationCreated,
            "vacancy",
            id,
            check.problem,
          );
        }
        const email = body.email?.trim().toLowerCase() ?? null;
        const [known] = email
          ? await tx
              .select()
              .from(applicant)
              .where(and(eq(applicant.email, email), isNull(applicant.redactedAt)))
              .limit(1)
          : [];
        const person =
          known ??
          (
            await tx
              .insert(applicant)
              .values({
                givenName: body.givenName,
                familyName: body.familyName,
                email,
                phone: body.phone,
              })
              .returning()
          )[0];
        if (!person) throw new Error("applicant not stored");
        const [row] = await tx
          .insert(application)
          .values({ vacancyId: id, applicantId: person.id })
          .returning();
        if (!row) throw new Error("application not stored");
        await tx
          .insert(applicationEvent)
          .values({ applicationId: row.id, fromStage: null, toStage: "applied" });
        // An open application again: the applicant is kept while it is.
        await refreshRetainUntil(tx, person.id);
        await audit(c, tx, access, {
          action: A.applicationCreated,
          resourceType: "application",
          resourceId: row.id,
          scopeExtra: { vacancyId: id, applicantId: person.id, knownApplicant: Boolean(known) },
        });
        return detailOf(tx, row.id);
      });
      return c.json(detail, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/workforce/applications/{id}",
      tags: ["workforce"],
      summary: "An application",
      description:
        "workforce.recruitment.manage. The application with its applicant, shortlisting, stage history, interviews (with the panel's total, never a decision) and offer. Audited (viewed).",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(ApplicationDetail, "The application"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const detail = await withTenant(c, async (tx) => {
        const out = await detailOf(tx, id);
        await audit(c, tx, access, {
          action: A.applicationViewed,
          resourceType: "application",
          resourceId: id,
        });
        return out;
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/applications/{id}/shortlist",
      tags: ["workforce"],
      summary: "Record the shortlisting decision",
      description:
        "workforce.recruitment.manage. Each essential criterion met or not, in the template's order. Shortlisted only when every one is met; otherwise rejected with a reason (rule 11). Audited.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: ShortlistDecision } } },
      },
      responses: detailResponses,
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const action = body.decision === "shortlist" ? A.shortlisted : A.closed;
      const detail = await change(c, access, action, async (tx) => {
        const loaded = await loadApplication(tx, action, id);
        const move: ApplicationMove =
          body.decision === "shortlist"
            ? { to: "shortlisted", assessment: body.criteria }
            : { to: "rejected", reason: body.reason ?? ("" as never), assessment: body.criteria };
        await moveApplication(c, tx, access, action, loaded, move, body.expectedVersion, {
          shortlist: {
            criteria: body.criteria,
            decidedBy: access.tenantUserId,
            decidedAt: new Date().toISOString(),
          },
        });
        return detailOf(tx, id);
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/applications/{id}/close",
      tags: ["workforce"],
      summary: "Reject an application, or record its withdrawal",
      description:
        "workforce.recruitment.manage, with a reason code. A closed application never reopens. When the applicant's last application closes, the date until which they are kept is set (rule 13). Audited.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: CloseApplication } } },
      },
      responses: detailResponses,
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const detail = await change(c, access, A.closed, async (tx) => {
        const loaded = await loadApplication(tx, A.closed, id);
        await moveApplication(
          c,
          tx,
          access,
          A.closed,
          loaded,
          { to: body.to, reason: body.reason },
          body.expectedVersion,
        );
        return detailOf(tx, id);
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/applications/{id}/interviews",
      tags: ["workforce"],
      summary: "Record an interview",
      description:
        "workforce.recruitment.manage. Once shortlisted, by a panel of 1 to 5 members of staff, with every values question scored 1 to 4, on a date no later than today. Append-only; a later interview is a new record. Audited without the scores or notes.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: RecordInterview } } },
      },
      responses: detailResponses,
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const detail = await change(c, access, A.interview, async (tx) => {
        if (body.heldOn > today()) {
          throw refused(
            problems.invalid("An interview is recorded once it has been held."),
            A.interview,
            "application",
            id,
            "held_in_future",
          );
        }
        const loaded = await loadApplication(tx, A.interview, id);
        await moveApplication(
          c,
          tx,
          access,
          A.interview,
          loaded,
          {
            to: "interviewed",
            panel: body.panel,
            scores: body.scores,
            recommendation: body.recommendation,
          },
          body.expectedVersion,
        );
        await tx.insert(interview).values({
          applicationId: id,
          heldOn: body.heldOn,
          panel: body.panel,
          scores: body.scores,
          notes: body.notes,
          recommendation: body.recommendation,
        });
        return detailOf(tx, id);
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/applications/{id}/offer",
      tags: ["workforce"],
      summary: "Make a conditional offer",
      description:
        "workforce.recruitment.manage. After an interview whose panel recommended proceeding. Conditional on the Schedule 3 items the role needs, which the staff profile lists as outstanding once accepted. Audited.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: MakeOffer } } },
      },
      responses: detailResponses,
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const detail = await change(c, access, A.offerMade, async (tx) => {
        const loaded = await loadApplication(tx, A.offerMade, id);
        const [last] = await tx
          .select({ recommendation: interview.recommendation })
          .from(interview)
          .where(eq(interview.applicationId, id))
          .orderBy(desc(interview.heldOn), desc(interview.createdAt))
          .limit(1);
        await moveApplication(
          c,
          tx,
          access,
          A.offerMade,
          loaded,
          {
            to: "offered",
            lastRecommendation: (last?.recommendation ?? null) as
              | "proceed"
              | "do_not_proceed"
              | null,
          },
          body.expectedVersion,
        );
        const conditions = offerConditions({
          registration: (loaded.template.registrationBody ?? null) as RoleRegistration,
          previousCareWork: body.previousCareWork,
        });
        const [offer] = await tx
          .insert(jobOffer)
          .values({
            applicationId: id,
            madeOn: today(),
            proposedStartOn: body.proposedStartOn,
            conditions: [...conditions],
          })
          .returning({ id: jobOffer.id });
        await audit(c, tx, access, {
          action: A.offerMade,
          resourceType: "job_offer",
          resourceId: offer?.id ?? id,
          scopeExtra: { applicationId: id },
        });
        return detailOf(tx, id);
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/offers/{id}/response",
      tags: ["workforce"],
      summary: "Record the response to an offer",
      description:
        "workforce.recruitment.manage. Accepted needs workforce.staff_file.manage too and the member of staff the applicant now is (never oneself): their staff profile is created from the job, with the offer's Schedule 3 conditions outstanding. Declined or withdrawn closes the application. Audited.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: RespondToOffer } } },
      },
      responses: detailResponses,
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      if (body.response === "accepted") await requirePermission(c, STAFF_FILE);
      const detail = await change(c, access, A.offerResponded, async (tx) => {
        const [offer] = await tx.select().from(jobOffer).where(eq(jobOffer.id, id));
        if (!offer)
          throw refused(problems.notFound(), A.offerResponded, "job_offer", id, "not_found");
        if (offer.version !== body.expectedVersion) {
          throw refused(problems.conflict(), A.offerResponded, "job_offer", id, "version_conflict");
        }
        if (offer.status !== "made") {
          throw refused(
            problems.invalid("This offer has already had its response."),
            A.offerResponded,
            "job_offer",
            id,
            "already_responded",
          );
        }
        const loaded = await loadApplication(tx, A.offerResponded, offer.applicationId);
        let staffProfileId: string | null = null;
        if (body.response === "accepted") {
          if (body.tenantUserId === access.tenantUserId) {
            throw refused(
              new HttpProblem(403, "own_staff_file", "Someone else records your own offer."),
              A.offerResponded,
              "job_offer",
              id,
              "own_staff_file",
            );
          }
          const [profile] = await tx
            .insert(staffProfile)
            .values({
              tenantUserId: body.tenantUserId,
              locationId: loaded.vacancy.locationId,
              jobTitle: loaded.template.title,
              pathwayCategory: loaded.template.pathwayCategory,
              registrationBody: loaded.template.registrationBody,
              previousCareWork: (offer.conditions as string[]).includes("conduct_in_care_work"),
              startsOn: offer.proposedStartOn,
            })
            .returning({ id: staffProfile.id });
          staffProfileId = profile?.id ?? null;
        }
        const move: ApplicationMove =
          body.response === "accepted"
            ? { to: "accepted", staffMemberId: body.tenantUserId }
            : body.response === "declined"
              ? { to: "declined" }
              : { to: "withdrawn", reason: "offer_withdrawn" };
        await moveApplication(c, tx, access, A.offerResponded, loaded, move, loaded.row.version);
        await tx
          .update(jobOffer)
          .set({ status: body.response, respondedOn: today(), staffProfileId })
          .where(eq(jobOffer.id, id));
        await audit(c, tx, access, {
          action: A.offerResponded,
          resourceType: "job_offer",
          resourceId: id,
          scopeExtra: { response: body.response, ...(staffProfileId ? { staffProfileId } : {}) },
        });
        return detailOf(tx, offer.applicationId);
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/workforce/applicants/{id}/talent-pool",
      tags: ["workforce"],
      summary: "Record or withdraw talent pool consent",
      description:
        "workforce.recruitment.manage, with expectedVersion. Consent keeps the applicant for the applicant.talent_pool period from today (retention.md); withdrawing ends it at once, and the keep-until date falls back to the last application's (rule 13). Audited.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: TalentPoolConsent } } },
      },
      responses: {
        200: jsonBody(
          z.object({
            talentPoolUntil: z.iso.date().nullable(),
            retainUntil: z.iso.date().nullable(),
          }),
          "Saved",
        ),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const result = await change(c, access, A.talentPool, async (tx) => {
        const [person] = await tx.select().from(applicant).where(eq(applicant.id, id));
        if (!person || person.redactedAt) {
          throw refused(problems.notFound(), A.talentPool, "applicant", id, "not_found");
        }
        if (person.version !== body.expectedVersion) {
          throw refused(problems.conflict(), A.talentPool, "applicant", id, "version_conflict");
        }
        const pool = await retentionPeriod(tx, "applicant.talent_pool");
        const now = new Date();
        const until = new Date(`${today()}T12:00:00Z`);
        if (pool.unit === "years") until.setUTCFullYear(until.getUTCFullYear() + pool.period);
        else until.setUTCMonth(until.getUTCMonth() + pool.period);
        await tx
          .update(applicant)
          .set(
            body.consent
              ? { talentPoolUntil: until.toISOString().slice(0, 10), talentPoolConsentedAt: now }
              : { talentPoolUntil: null, talentPoolConsentedAt: null },
          )
          .where(and(eq(applicant.id, id), eq(applicant.version, body.expectedVersion)));
        await refreshRetainUntil(tx, id);
        const [after] = await tx.select().from(applicant).where(eq(applicant.id, id));
        await audit(c, tx, access, {
          action: A.talentPool,
          resourceType: "applicant",
          resourceId: id,
          scopeExtra: { consent: body.consent },
        });
        return {
          talentPoolUntil: after?.talentPoolUntil ?? null,
          retainUntil: after?.retainUntil ?? null,
        };
      });
      return c.json(result, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/vacancies/{id}/equality-monitoring",
      tags: ["workforce"],
      summary: "Add an anonymous equality monitoring form",
      description:
        "workforce.recruitment.manage. Every answer optional, prefer_not_to_say always accepted. Kept with the vacancy and the UK date only, never linked to an applicant; nobody reads a form, only the counts. Audited without the answers.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: EqualityMonitoringForm } } },
      },
      responses: { 204: { description: "Added" }, ...errorResponses, ...notFoundResponse },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      if (!validEqualityAnswers(body.answers)) {
        throw problems.invalid("Answer only the questions asked, with the answers offered.");
      }
      await change(c, access, A.monitoringAdded, async (tx) => {
        const [vac] = await tx.select({ id: vacancy.id }).from(vacancy).where(eq(vacancy.id, id));
        if (!vac) throw refused(problems.notFound(), A.monitoringAdded, "vacancy", id, "not_found");
        // No RETURNING: the application role may add a form but never read one back.
        await tx
          .insert(equalityMonitoring)
          .values({ vacancyId: id, answers: body.answers, submittedOn: today() });
        await audit(c, tx, access, {
          action: A.monitoringAdded,
          resourceType: "vacancy",
          resourceId: id,
        });
      });
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/workforce/vacancies/{id}/equality-monitoring",
      tags: ["workforce"],
      summary: "Equality monitoring counts for a vacancy",
      description:
        "workforce.recruitment.manage. Counts per question and answer; any count under the minimum reads fewer_than_min, and a question fewer people answered than that is withheld, so no applicant can be picked out (rule 12). Audited.",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(EqualityMonitoringSummary, "Counts"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const summary = await withTenant(c, async (tx) => {
        const [vac] = await tx.select({ id: vacancy.id }).from(vacancy).where(eq(vacancy.id, id));
        if (!vac) throw problems.notFound();
        const { rows } = await tx.execute<{ question: string; answer: string; n: string }>(
          sql`SELECT question, answer, n FROM app.equality_monitoring_counts(${id}::uuid)`,
        );
        await audit(c, tx, access, {
          action: A.monitoringSummarised,
          resourceType: "vacancy",
          resourceId: id,
        });
        return equalityMonitoringSummary(
          rows.map((r) => ({ question: r.question, answer: r.answer, n: Number(r.n) })),
        );
      });
      return c.json(
        {
          vacancyId: id,
          minimumShown: EQUALITY_MONITORING_MIN_COUNT,
          forms: summary.forms,
          questions: summary.questions.map((q) => ({
            question: q.question,
            counts: q.counts ? { ...q.counts } : null,
          })),
        },
        200,
      );
    },
  );
