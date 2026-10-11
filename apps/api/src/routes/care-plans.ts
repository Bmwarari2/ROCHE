import {
  CarePlanActionItem,
  CarePlanDetail,
  CarePlanList,
  CarePlanSectionItem,
  CarePlanSummary,
  CloseRiskAssessment,
  CreateCarePlan,
  CreateCarePlanAction,
  CreateRiskAssessment,
  PcspDomain,
  PublishCarePlan,
  RecordHistory,
  type Recurrence,
  RiskAssessmentItem,
  RiskAssessmentList,
  RiskTemplateList,
  SignOffCarePlan,
  UpdateCarePlanAction,
  UpdateCarePlanSection,
  UpdateRiskAssessment,
} from "@harbour/contracts";
import {
  advanceCareRecord,
  carePlan,
  carePlanAction,
  carePlanSection,
  contact,
  recordVersion,
  riskAssessment,
  type Transaction,
  tenant,
} from "@harbour/db";
import {
  checkPlanAction,
  checkPublication,
  checkRiskAssessment,
  checkSignOff,
  type PcspDomain as DomainPcsp,
  type Recurrence as DomainRecurrence,
  LIKELIHOOD_LABELS,
  planPublication,
  RISK_MATRIX_SOURCE,
  RISK_TEMPLATES,
  type RiskAssessmentInput,
  type RiskTemplateKey,
  SEVERITY_LABELS,
  type SignOff,
  ukIsoDate,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx } from "../http/audit";
import { type AppEnv, requirePermission, type TenantAccess, withTenant } from "../http/context";
import { problems } from "../http/problem";
import { publish } from "../outbox";
import { completeOpenTasks, personContext } from "../services/care";
import {
  bedRailLimits,
  carePlanDueFor,
  carePlanRates,
  REVIEW_TASKS,
} from "../services/care-planning";
import { iso, PersonParam, requireOpenRecord } from "./care-shared";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";

/**
 * Care plans and risk assessments (master prompt 10.1; docs/specs/care.md rules 1, 2 and 12;
 * register rows CARE-001 and CARE-002). A plan is edited only as a draft; publishing it supersedes
 * the active version, and a change in the person's needs brings the review forward. Reads and
 * writes are audited by record id, never content.
 */

const PlanParams = PersonParam.extend({ planId: z.uuid() });
const SectionParams = PlanParams.extend({ domain: PcspDomain });
const ActionParams = PlanParams.extend({ actionId: z.uuid() });
const RiskParams = PersonParam.extend({ riskId: z.uuid() });
const HISTORY_TABLES = {
  care_plan: carePlan,
  care_plan_section: carePlanSection,
  care_plan_action: carePlanAction,
  risk_assessment: riskAssessment,
  advance_care_record: advanceCareRecord,
} as const;
const HistoryParams = PersonParam.extend({
  table: z.enum([
    "care_plan",
    "care_plan_section",
    "care_plan_action",
    "risk_assessment",
    "advance_care_record",
  ]),
  recordId: z.uuid(),
});

type PlanRow = typeof carePlan.$inferSelect;
type SectionRow = typeof carePlanSection.$inferSelect;
type ActionRow = typeof carePlanAction.$inferSelect;
type RiskRow = typeof riskAssessment.$inferSelect;

function isUniqueViolation(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } }).cause;
  return (error as { code?: string }).code === "23505" || cause?.code === "23505";
}

function planSummary(row: PlanRow): CarePlanSummary {
  return {
    id: row.id,
    personId: row.personId,
    locationId: row.locationId,
    status: row.status as CarePlanSummary["status"],
    publishedVersion: row.publishedVersion,
    basedOnPlanId: row.basedOnPlanId,
    summary: row.summary,
    reviewDueOn: row.reviewDueOn,
    reviewReason: row.reviewReason,
    publishedAt: iso(row.publishedAt),
    publishedBy: row.publishedBy,
    supersededAt: iso(row.supersededAt),
    signOff:
      row.signOffKind && row.signedOffAt
        ? {
            agreedBy: row.signOffKind as "person" | "representative" | "unable",
            representativeName: row.signOffRepresentativeName,
            authority: row.signOffAuthority as NonNullable<CarePlanSummary["signOff"]>["authority"],
            contactId: row.signOffContactId,
            unableReason: row.signOffUnableReason,
            signedOffAt: row.signedOffAt.toISOString(),
            recordedBy: row.signedOffRecordedBy,
          }
        : null,
    version: row.version,
  };
}

function actionItem(row: ActionRow): CarePlanActionItem {
  return {
    id: row.id,
    sectionId: row.sectionId,
    action: row.action,
    roleKey: row.roleKey,
    recurrence: row.recurrence as Recurrence | null,
    whenText: row.whenText,
    generatesTasks: row.generatesTasks,
    evidenceRequired: row.evidenceRequired,
    riskAssessmentId: row.riskAssessmentId,
    taskSeriesId: row.taskSeriesId,
    version: row.version,
  };
}

function sectionItem(row: SectionRow, actions: readonly ActionRow[]): CarePlanSectionItem {
  return {
    id: row.id,
    domain: row.domain as CarePlanSectionItem["domain"],
    need: row.need,
    outcome: row.outcome,
    strengths: row.strengths,
    contingency: row.contingency,
    actions: actions.filter((a) => a.sectionId === row.id).map(actionItem),
    version: row.version,
  };
}

async function loadPlan(tx: Transaction, personId: string, planId: string): Promise<PlanRow> {
  const [row] = await tx
    .select()
    .from(carePlan)
    .where(and(eq(carePlan.id, planId), isNull(carePlan.deletedAt)));
  if (!row || row.personId !== personId) throw problems.notFound();
  return row;
}

function requireDraft(plan: PlanRow) {
  if (plan.status !== "draft") {
    throw problems.invalid("Only a draft can be changed. Start a new draft to revise the plan.");
  }
}

async function planParts(tx: Transaction, planId: string) {
  const sections = await tx
    .select()
    .from(carePlanSection)
    .where(and(eq(carePlanSection.planId, planId), isNull(carePlanSection.deletedAt)))
    .orderBy(asc(carePlanSection.createdAt));
  const actions = await tx
    .select()
    .from(carePlanAction)
    .where(and(eq(carePlanAction.planId, planId), isNull(carePlanAction.deletedAt)))
    .orderBy(asc(carePlanAction.createdAt));
  return { sections, actions };
}

async function planDetail(tx: Transaction, plan: PlanRow): Promise<CarePlanDetail> {
  const { sections, actions } = await planParts(tx, plan.id);
  return { ...planSummary(plan), sections: sections.map((s) => sectionItem(s, actions)) };
}

async function requireRiskAssessment(tx: Transaction, personId: string, id: string | undefined) {
  if (!id) return;
  const [row] = await tx
    .select({ personId: riskAssessment.personId })
    .from(riskAssessment)
    .where(eq(riskAssessment.id, id));
  if (row?.personId !== personId) throw problems.invalid("The risk assessment was not found.");
}

function actionCheck(
  action: { generatesTasks: boolean; recurrence: Recurrence | null; roleKey: string | null },
  today: string,
) {
  const check = checkPlanAction(
    {
      generatesTasks: action.generatesTasks,
      recurrence: action.recurrence as DomainRecurrence | null,
      roleKey: action.roleKey,
    },
    today,
  );
  if (!check.ok) throw problems.invalid(check.message);
}

function riskItem(row: RiskRow): RiskAssessmentItem {
  const findings = row.findings as RiskAssessmentItem["findings"];
  return {
    id: row.id,
    personId: row.personId,
    templateKey: row.templateKey as RiskAssessmentItem["templateKey"],
    templateVersion: row.templateVersion,
    hazard: row.hazard,
    whoAtRisk: row.whoAtRisk,
    answers: row.answers as Record<string, unknown>,
    findings,
    outsideLimits: findings.some((f) => !f.withinLimit),
    likelihood: row.likelihood,
    severity: row.severity,
    riskRating: row.riskRating,
    riskBand: row.riskBand as RiskAssessmentItem["riskBand"],
    residualLikelihood: row.residualLikelihood,
    residualSeverity: row.residualSeverity,
    residualRating: row.residualRating,
    residualBand: row.residualBand as RiskAssessmentItem["residualBand"],
    controls: row.controls,
    positiveRiskStatement: row.positiveRiskStatement,
    personViews: row.personViews,
    assessedOn: row.assessedOn,
    reviewDueOn: row.reviewDueOn,
    status: row.status as "active" | "closed",
    closedReason: row.closedReason,
    version: row.version,
  };
}

/** Checks a risk assessment against its template and the rate table; returns the columns to store. */
async function checkedRisk(
  c: Context<AppEnv>,
  tx: Transaction,
  person: { nation: "england" | "wales" | "scotland" | "northern_ireland" },
  templateKey: RiskTemplateKey,
  body: UpdateRiskAssessment | CreateRiskAssessment,
) {
  const tenantId = c.get("access").tenantId;
  const today = ukIsoDate(new Date());
  const input: RiskAssessmentInput = {
    templateKey,
    hazard: body.hazard,
    whoAtRisk: body.whoAtRisk,
    answers: body.answers,
    likelihood: body.likelihood,
    severity: body.severity,
    residualLikelihood: body.residualLikelihood,
    residualSeverity: body.residualSeverity,
    controls: body.controls,
    positiveRiskStatement: body.positiveRiskStatement,
    assessedOn: body.assessedOn,
    reviewDueOn: body.reviewDueOn ?? null,
  };
  if (body.assessedOn > today)
    throw problems.invalid("The assessment date cannot be in the future.");
  const check = checkRiskAssessment(input, {
    limits: await bedRailLimits(tx, tenantId, person.nation, today),
    reviewIntervalMonths: (await carePlanRates(tx, tenantId, person.nation, today))
      .reviewIntervalMonths,
  });
  if (!check.ok) throw problems.invalid(check.issues.map((i) => i.message).join(" "));
  const v = check.value;
  return {
    templateKey,
    templateVersion: RISK_TEMPLATES[templateKey].version,
    hazard: body.hazard,
    whoAtRisk: body.whoAtRisk,
    answers: body.answers,
    findings: v.findings,
    likelihood: body.likelihood,
    severity: body.severity,
    riskRating: v.rating,
    riskBand: v.band,
    residualLikelihood: body.residualLikelihood,
    residualSeverity: body.residualSeverity,
    residualRating: v.residualRating,
    residualBand: v.residualBand,
    controls: body.controls,
    positiveRiskStatement: body.positiveRiskStatement,
    personViews: body.personViews,
    assessedOn: body.assessedOn,
    reviewDueOn: v.reviewDueOn,
  };
}

function personName(row: { givenName: string; familyName: string }) {
  return `${row.givenName} ${row.familyName}`;
}

function audit(
  c: Context<AppEnv>,
  tx: Transaction,
  access: TenantAccess,
  input: Parameters<typeof auditInTx>[2],
) {
  return auditInTx(tx, access, { ...input, requestId: c.get("requestId") });
}

export const carePlansRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/care-plans",
      tags: ["care"],
      summary: "Care plan versions, newest first, and what is due next",
      description:
        "The first plan is due within the rate table's working days of admission (skipping bank holidays); the active plan is reviewed at the review interval and on change.",
      security,
      request: { params: PersonParam },
      responses: {
        200: jsonBody(CarePlanList, "Plans"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.plan.read");
      const { id: personId } = c.req.valid("param");
      const result = await withTenant(c, async (tx) => {
        const person = await personContext(tx, personId);
        const rows = await tx
          .select()
          .from(carePlan)
          .where(and(eq(carePlan.personId, personId), isNull(carePlan.deletedAt)))
          .orderBy(desc(carePlan.createdAt));
        const due = person.closed
          ? null
          : await carePlanDueFor(tx, {
              personId,
              nation: person.nation,
              tenantId: access.tenantId,
              now: new Date(),
            });
        await audit(c, tx, access, {
          action: "care.plan.list",
          resourceType: "person",
          resourceId: personId,
          scope: { count: rows.length },
        });
        return { items: rows.map(planSummary), due };
      });
      return c.json(result, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/care-plans",
      tags: ["care"],
      summary: "Start a draft care plan (usually from the active plan)",
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: CreateCarePlan } } },
      },
      responses: {
        201: jsonBody(CarePlanDetail, "Draft started"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.plan.write");
      const { id: personId } = c.req.valid("param");
      const body = c.req.valid("json");
      const detail = await withTenant(c, async (tx) => {
        const person = await personContext(tx, personId);
        requireOpenRecord(person);
        const current = await tx
          .select()
          .from(carePlan)
          .where(
            and(
              eq(carePlan.personId, personId),
              inArray(carePlan.status, ["draft", "active"]),
              isNull(carePlan.deletedAt),
            ),
          );
        if (current.some((p) => p.status === "draft")) {
          throw problems.conflict("A draft is already open for this person: continue that one.");
        }
        const active = current.find((p) => p.status === "active");
        const [draft] = await tx
          .insert(carePlan)
          .values({
            personId,
            locationId: person.locationId,
            status: "draft",
            basedOnPlanId: active?.id ?? null,
            summary: body.summary ?? active?.summary ?? null,
          })
          .returning()
          .catch((error: unknown) => {
            if (isUniqueViolation(error)) throw problems.conflict();
            throw error;
          });
        if (!draft) throw problems.conflict();
        if (active && body.copyFromActive) {
          const parts = await planParts(tx, active.id);
          for (const section of parts.sections) {
            const [copy] = await tx
              .insert(carePlanSection)
              .values({
                personId,
                planId: draft.id,
                domain: section.domain,
                need: section.need,
                outcome: section.outcome,
                strengths: section.strengths,
                contingency: section.contingency,
              })
              .returning({ id: carePlanSection.id });
            for (const action of parts.actions.filter((a) => a.sectionId === section.id)) {
              await tx.insert(carePlanAction).values({
                personId,
                planId: draft.id,
                sectionId: copy?.id ?? "",
                action: action.action,
                roleKey: action.roleKey,
                recurrence: action.recurrence,
                whenText: action.whenText,
                generatesTasks: action.generatesTasks,
                evidenceRequired: action.evidenceRequired,
                riskAssessmentId: action.riskAssessmentId,
              });
            }
          }
        }
        await audit(c, tx, access, {
          action: "care.plan.create",
          resourceType: "care_plan",
          resourceId: draft.id,
          scope: { basedOnPlanId: active?.id ?? null },
        });
        return planDetail(tx, draft);
      });
      return c.json(detail, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/care-plans/{planId}",
      tags: ["care"],
      summary: "One care plan version with its sections and actions",
      security,
      request: { params: PlanParams },
      responses: {
        200: jsonBody(CarePlanDetail, "Plan"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.plan.read");
      const { id: personId, planId } = c.req.valid("param");
      const detail = await withTenant(c, async (tx) => {
        await personContext(tx, personId);
        const plan = await loadPlan(tx, personId, planId);
        await audit(c, tx, access, {
          action: "care.plan.view",
          resourceType: "care_plan",
          resourceId: plan.id,
        });
        return planDetail(tx, plan);
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/people/{id}/care-plans/{planId}/sections/{domain}",
      tags: ["care"],
      summary:
        "Write one need domain of a draft: need, outcome in the person's words, strengths, contingency",
      security,
      request: {
        params: SectionParams,
        body: { content: { "application/json": { schema: UpdateCarePlanSection } } },
      },
      responses: {
        200: jsonBody(CarePlanSectionItem, "Section"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.plan.write");
      const { id: personId, planId, domain } = c.req.valid("param");
      const body = c.req.valid("json");
      const item = await withTenant(c, async (tx) => {
        const person = await personContext(tx, personId);
        requireOpenRecord(person);
        const plan = await loadPlan(tx, personId, planId);
        requireDraft(plan);
        const [existing] = await tx
          .select()
          .from(carePlanSection)
          .where(and(eq(carePlanSection.planId, planId), eq(carePlanSection.domain, domain)));
        if ((existing?.version ?? 0) !== body.version) throw problems.conflict();
        const values = {
          ...(body.need !== undefined ? { need: body.need } : {}),
          ...(body.outcome !== undefined ? { outcome: body.outcome } : {}),
          ...(body.strengths !== undefined ? { strengths: body.strengths } : {}),
          ...(body.contingency !== undefined ? { contingency: body.contingency } : {}),
        };
        const [row] = existing
          ? await tx
              .update(carePlanSection)
              .set({ ...values, deletedAt: null })
              .where(
                and(
                  eq(carePlanSection.id, existing.id),
                  eq(carePlanSection.version, existing.version),
                ),
              )
              .returning()
          : await tx
              .insert(carePlanSection)
              .values({ personId, planId, domain, ...values })
              .onConflictDoNothing()
              .returning();
        if (!row) throw problems.conflict();
        await audit(c, tx, access, {
          action: "care.plan.section.update",
          resourceType: "care_plan_section",
          resourceId: row.id,
          scope: { planId, domain },
        });
        const { actions } = await planParts(tx, planId);
        return sectionItem(row, actions);
      });
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/care-plans/{planId}/sections/{domain}/actions",
      tags: ["care"],
      summary: "Add an action to a draft section: what, who (role) and when",
      description:
        "An action that generates tasks needs a schedule in the location's time zone and a role; only an active plan's actions generate tasks.",
      security,
      request: {
        params: SectionParams,
        body: { content: { "application/json": { schema: CreateCarePlanAction } } },
      },
      responses: {
        201: jsonBody(CarePlanActionItem, "Action added"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.plan.write");
      const { id: personId, planId, domain } = c.req.valid("param");
      const body = c.req.valid("json");
      const item = await withTenant(c, async (tx) => {
        const person = await personContext(tx, personId);
        requireOpenRecord(person);
        const plan = await loadPlan(tx, personId, planId);
        requireDraft(plan);
        const [section] = await tx
          .select()
          .from(carePlanSection)
          .where(
            and(
              eq(carePlanSection.planId, planId),
              eq(carePlanSection.domain, domain),
              isNull(carePlanSection.deletedAt),
            ),
          );
        if (!section) throw problems.invalid("Record the need for this domain first.");
        actionCheck(
          {
            generatesTasks: body.generatesTasks,
            recurrence: body.recurrence ?? null,
            roleKey: body.roleKey ?? null,
          },
          ukIsoDate(new Date()),
        );
        await requireRiskAssessment(tx, personId, body.riskAssessmentId);
        const [row] = await tx
          .insert(carePlanAction)
          .values({
            personId,
            planId,
            sectionId: section.id,
            action: body.action,
            roleKey: body.roleKey ?? null,
            recurrence: body.recurrence ?? null,
            whenText: body.whenText ?? null,
            generatesTasks: body.generatesTasks,
            evidenceRequired: body.evidenceRequired,
            riskAssessmentId: body.riskAssessmentId ?? null,
          })
          .returning();
        if (!row) throw problems.conflict();
        await audit(c, tx, access, {
          action: "care.plan.action.create",
          resourceType: "care_plan_action",
          resourceId: row.id,
          scope: { planId, domain },
        });
        return actionItem(row);
      });
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/people/{id}/care-plans/{planId}/actions/{actionId}",
      tags: ["care"],
      summary: "Change or remove an action in a draft",
      security,
      request: {
        params: ActionParams,
        body: { content: { "application/json": { schema: UpdateCarePlanAction } } },
      },
      responses: {
        200: jsonBody(CarePlanActionItem, "Action"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.plan.write");
      const { id: personId, planId, actionId } = c.req.valid("param");
      const body = c.req.valid("json");
      const item = await withTenant(c, async (tx) => {
        const person = await personContext(tx, personId);
        requireOpenRecord(person);
        const plan = await loadPlan(tx, personId, planId);
        requireDraft(plan);
        const [current] = await tx
          .select()
          .from(carePlanAction)
          .where(
            and(
              eq(carePlanAction.id, actionId),
              eq(carePlanAction.planId, planId),
              isNull(carePlanAction.deletedAt),
            ),
          );
        if (!current) throw problems.notFound();
        if (current.version !== body.version) throw problems.conflict();
        const merged = {
          action: body.action ?? current.action,
          roleKey: body.roleKey !== undefined ? body.roleKey : current.roleKey,
          recurrence:
            body.recurrence !== undefined
              ? body.recurrence
              : (current.recurrence as Recurrence | null),
          whenText: body.whenText !== undefined ? body.whenText : current.whenText,
          generatesTasks: body.generatesTasks ?? current.generatesTasks,
          evidenceRequired: body.evidenceRequired ?? current.evidenceRequired,
          riskAssessmentId:
            body.riskAssessmentId !== undefined ? body.riskAssessmentId : current.riskAssessmentId,
        };
        if (!body.removed) {
          actionCheck(merged, ukIsoDate(new Date()));
          await requireRiskAssessment(tx, personId, merged.riskAssessmentId ?? undefined);
        }
        const [row] = await tx
          .update(carePlanAction)
          .set(body.removed ? { deletedAt: new Date() } : merged)
          .where(and(eq(carePlanAction.id, actionId), eq(carePlanAction.version, body.version)))
          .returning();
        if (!row) throw problems.conflict();
        await audit(c, tx, access, {
          action: body.removed ? "care.plan.action.remove" : "care.plan.action.update",
          resourceType: "care_plan_action",
          resourceId: row.id,
          scope: { planId },
        });
        return actionItem(row);
      });
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/care-plans/{planId}/publish",
      tags: ["care"],
      summary: "Publish a draft: it becomes the active plan and supersedes the previous version",
      description:
        "Needs at least one section with the need and the outcome. Sets the review date from the rate table's review interval, or earlier when asked. Answers any open first-plan or review task.",
      security,
      request: {
        params: PlanParams,
        body: { content: { "application/json": { schema: PublishCarePlan } } },
      },
      responses: {
        200: jsonBody(CarePlanDetail, "Published"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.plan.write");
      const { id: personId, planId } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const detail = await withTenant(c, async (tx) => {
        const person = await personContext(tx, personId);
        requireOpenRecord(person);
        const plan = await loadPlan(tx, personId, planId);
        if (plan.version !== body.version) throw problems.conflict();
        const { sections, actions } = await planParts(tx, planId);
        const check = checkPublication({
          status: plan.status as "draft" | "active" | "superseded",
          sections: sections.map((s) => ({
            domain: s.domain as DomainPcsp,
            need: s.need,
            outcome: s.outcome,
            actions: actions
              .filter((a) => a.sectionId === s.id)
              .map((a) => ({
                generatesTasks: a.generatesTasks,
                recurrence: a.recurrence as DomainRecurrence | null,
                roleKey: a.roleKey,
              })),
          })),
        });
        if (!check.ok) throw problems.invalid(check.issues.map((i) => i.message).join(" "));
        const [active] = await tx
          .select()
          .from(carePlan)
          .where(
            and(
              eq(carePlan.personId, personId),
              eq(carePlan.status, "active"),
              isNull(carePlan.deletedAt),
            ),
          );
        const today = ukIsoDate(now);
        let publication: ReturnType<typeof planPublication>;
        try {
          publication = planPublication(
            {
              active: active
                ? { id: active.id, publishedVersion: active.publishedVersion ?? 0 }
                : null,
              today,
              requestedReviewOn: body.reviewDueOn ?? null,
            },
            await carePlanRates(tx, access.tenantId, person.nation, today),
          );
        } catch (error) {
          if (error instanceof RangeError) throw problems.invalid(error.message);
          throw error;
        }
        if (active) {
          await tx
            .update(carePlan)
            .set({ status: "superseded", supersededAt: now, supersededByPlanId: plan.id })
            .where(eq(carePlan.id, active.id));
        }
        const [published] = await tx
          .update(carePlan)
          .set({
            status: "active",
            publishedVersion: publication.publishedVersion,
            publishedAt: now,
            publishedBy: access.tenantUserId,
            reviewDueOn: publication.reviewDueOn,
            reviewReason: null,
            reviewRequestedAt: null,
          })
          .where(and(eq(carePlan.id, plan.id), eq(carePlan.version, body.version)))
          .returning();
        if (!published) throw problems.conflict();
        for (const kind of [REVIEW_TASKS.firstPlan.kind, REVIEW_TASKS.planReview.kind]) {
          await completeOpenTasks(tx, {
            personId,
            kind,
            evidenceType: "care_plan",
            evidenceId: published.id,
            actorTenantUserId: access.tenantUserId,
            now,
          });
        }
        await audit(c, tx, access, {
          action: "care.plan.publish",
          resourceType: "care_plan",
          resourceId: published.id,
          scope: {
            publishedVersion: publication.publishedVersion,
            supersededPlanId: publication.supersedesPlanId,
          },
        });
        await publish(tx, {
          context: "care",
          aggregateType: "person",
          aggregateId: personId,
          type: "care.plan.published",
          payload: {
            planId: published.id,
            publishedVersion: publication.publishedVersion,
            supersededPlanId: publication.supersedesPlanId,
          },
        });
        return planDetail(tx, published);
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/care-plans/{planId}/sign-off",
      tags: ["care"],
      summary:
        "Record who agreed the plan: the person, a representative with authority, or why not",
      security,
      request: {
        params: PlanParams,
        body: { content: { "application/json": { schema: SignOffCarePlan } } },
      },
      responses: {
        200: jsonBody(CarePlanSummary, "Signed off"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.plan.write");
      const { id: personId, planId } = c.req.valid("param");
      const body = c.req.valid("json");
      const summary = await withTenant(c, async (tx) => {
        const person = await personContext(tx, personId);
        requireOpenRecord(person);
        const plan = await loadPlan(tx, personId, planId);
        if (plan.status === "superseded") {
          throw problems.invalid("A superseded plan cannot be signed off.");
        }
        if (plan.version !== body.version) throw problems.conflict();
        let representativeName = body.representativeName ?? null;
        if (body.contactId) {
          const [found] = await tx
            .select()
            .from(contact)
            .where(and(eq(contact.id, body.contactId), eq(contact.personId, personId)));
          if (!found) throw problems.invalid("The contact was not found.");
          representativeName ??= personName(found);
        }
        const signOff: SignOff =
          body.agreedBy === "representative"
            ? { agreedBy: "representative", representativeName, authority: body.authority }
            : body.agreedBy === "unable"
              ? { agreedBy: "unable", reason: body.unableReason }
              : { agreedBy: "person" };
        const check = checkSignOff(signOff);
        if (!check.ok) throw problems.invalid(check.message);
        const representative = body.agreedBy === "representative";
        const [row] = await tx
          .update(carePlan)
          .set({
            signOffKind: body.agreedBy,
            signOffRepresentativeName: representative ? representativeName : null,
            signOffAuthority: representative ? (body.authority ?? null) : null,
            signOffContactId: representative ? (body.contactId ?? null) : null,
            signOffUnableReason: body.agreedBy === "unable" ? (body.unableReason ?? null) : null,
            signedOffAt: new Date(),
            signedOffRecordedBy: access.tenantUserId,
          })
          .where(and(eq(carePlan.id, plan.id), eq(carePlan.version, body.version)))
          .returning();
        if (!row) throw problems.conflict();
        await audit(c, tx, access, {
          action: "care.plan.sign_off",
          resourceType: "care_plan",
          resourceId: row.id,
          scope: { agreedBy: body.agreedBy },
        });
        return planSummary(row);
      });
      return c.json(summary, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/care/risk-templates",
      tags: ["care"],
      summary: "Risk assessment templates with their questions, controls and rate-table limits",
      security,
      responses: { 200: jsonBody(RiskTemplateList, "Templates"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.plan.read");
      const list = await withTenant(c, async (tx) => {
        const [own] = await tx
          .select({ nation: tenant.nation })
          .from(tenant)
          .where(eq(tenant.id, access.tenantId));
        const limits = await bedRailLimits(
          tx,
          access.tenantId,
          own?.nation ?? "england",
          ukIsoDate(new Date()),
        );
        return {
          items: Object.values(RISK_TEMPLATES).map((t) => ({
            key: t.key,
            title: t.title,
            version: t.version,
            source: t.source,
            rated: t.rating === "matrix",
            questions: t.questions.map((q) => ({
              key: q.key,
              text: q.text,
              kind: q.kind,
              limit:
                q.kind === "measurement_mm"
                  ? {
                      rateKey: q.limit.rateKey,
                      valueMm: limits[q.limit.rateKey],
                      rule: q.limit.rule,
                      whenYes: q.limit.whenYes
                        ? {
                            questionKey: q.limit.whenYes.questionKey,
                            rateKey: q.limit.whenYes.rateKey,
                            valueMm: limits[q.limit.whenYes.rateKey],
                          }
                        : null,
                    }
                  : null,
            })),
            suggestedControls: [...t.suggestedControls],
          })),
          matrix: {
            source: RISK_MATRIX_SOURCE,
            likelihood: [...LIKELIHOOD_LABELS],
            severity: [...SEVERITY_LABELS],
          },
        };
      });
      return c.json(list, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/risk-assessments",
      tags: ["care"],
      summary: "The person's risk assessments (active by default)",
      security,
      request: {
        params: PersonParam,
        query: z.object({ status: z.enum(["active", "closed", "all"]).default("active") }),
      },
      responses: {
        200: jsonBody(RiskAssessmentList, "Risk assessments"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.plan.read");
      const { id: personId } = c.req.valid("param");
      const { status } = c.req.valid("query");
      const items = await withTenant(c, async (tx) => {
        await personContext(tx, personId);
        const rows = await tx
          .select()
          .from(riskAssessment)
          .where(
            and(
              eq(riskAssessment.personId, personId),
              isNull(riskAssessment.deletedAt),
              status === "all" ? undefined : eq(riskAssessment.status, status),
            ),
          )
          .orderBy(asc(riskAssessment.reviewDueOn));
        await audit(c, tx, access, {
          action: "care.risk.list",
          resourceType: "person",
          resourceId: personId,
          scope: { count: rows.length, status },
        });
        return rows.map(riskItem);
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/risk-assessments",
      tags: ["care"],
      summary: "Record a positive risk assessment from a template",
      description:
        "Likelihood and severity are the assessor's judgements, rated with the NPSA matrix; falls are never rated (NICE NG249). Bed rail gaps are checked against the MHRA figures in the rate table.",
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: CreateRiskAssessment } } },
      },
      responses: {
        201: jsonBody(RiskAssessmentItem, "Saved"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.plan.write");
      const { id: personId } = c.req.valid("param");
      const body = c.req.valid("json");
      const item = await withTenant(c, async (tx) => {
        const person = await personContext(tx, personId);
        requireOpenRecord(person);
        const values = await checkedRisk(c, tx, person, body.templateKey, body);
        const [row] = await tx
          .insert(riskAssessment)
          .values({ personId, ...values })
          .returning();
        if (!row) throw problems.conflict();
        await audit(c, tx, access, {
          action: "care.risk.create",
          resourceType: "risk_assessment",
          resourceId: row.id,
          scope: { templateKey: row.templateKey },
        });
        return riskItem(row);
      });
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/people/{id}/risk-assessments/{riskId}",
      tags: ["care"],
      summary: "Review a risk assessment (the earlier version stays in its history)",
      security,
      request: {
        params: RiskParams,
        body: { content: { "application/json": { schema: UpdateRiskAssessment } } },
      },
      responses: {
        200: jsonBody(RiskAssessmentItem, "Saved"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.plan.write");
      const { id: personId, riskId } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const item = await withTenant(c, async (tx) => {
        const person = await personContext(tx, personId);
        requireOpenRecord(person);
        const [current] = await tx
          .select()
          .from(riskAssessment)
          .where(and(eq(riskAssessment.id, riskId), isNull(riskAssessment.deletedAt)));
        if (current?.personId !== personId) throw problems.notFound();
        if (current.status !== "active") {
          throw problems.invalid("A closed risk assessment cannot change. Record a new one.");
        }
        if (current.version !== body.version) throw problems.conflict();
        const values = await checkedRisk(
          c,
          tx,
          person,
          current.templateKey as RiskTemplateKey,
          body,
        );
        const [row] = await tx
          .update(riskAssessment)
          .set(values)
          .where(and(eq(riskAssessment.id, riskId), eq(riskAssessment.version, body.version)))
          .returning();
        if (!row) throw problems.conflict();
        await completeOpenTasks(tx, {
          personId,
          kind: REVIEW_TASKS.riskReview.kind,
          sourceId: row.id,
          evidenceType: "risk_assessment",
          evidenceId: row.id,
          actorTenantUserId: access.tenantUserId,
          now,
        });
        await audit(c, tx, access, {
          action: "care.risk.review",
          resourceType: "risk_assessment",
          resourceId: row.id,
        });
        return riskItem(row);
      });
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/risk-assessments/{riskId}/close",
      tags: ["care"],
      summary: "Close a risk assessment that no longer applies, with the reason",
      security,
      request: {
        params: RiskParams,
        body: { content: { "application/json": { schema: CloseRiskAssessment } } },
      },
      responses: {
        200: jsonBody(RiskAssessmentItem, "Closed"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.plan.write");
      const { id: personId, riskId } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const item = await withTenant(c, async (tx) => {
        const person = await personContext(tx, personId);
        requireOpenRecord(person);
        const [row] = await tx
          .update(riskAssessment)
          .set({ status: "closed", closedReason: body.reason, closedAt: now })
          .where(
            and(
              eq(riskAssessment.id, riskId),
              eq(riskAssessment.personId, personId),
              eq(riskAssessment.status, "active"),
              eq(riskAssessment.version, body.version),
            ),
          )
          .returning();
        if (!row) {
          const [exists] = await tx
            .select({ id: riskAssessment.id })
            .from(riskAssessment)
            .where(and(eq(riskAssessment.id, riskId), eq(riskAssessment.personId, personId)));
          throw exists ? problems.conflict() : problems.notFound();
        }
        await completeOpenTasks(tx, {
          personId,
          kind: REVIEW_TASKS.riskReview.kind,
          sourceId: row.id,
          evidenceType: "risk_assessment",
          evidenceId: row.id,
          actorTenantUserId: access.tenantUserId,
          now,
        });
        await audit(c, tx, access, {
          action: "care.risk.close",
          resourceType: "risk_assessment",
          resourceId: row.id,
          reason: body.reason,
        });
        return riskItem(row);
      });
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/care-history/{table}/{recordId}",
      tags: ["care"],
      summary:
        "Every earlier version of a care plan, section, action, risk assessment or advance care record",
      security,
      request: { params: HistoryParams },
      responses: {
        200: jsonBody(RecordHistory, "History"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.plan.read");
      const { id: personId, table, recordId } = c.req.valid("param");
      const versions = await withTenant(c, async (tx) => {
        await personContext(tx, personId);
        const source = HISTORY_TABLES[table];
        const [record] = await tx
          .select({ personId: source.personId })
          .from(source)
          .where(eq(source.id, recordId));
        if (record?.personId !== personId) throw problems.notFound();
        const rows = await tx
          .select()
          .from(recordVersion)
          .where(and(eq(recordVersion.tableName, table), eq(recordVersion.recordId, recordId)))
          .orderBy(asc(recordVersion.recordVersion));
        await audit(c, tx, access, {
          action: "care.history.view",
          resourceType: table,
          resourceId: recordId,
        });
        return rows;
      });
      return c.json(
        {
          table,
          recordId,
          versions: versions.map((v) => ({
            version: v.recordVersion,
            validFrom: v.validFrom.toISOString(),
            validTo: v.validTo.toISOString(),
            changedBy: v.changedBy,
            data: v.data as Record<string, unknown>,
          })),
        },
        200,
      );
    },
  );
