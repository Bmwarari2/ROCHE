import {
  BestInterestsItem,
  BestInterestsList,
  CapacityAssessmentItem,
  CapacityAssessmentList,
  ConsentItem,
  ConsentList,
  type ConsentRepresentative,
  CreateBestInterests,
  CreateCapacityAssessment,
  CreateConsent,
  DolsInput,
  DolsItem,
  DolsList,
  LegalChangeReviewAction,
  type LegalChangeReviewInput as LegalChangeReviewInputContract,
  LegalChangeReviewItem,
  LegalChangeReviewList,
  UpdateDols,
  WithdrawConsent,
} from "@harbour/contracts";
import {
  bestInterestsDecision,
  capacityAssessment,
  consentRecord,
  dolsAuthorisation,
  dolsLegalChangeReview,
  statutoryNotification,
  type Transaction,
} from "@harbour/db";
import {
  authorisationsAwaitingLegalChangeReview,
  type BestInterestsItemKey,
  type CapacityAtConsent,
  type ChecklistAnswer,
  CONSENT_DECISION_KINDS,
  CONSENT_DECISIONS,
  type ConsentDecisionKind,
  type ConsulteeKind,
  capacityFinding,
  checkBestInterests,
  checkCapacityAssessment,
  checkConsentRecord,
  checkDolsAuthorisation,
  checkLegalChangeReview,
  consentStatus,
  DOLS_LEGAL_CHANGE,
  DOLS_LEGAL_CHANGE_REVIEW_WORKFLOW,
  type DolsAuthorisationView,
  type DolsNation,
  type DolsRates,
  dolsCqcNotification,
  dolsEndsAt,
  dolsReminders,
  dolsStatus,
  type FunctionalElement,
  type LegalChangeReviewInput,
  type LegalChangeReviewState,
  legalChangeReviewEnabled,
  legalChangeStepProblems,
  type RepresentativeAuthority,
  ukIsoDate,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx } from "../http/audit";
import { type AppEnv, requirePermission, type TenantAccess, withTenant } from "../http/context";
import { problems } from "../http/problem";
import { publish } from "../outbox";
import { personContext } from "../services/care";
import { capacityViews, consentView, flagRows } from "../services/mca";
import {
  dolsRates,
  draftDolsOutcomeNotification,
  isDolsNation,
  toDolsView,
} from "../services/safety";
import { startWorkflow } from "../services/workflow";
import { iso, PersonParam, requireOpenRecord } from "./care-shared";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import { moveOrRefuse } from "./workflow-shared";

/**
 * Consent, mental capacity, best interests and the DoLS register (master prompt 10.4;
 * docs/specs/care.md rules 9 to 11; register rows CARE-021 and CARE-022; hazards HZ-020 and
 * HZ-026). Every rule is the domain's (`care/mca/*`): the routes gather the inputs, refuse what
 * the rules refuse with their words, and store the outcome. Reads and writes are audited by
 * record id, never content.
 */

const ConsentParams = PersonParam.extend({ consentId: z.uuid() });
const DolsParams = PersonParam.extend({ dolsId: z.uuid() });
const ReviewParams = z.object({ authorisationId: z.uuid() });

type ConsentRow = typeof consentRecord.$inferSelect;
type CapacityRow = typeof capacityAssessment.$inferSelect;
type BestInterestsRow = typeof bestInterestsDecision.$inferSelect;
type DolsRow = typeof dolsAuthorisation.$inferSelect;
type ReviewRow = typeof dolsLegalChangeReview.$inferSelect;

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

/** A foreign key that points nowhere (a contact or document of someone else) reads as not found. */
function notFoundOnForeignKey(what: string) {
  return (error: unknown): never => {
    if (dbCode(error) === "23503") throw problems.invalid(`The ${what} was not found.`);
    throw error;
  };
}

const issuesMessage = (issues: readonly { message: string }[]) =>
  issues.map((i) => i.message).join(" ");

// ------------------------------------------------------------------------------------------------
// Consent
// ------------------------------------------------------------------------------------------------

function representativeOut(row: ConsentRow): ConsentRepresentative | null {
  if (!row.representativeKind) return null;
  return {
    kind: row.representativeKind as ConsentRepresentative["kind"],
    ...(row.representativeContactId ? { contactId: row.representativeContactId } : {}),
    ...(row.representativeName ? { name: row.representativeName } : {}),
    ...(row.lpaRegistered !== null ? { registered: row.lpaRegistered } : {}),
    ...(row.opgReference ? { opgReference: row.opgReference } : {}),
    excludedDecisions: row.excludedDecisions as ConsentDecisionKind[],
    ...(row.deputyScope
      ? { deputyScope: row.deputyScope as "personal_welfare" | "property_and_affairs" }
      : {}),
    deputyDecisions: row.deputyDecisions as ConsentDecisionKind[],
    ...(row.deputyRestraintAuthorised !== null
      ? { restraintExpresslyAuthorised: row.deputyRestraintAuthorised }
      : {}),
    ...(row.deputyOrderEndsAt ? { orderEndsAt: row.deputyOrderEndsAt.toISOString() } : {}),
    ...(row.courtReference ? { courtReference: row.courtReference } : {}),
  };
}

function consentItem(row: ConsentRow): ConsentItem {
  return {
    id: row.id,
    personId: row.personId,
    decision: row.decision as ConsentDecisionKind,
    outcome: row.outcome as "given" | "refused",
    givenBy: row.givenByKind as "person" | "representative",
    representative: representativeOut(row),
    capacityStatus: row.capacityStatus as ConsentItem["capacityStatus"],
    capacityAssessmentId: row.capacityAssessmentId,
    givenAt: row.givenAt.toISOString(),
    expiresAt: iso(row.expiresAt),
    withdrawnAt: iso(row.withdrawnAt),
    withdrawnReason: row.withdrawnReason,
    evidence: row.evidence,
    evidenceDocumentId: row.evidenceDocumentId,
    restraintConditions:
      row.restraintNecessary === null || row.restraintProportionate === null
        ? null
        : {
            necessaryToPreventHarm: row.restraintNecessary,
            proportionate: row.restraintProportionate,
          },
    bestInterestsDecisionId: row.bestInterestsDecisionId,
    recordedBy: row.createdBy,
    version: row.version,
  };
}

/** The authority as `checkConsentRecord` reads it, from the request. */
function authorityFrom(rep: ConsentRepresentative): RepresentativeAuthority {
  switch (rep.kind) {
    case "lpa_health_welfare":
      return {
        kind: rep.kind,
        registered: rep.registered === true,
        excludedDecisions: rep.excludedDecisions,
        opgReference: rep.opgReference ?? null,
      };
    case "lpa_property_financial":
      return { kind: rep.kind, registered: rep.registered === true };
    case "deputy":
      if (!rep.deputyScope) {
        throw problems.invalid("Record whether the deputy's order covers personal welfare.");
      }
      return {
        kind: rep.kind,
        scope: rep.deputyScope,
        decisions: rep.deputyDecisions,
        restraintExpresslyAuthorised: rep.restraintExpresslyAuthorised === true,
        orderEndsAt: rep.orderEndsAt ? new Date(rep.orderEndsAt) : null,
        courtReference: rep.courtReference ?? null,
      };
    default:
      return { kind: rep.kind };
  }
}

async function personCapacity(tx: Transaction, personId: string) {
  const rows = await tx
    .select()
    .from(capacityAssessment)
    .where(eq(capacityAssessment.personId, personId));
  return capacityViews(rows);
}

// ------------------------------------------------------------------------------------------------
// Capacity and best interests
// ------------------------------------------------------------------------------------------------

function capacityItem(row: CapacityRow, superseded: ReadonlySet<string>): CapacityAssessmentItem {
  return {
    id: row.id,
    personId: row.personId,
    decision: row.decision,
    decisionKind: (row.decisionKind ?? null) as ConsentDecisionKind | null,
    assessedAt: row.assessedAt.toISOString(),
    assessorTenantUserId: row.assessorTenantUserId,
    assessorName: row.assessorName,
    assessorRole: row.assessorRole,
    practicableSteps: row.practicableSteps as CapacityAssessmentItem["practicableSteps"],
    stage1: { impairment: row.stage1Impairment, description: row.stage1Description },
    stage2: row.stage2 as CapacityAssessmentItem["stage2"],
    inabilityBecauseOfImpairment: row.inabilityBecauseOfImpairment,
    outcome: row.outcome as "has_capacity" | "lacks_capacity",
    unableTo: row.unableTo,
    reason: row.reason,
    reviewOn: row.reviewOn,
    recordedAt: row.recordedAt.toISOString(),
    recordedBy: row.createdBy,
    supersedesId: row.supersedesId,
    correctionReason: row.correctionReason,
    superseded: superseded.has(row.id),
  };
}

function bestInterestsItem(
  row: BestInterestsRow,
  superseded: ReadonlySet<string>,
): BestInterestsItem {
  return {
    id: row.id,
    personId: row.personId,
    capacityAssessmentId: row.capacityAssessmentId,
    decision: row.decision,
    decidedAt: row.decidedAt.toISOString(),
    checklist: row.checklist as BestInterestsItem["checklist"],
    consultations: row.consultations as BestInterestsItem["consultations"],
    noConsultationReason: row.noConsultationReason,
    seriousMedicalTreatment: row.seriousMedicalTreatment,
    accommodationChange: row.accommodationChange,
    imcaPrompt: row.imcaPrompt,
    reviewOn: row.reviewOn,
    recordedAt: row.recordedAt.toISOString(),
    recordedBy: row.createdBy,
    supersedesId: row.supersedesId,
    correctionReason: row.correctionReason,
    superseded: superseded.has(row.id),
  };
}

const supersededSet = (rows: readonly { supersedesId: string | null }[]) =>
  new Set(rows.flatMap((r) => (r.supersedesId ? [r.supersedesId] : [])));

// ------------------------------------------------------------------------------------------------
// DoLS
// ------------------------------------------------------------------------------------------------

function dolsViewFrom(body: DolsInput, nation: DolsNation, id: string): DolsAuthorisationView {
  const date = (v: string | null | undefined) => (v ? new Date(v) : null);
  return {
    id,
    type: body.type,
    nation,
    requestedAt: new Date(body.requestedAt),
    outcome: body.outcome,
    outcomeAt: date(body.outcomeAt),
    grantedFrom: date(body.grantedFrom),
    grantedTo: date(body.grantedTo),
    extensions: body.extensions.map((e) => ({
      requestedAt: new Date(e.requestedAt),
      outcome: e.outcome,
      extendedTo: date(e.extendedTo),
    })),
    precededByUrgent: body.precededByUrgent,
    withdrawalReason: body.withdrawalReason ?? null,
    endedAt: date(body.endedAt),
  };
}

function dolsValues(body: DolsInput) {
  const date = (v: string | null | undefined) => (v ? new Date(v) : null);
  return {
    type: body.type,
    requestedAt: new Date(body.requestedAt),
    outcome: body.outcome,
    outcomeAt: date(body.outcomeAt),
    grantedFrom: date(body.grantedFrom),
    grantedTo: date(body.grantedTo),
    extensions: body.extensions,
    precededByUrgent: body.precededByUrgent,
    precededByAuthorisationId: body.precededByAuthorisationId ?? null,
    withdrawalReason: body.withdrawalReason ?? null,
    endedAt: date(body.endedAt),
    endedReason: body.endedReason ?? null,
    conditions: body.conditions ?? null,
    rprName: body.rprName ?? null,
    rprContactId: body.rprContactId ?? null,
    supervisoryBody: body.supervisoryBody ?? null,
    supervisoryBodyReference: body.supervisoryBodyReference ?? null,
    objectionEvidence: body.objectionEvidence ?? null,
  };
}

async function dolsItems(
  tx: Transaction,
  tenantId: string,
  rows: readonly DolsRow[],
  now: Date,
): Promise<DolsItem[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const notifications = await tx
    .select()
    .from(statutoryNotification)
    .where(inArray(statutoryNotification.dolsAuthorisationId, ids));
  const reviews = await tx
    .select({ id: dolsLegalChangeReview.dolsAuthorisationId, state: dolsLegalChangeReview.state })
    .from(dolsLegalChangeReview)
    .where(inArray(dolsLegalChangeReview.dolsAuthorisationId, ids));
  const ratesByNation = new Map<DolsNation, DolsRates>();
  const items: DolsItem[] = [];
  for (const row of rows) {
    const nation = row.nation as DolsNation;
    const rates =
      ratesByNation.get(nation) ?? (await dolsRates(tx, tenantId, nation, ukIsoDate(now)));
    ratesByNation.set(nation, rates);
    const view = toDolsView(row);
    const status = dolsStatus(view, rates, now);
    const decision = dolsCqcNotification(view);
    const draft = notifications.find((n) => n.dolsAuthorisationId === row.id);
    items.push({
      id: row.id,
      personId: row.personId,
      locationId: row.locationId,
      type: row.type as DolsItem["type"],
      nation,
      requestedAt: row.requestedAt.toISOString(),
      outcome: row.outcome as DolsItem["outcome"],
      outcomeAt: iso(row.outcomeAt),
      grantedFrom: iso(row.grantedFrom),
      grantedTo: iso(row.grantedTo),
      extensions: row.extensions as DolsItem["extensions"],
      precededByUrgent: row.precededByUrgent,
      precededByAuthorisationId: row.precededByAuthorisationId,
      withdrawalReason: row.withdrawalReason,
      endedAt: iso(row.endedAt),
      endedReason: row.endedReason,
      conditions: row.conditions,
      rprName: row.rprName,
      rprContactId: row.rprContactId,
      supervisoryBody: row.supervisoryBody,
      supervisoryBodyReference: row.supervisoryBodyReference,
      objectionEvidence: row.objectionEvidence,
      status: status.status,
      endsAt: iso(status.endsAt),
      daysLeft: status.daysLeft,
      reminders: dolsReminders(view, rates).map((r) => ({
        key: r.key,
        daysBefore: r.daysBefore,
        dueAt: r.dueAt.toISOString(),
      })),
      cqcNotification: {
        required: decision.required,
        reason: decision.reason,
        notificationId: draft?.id ?? null,
        status: (draft?.status ?? null) as DolsItem["cqcNotification"]["status"],
        dueAt: iso(draft?.dueAt ?? null),
      },
      legalChangeReview: (reviews.find((r) => r.id === row.id)?.state ??
        null) as DolsItem["legalChangeReview"],
      version: row.version,
    });
  }
  return items;
}

/** The DoLS outcome is known: the CQC draft (reg 18(4A)) and `care.dols.outcome_known`. */
async function outcomeKnown(
  tx: Transaction,
  tenantId: string,
  row: DolsRow,
  now: Date,
): Promise<void> {
  const draft = await draftDolsOutcomeNotification(tx, tenantId, row, now);
  await publish(tx, {
    context: "care",
    aggregateType: "dols_authorisation",
    aggregateId: row.id,
    type: "care.dols.outcome_known",
    payload: {
      dolsAuthorisationId: row.id,
      outcome: row.outcome,
      cqcNotificationRequired: draft.required,
      notificationId: draft.notificationId,
    },
  });
}

async function checkedDols(
  tx: Transaction,
  tenantId: string,
  body: DolsInput,
  nation: DolsNation,
  id: string,
  now: Date,
) {
  const view = dolsViewFrom(body, nation, id);
  const rates = await dolsRates(tx, tenantId, nation, ukIsoDate(now));
  const issues = checkDolsAuthorisation(view, rates);
  if (issues.length > 0) throw problems.invalid(issuesMessage(issues));
  if (view.requestedAt.getTime() > now.getTime()) {
    throw problems.invalid("The request date cannot be in the future.");
  }
}

// ------------------------------------------------------------------------------------------------
// Legal-change review
// ------------------------------------------------------------------------------------------------

function reviewInputFrom(row: ReviewRow | undefined): LegalChangeReviewInputContract | null {
  if (!row) return null;
  const signs = row.consentSigns as Partial<LegalChangeReviewInputContract["consent"]>;
  return {
    factors: row.factors as LegalChangeReviewInputContract["factors"],
    objection: (row.objection ?? null) as LegalChangeReviewInputContract["objection"],
    objectionForms: row.objectionForms as LegalChangeReviewInputContract["objectionForms"],
    consent: {
      consciousOfEnvironment: signs.consciousOfEnvironment ?? null,
      basicUnderstanding: signs.basicUnderstanding ?? null,
      expressesAcceptance: signs.expressesAcceptance ?? null,
      seriousDoubt: signs.seriousDoubt ?? null,
    },
    decision: (row.decision ?? null) as LegalChangeReviewInputContract["decision"],
    decidedAt: iso(row.decidedAt),
    referral: row.referralSentAt
      ? { sentAt: row.referralSentAt.toISOString(), reference: row.referralReference }
      : null,
  };
}

const EMPTY_REVIEW: LegalChangeReviewInputContract = {
  factors: {},
  objection: null,
  objectionForms: [],
  consent: {
    consciousOfEnvironment: null,
    basicUnderstanding: null,
    expressesAcceptance: null,
    seriousDoubt: null,
  },
  decision: null,
  decidedAt: null,
  referral: null,
};

function domainReview(
  input: LegalChangeReviewInputContract,
  decidedBy: string | null,
): LegalChangeReviewInput {
  return {
    factors: input.factors,
    objection: input.objection,
    objectionForms: input.objectionForms,
    consent: input.consent,
    decision: input.decision,
    decidedAt: input.decidedAt ? new Date(input.decidedAt) : null,
    decidedBy,
    referral: input.referral
      ? { sentAt: new Date(input.referral.sentAt), reference: input.referral.reference }
      : null,
  };
}

const STEP_MESSAGES = {
  review_incomplete: "Complete the review before recording it as reviewed.",
  referral_required:
    "Ask the local authority to review the authorisation before closing: record the referral first.",
  referral_missing: "Record when the request went to the local authority.",
  authorisation_still_in_force:
    "The authorisation is still in force: record the review before closing it.",
} as const;

function reviewItem(
  auth: DolsRow,
  row: ReviewRow | undefined,
  endsAt: Date | null,
): LegalChangeReviewItem {
  return {
    id: row?.id ?? null,
    authorisationId: auth.id,
    personId: auth.personId,
    locationId: auth.locationId,
    type: auth.type as LegalChangeReviewItem["type"],
    grantedFrom: iso(auth.grantedFrom),
    endsAt: iso(endsAt),
    state: (row?.state ?? "awaiting_review") as LegalChangeReviewState,
    review: reviewInputFrom(row),
    decidedBy: row?.decidedBy ?? null,
    referralRequired: row?.referralRequired ?? false,
    prompts: row?.prompts ?? [],
    closedReason: row?.closedReason ?? null,
    version: row?.version ?? 0,
  };
}

// ------------------------------------------------------------------------------------------------
// Routes
// ------------------------------------------------------------------------------------------------

export const mcaRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/consents",
      tags: ["care"],
      summary: "Consent records, and whether a valid consent exists for each decision now",
      description:
        "Each decision's status comes from consentStatus: the latest record decides, a refusal or withdrawal replaces an earlier consent, expired consent is not valid, and a representative's consent stops applying once the person has capacity (care.md rule 9; HZ-026).",
      security,
      request: { params: PersonParam },
      responses: { 200: jsonBody(ConsentList, "Consents"), ...errorResponses, ...notFoundResponse },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.plan.read");
      const { id: personId } = c.req.valid("param");
      const now = new Date();
      const result = await withTenant(c, async (tx) => {
        await personContext(tx, personId);
        const rows = await tx
          .select()
          .from(consentRecord)
          .where(and(eq(consentRecord.personId, personId), isNull(consentRecord.deletedAt)))
          .orderBy(desc(consentRecord.givenAt));
        const assessments = await personCapacity(tx, personId);
        const views = rows.map(consentView);
        const today = ukIsoDate(now);
        const decisions = CONSENT_DECISION_KINDS.map((decision) => {
          const finding = capacityFinding(assessments, decision, now, today);
          const status = consentStatus(views, decision, now, finding.status);
          return {
            decision,
            label: CONSENT_DECISIONS[decision].label,
            status: status.status,
            recordId: status.record?.id ?? null,
            message: status.status === "valid" ? null : status.message,
            problems: status.status === "none" ? status.issues.map((i) => i.problem) : [],
            capacity: finding.status,
            capacityReviewOverdue: finding.status === "assumed" ? false : finding.reviewOverdue,
          };
        });
        await audit(c, tx, access, {
          action: "care.consent.list",
          resourceType: "person",
          resourceId: personId,
          scope: { count: rows.length },
        });
        return { items: rows.map(consentItem), decisions };
      });
      return c.json(result, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/consents",
      tags: ["care"],
      summary: "Record a consent or a refusal for one decision",
      description:
        "Refused with the reasons when checkConsentRecord finds a problem: a representative without authority for the decision, an unregistered attorney, a deputy outside their order, the person's own consent while assessed as lacking capacity, bed rails without the restraint conditions, or covert medicines without a lack of capacity and a best-interests decision (HZ-026). The capacity status comes from the person's assessments of the decision.",
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: CreateConsent } } },
      },
      responses: {
        201: jsonBody(ConsentItem, "Consent recorded"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.capacity.write");
      const { id: personId } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const item = await withTenant(c, async (tx) => {
        const person = await personContext(tx, personId);
        requireOpenRecord(person);
        const givenAt = new Date(body.givenAt);
        if (givenAt.getTime() > now.getTime()) {
          throw problems.invalid("A consent cannot be dated in the future.");
        }
        if (body.expiresAt && new Date(body.expiresAt).getTime() <= givenAt.getTime()) {
          throw problems.invalid("The consent must expire after it was given.");
        }
        if ((body.givenBy === "representative") !== (body.representative !== undefined)) {
          throw problems.invalid(
            body.givenBy === "representative"
              ? "Say who the representative is and what authority they hold."
              : "A consent given by the person has no representative.",
          );
        }
        const finding = capacityFinding(
          await personCapacity(tx, personId),
          body.decision,
          givenAt,
          ukIsoDate(now),
        );
        const capacity: CapacityAtConsent =
          finding.status === "assumed"
            ? { status: "assumed" }
            : { status: finding.status, assessmentId: finding.assessment.id };
        const rep = body.representative;
        const issues = checkConsentRecord(
          {
            id: "new",
            decision: body.decision,
            outcome: body.outcome,
            givenBy: rep
              ? { kind: "representative", authority: authorityFrom(rep) }
              : { kind: "person" },
            capacity,
            givenAt,
            expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
            withdrawnAt: null,
            evidence: body.evidence,
            restraintConditions: body.restraintConditions ?? null,
            bestInterestsDecisionId: body.bestInterestsDecisionId ?? null,
          },
          givenAt,
        );
        if (issues.length > 0) throw problems.invalid(issuesMessage(issues));
        const [row] = await tx
          .insert(consentRecord)
          .values({
            personId,
            decision: body.decision,
            outcome: body.outcome,
            givenByKind: body.givenBy,
            representativeKind: rep?.kind ?? null,
            representativeContactId: rep?.contactId ?? null,
            representativeName: rep?.name ?? null,
            lpaRegistered: rep?.registered ?? null,
            opgReference: rep?.opgReference ?? null,
            excludedDecisions: rep?.excludedDecisions ?? [],
            deputyScope: rep?.deputyScope ?? null,
            deputyDecisions: rep?.deputyDecisions ?? [],
            deputyRestraintAuthorised: rep?.restraintExpresslyAuthorised ?? null,
            deputyOrderEndsAt: rep?.orderEndsAt ? new Date(rep.orderEndsAt) : null,
            courtReference: rep?.courtReference ?? null,
            capacityStatus: capacity.status,
            capacityAssessmentId: capacity.status === "assumed" ? null : capacity.assessmentId,
            givenAt,
            expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
            evidence: body.evidence,
            evidenceDocumentId: body.evidenceDocumentId ?? null,
            restraintNecessary: body.restraintConditions?.necessaryToPreventHarm ?? null,
            restraintProportionate: body.restraintConditions?.proportionate ?? null,
            bestInterestsDecisionId: body.bestInterestsDecisionId ?? null,
          })
          .returning()
          .catch(notFoundOnForeignKey("contact, document or best-interests decision"));
        if (!row) throw problems.conflict();
        await audit(c, tx, access, {
          action: "care.consent.create",
          resourceType: "consent_record",
          resourceId: row.id,
          scope: { decision: row.decision, outcome: row.outcome },
        });
        return consentItem(row);
      });
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/consents/{consentId}/withdraw",
      tags: ["care"],
      summary: "Record that a consent was withdrawn (the record stays, with the reason)",
      security,
      request: {
        params: ConsentParams,
        body: { content: { "application/json": { schema: WithdrawConsent } } },
      },
      responses: {
        200: jsonBody(ConsentItem, "Consent withdrawn"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.capacity.write");
      const { id: personId, consentId } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const item = await withTenant(c, async (tx) => {
        await personContext(tx, personId);
        const [existing] = await tx
          .select()
          .from(consentRecord)
          .where(and(eq(consentRecord.id, consentId), isNull(consentRecord.deletedAt)));
        if (!existing || existing.personId !== personId) throw problems.notFound();
        if (existing.version !== body.version) throw problems.conflict();
        if (existing.withdrawnAt) throw problems.invalid("This consent is already withdrawn.");
        const withdrawnAt = body.withdrawnAt ? new Date(body.withdrawnAt) : now;
        if (withdrawnAt.getTime() > now.getTime() || withdrawnAt < existing.givenAt) {
          throw problems.invalid("The withdrawal must be after the consent and not in the future.");
        }
        const [row] = await tx
          .update(consentRecord)
          .set({ withdrawnAt, withdrawnReason: body.reason })
          .where(and(eq(consentRecord.id, consentId), eq(consentRecord.version, body.version)))
          .returning();
        if (!row) throw problems.conflict();
        await audit(c, tx, access, {
          action: "care.consent.withdraw",
          resourceType: "consent_record",
          resourceId: row.id,
        });
        return consentItem(row);
      });
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/capacity-assessments",
      tags: ["care"],
      summary: "Capacity assessments, newest first (corrections supersede)",
      security,
      request: { params: PersonParam },
      responses: {
        200: jsonBody(CapacityAssessmentList, "Assessments"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.plan.read");
      const { id: personId } = c.req.valid("param");
      const items = await withTenant(c, async (tx) => {
        await personContext(tx, personId);
        const rows = await tx
          .select()
          .from(capacityAssessment)
          .where(eq(capacityAssessment.personId, personId))
          .orderBy(desc(capacityAssessment.assessedAt));
        await audit(c, tx, access, {
          action: "care.capacity.list",
          resourceType: "person",
          resourceId: personId,
          scope: { count: rows.length },
        });
        const superseded = supersededSet(rows);
        return rows.map((r) => capacityItem(r, superseded));
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/capacity-assessments",
      tags: ["care"],
      summary: "Record a capacity assessment for one decision (append-only)",
      description:
        "checkCapacityAssessment refuses an assessment of 'everything', one dated in the future, missing answers, and an outcome the two-stage test does not support (MCA 2005 s.1 to s.3; HZ-026). A replayed upload with the same id is ignored.",
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: CreateCapacityAssessment } } },
      },
      responses: {
        201: jsonBody(CapacityAssessmentItem, "Assessment recorded (or the earlier copy)"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.capacity.write");
      const { id: personId } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const item = await withTenant(c, async (tx) => {
        const person = await personContext(tx, personId);
        requireOpenRecord(person);
        if (body.id) {
          const [replayed] = await tx
            .select()
            .from(capacityAssessment)
            .where(eq(capacityAssessment.id, body.id));
          if (replayed) {
            if (replayed.personId !== personId) throw problems.invalid("That id is already used.");
            return capacityItem(replayed, new Set());
          }
        }
        if (body.supersedesId && !body.correctionReason) {
          throw problems.invalid("Say why the assessment is being corrected.");
        }
        const stage2: Partial<
          Record<FunctionalElement, { able: boolean | null; evidence: string | null }>
        > = {};
        for (const [element, answer] of Object.entries(body.stage2)) {
          if (answer) {
            stage2[element as FunctionalElement] = {
              able: answer.able,
              evidence: answer.evidence ?? null,
            };
          }
        }
        const check = checkCapacityAssessment(
          {
            decision: body.decision,
            decisionKind: body.decisionKind ?? null,
            assessedAt: new Date(body.assessedAt),
            assessorId: body.assessorTenantUserId ?? body.assessorName ?? null,
            practicableSteps: body.practicableSteps,
            stage1: {
              impairment: body.stage1.impairment,
              description: body.stage1.description ?? null,
            },
            stage2,
            inabilityBecauseOfImpairment: body.inabilityBecauseOfImpairment ?? null,
            outcome: body.outcome,
            reviewOn: body.reviewOn ?? null,
          },
          now,
        );
        if (!check.ok) {
          throw problems.invalid(`${check.message} ${issuesMessage(check.issues)}`);
        }
        const [row] = await tx
          .insert(capacityAssessment)
          .values({
            ...(body.id ? { id: body.id } : {}),
            personId,
            decision: body.decision,
            decisionKind: body.decisionKind ?? null,
            assessedAt: new Date(body.assessedAt),
            assessorTenantUserId: body.assessorTenantUserId ?? null,
            assessorName: body.assessorName ?? null,
            assessorRole: body.assessorRole ?? null,
            practicableSteps: body.practicableSteps,
            stage1Impairment: body.stage1.impairment === true,
            stage1Description: body.stage1.description ?? null,
            stage2,
            inabilityBecauseOfImpairment: body.inabilityBecauseOfImpairment ?? null,
            outcome: check.outcome,
            unableTo: [...check.unableTo],
            reason: check.reason,
            reviewOn: body.reviewOn ?? null,
            supersedesId: body.supersedesId ?? null,
            correctionReason: body.correctionReason ?? null,
          })
          .onConflictDoNothing()
          .returning()
          .catch(notFoundOnForeignKey("assessor or the assessment being corrected"));
        if (!row) throw problems.invalid("That id is already used.");
        await audit(c, tx, access, {
          action: body.supersedesId ? "care.capacity.correct" : "care.capacity.create",
          resourceType: "capacity_assessment",
          resourceId: row.id,
          reason: body.correctionReason,
        });
        return capacityItem(row, new Set());
      });
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/best-interests",
      tags: ["care"],
      summary: "Best-interests decisions, newest first",
      security,
      request: { params: PersonParam },
      responses: {
        200: jsonBody(BestInterestsList, "Decisions"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.plan.read");
      const { id: personId } = c.req.valid("param");
      const items = await withTenant(c, async (tx) => {
        await personContext(tx, personId);
        const rows = await tx
          .select()
          .from(bestInterestsDecision)
          .where(eq(bestInterestsDecision.personId, personId))
          .orderBy(desc(bestInterestsDecision.decidedAt));
        await audit(c, tx, access, {
          action: "care.best_interests.list",
          resourceType: "person",
          resourceId: personId,
          scope: { count: rows.length },
        });
        const superseded = supersededSet(rows);
        return rows.map((r) => bestInterestsItem(r, superseded));
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/best-interests",
      tags: ["care"],
      summary: "Record a best-interests decision after an assessment found a lack of capacity",
      description:
        "checkBestInterests needs every section 4 item answered (not applicable with a reason), a consultation or why there was none, and a review date; the IMCA prompt is stored when nobody appropriate could be consulted (s.37 to s.39).",
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: CreateBestInterests } } },
      },
      responses: {
        201: jsonBody(BestInterestsItem, "Decision recorded (or the earlier copy)"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.capacity.write");
      const { id: personId } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const item = await withTenant(c, async (tx) => {
        const person = await personContext(tx, personId);
        requireOpenRecord(person);
        if (body.id) {
          const [replayed] = await tx
            .select()
            .from(bestInterestsDecision)
            .where(eq(bestInterestsDecision.id, body.id));
          if (replayed) {
            if (replayed.personId !== personId) throw problems.invalid("That id is already used.");
            return bestInterestsItem(replayed, new Set());
          }
        }
        if (body.supersedesId && !body.correctionReason) {
          throw problems.invalid("Say why the decision is being corrected.");
        }
        if (new Date(body.decidedAt).getTime() > now.getTime()) {
          throw problems.invalid("A decision cannot be dated in the future.");
        }
        const [assessment] = await tx
          .select()
          .from(capacityAssessment)
          .where(eq(capacityAssessment.id, body.capacityAssessmentId));
        if (!assessment || assessment.personId !== personId) {
          throw problems.invalid("The capacity assessment was not found.");
        }
        const check = checkBestInterests({
          capacityOutcome: assessment.outcome as "has_capacity" | "lacks_capacity",
          decision: body.decision,
          checklist: body.checklist as Partial<Record<BestInterestsItemKey, ChecklistAnswer>>,
          consultations: body.consultations.map((consultation) => ({
            consultee: consultation.consultee as ConsulteeKind,
            views: consultation.views,
            consultedAt: new Date(consultation.consultedAt),
          })),
          noConsultationReason: body.noConsultationReason ?? null,
          seriousMedicalTreatment: body.seriousMedicalTreatment,
          accommodationChange: body.accommodationChange,
          reviewOn: body.reviewOn,
        });
        if (!check.ok) throw problems.invalid(`${check.message} ${issuesMessage(check.issues)}`);
        const [row] = await tx
          .insert(bestInterestsDecision)
          .values({
            ...(body.id ? { id: body.id } : {}),
            personId,
            capacityAssessmentId: assessment.id,
            decision: body.decision,
            decidedAt: new Date(body.decidedAt),
            checklist: body.checklist,
            consultations: body.consultations,
            noConsultationReason: body.noConsultationReason ?? null,
            seriousMedicalTreatment: body.seriousMedicalTreatment,
            accommodationChange: body.accommodationChange,
            imcaPrompt: check.imca?.message ?? null,
            reviewOn: body.reviewOn ?? ukIsoDate(now),
            supersedesId: body.supersedesId ?? null,
            correctionReason: body.correctionReason ?? null,
          })
          .onConflictDoNothing()
          .returning()
          .catch(notFoundOnForeignKey("decision being corrected"));
        if (!row) throw problems.invalid("That id is already used.");
        await audit(c, tx, access, {
          action: body.supersedesId ? "care.best_interests.correct" : "care.best_interests.create",
          resourceType: "best_interests_decision",
          resourceId: row.id,
          reason: body.correctionReason,
        });
        return bestInterestsItem(row, new Set());
      });
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/dols",
      tags: ["care"],
      summary: "The person's DoLS register: status, days left, reminders and the CQC notification",
      security,
      request: { params: PersonParam },
      responses: {
        200: jsonBody(DolsList, "Authorisations"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.plan.read");
      const { id: personId } = c.req.valid("param");
      const items = await withTenant(c, async (tx) => {
        await personContext(tx, personId);
        const rows = await tx
          .select()
          .from(dolsAuthorisation)
          .where(and(eq(dolsAuthorisation.personId, personId), isNull(dolsAuthorisation.deletedAt)))
          .orderBy(desc(dolsAuthorisation.requestedAt));
        await audit(c, tx, access, {
          action: "care.dols.list",
          resourceType: "person",
          resourceId: personId,
          scope: { count: rows.length },
        });
        return dolsItems(tx, access.tenantId, rows, new Date());
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/dols",
      tags: ["care"],
      summary: "Record a DoLS request, urgent authorisation or court application",
      description:
        "Dates are checked against Schedule A1 with the rate table's figures (HZ-020). England and Wales only. When the outcome of a standard request or a court application is known, the CQC regulation 18(4A) draft is created and care.dols.outcome_known is published.",
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: DolsInput } } },
      },
      responses: {
        201: jsonBody(DolsItem, "Recorded"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.dols.manage");
      const { id: personId } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const item = await withTenant(c, async (tx) => {
        const person = await personContext(tx, personId);
        requireOpenRecord(person);
        if (!isDolsNation(person.nation)) {
          throw problems.invalid(
            "The Deprivation of Liberty Safeguards apply in England and Wales only. Use your nation's procedure.",
          );
        }
        await checkedDols(tx, access.tenantId, body, person.nation, "new", now);
        const [row] = await tx
          .insert(dolsAuthorisation)
          .values({
            personId,
            locationId: person.locationId,
            nation: person.nation,
            ...dolsValues(body),
          })
          .returning()
          .catch(notFoundOnForeignKey("representative or earlier authorisation"));
        if (!row) throw problems.conflict();
        if (row.outcome !== "pending") await outcomeKnown(tx, access.tenantId, row, now);
        await audit(c, tx, access, {
          action: "care.dols.create",
          resourceType: "dols_authorisation",
          resourceId: row.id,
          scope: { type: row.type, outcome: row.outcome },
        });
        const [out] = await dolsItems(tx, access.tenantId, [row], now);
        if (!out) throw problems.notFound();
        return out;
      });
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/people/{id}/dols/{dolsId}",
      tags: ["care"],
      summary: "Update an authorisation: its outcome, dates, extension, conditions or end",
      security,
      request: {
        params: DolsParams,
        body: { content: { "application/json": { schema: UpdateDols } } },
      },
      responses: {
        200: jsonBody(DolsItem, "Updated"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.dols.manage");
      const { id: personId, dolsId } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const item = await withTenant(c, async (tx) => {
        await personContext(tx, personId);
        const [existing] = await tx
          .select()
          .from(dolsAuthorisation)
          .where(and(eq(dolsAuthorisation.id, dolsId), isNull(dolsAuthorisation.deletedAt)));
        if (!existing || existing.personId !== personId) throw problems.notFound();
        if (existing.version !== body.version) throw problems.conflict();
        await checkedDols(tx, access.tenantId, body, existing.nation as DolsNation, dolsId, now);
        const [row] = await tx
          .update(dolsAuthorisation)
          .set(dolsValues(body))
          .where(and(eq(dolsAuthorisation.id, dolsId), eq(dolsAuthorisation.version, body.version)))
          .returning()
          .catch(notFoundOnForeignKey("representative or earlier authorisation"));
        if (!row) throw problems.conflict();
        if (row.outcome !== "pending" && existing.outcome === "pending") {
          await outcomeKnown(tx, access.tenantId, row, now);
        } else if (row.outcome !== "pending") {
          // A corrected outcome or date refreshes the draft while it is still being prepared.
          await draftDolsOutcomeNotification(tx, access.tenantId, row, now);
        }
        await audit(c, tx, access, {
          action: "care.dols.update",
          resourceType: "dols_authorisation",
          resourceId: row.id,
          scope: { outcome: row.outcome },
        });
        const [out] = await dolsItems(tx, access.tenantId, [row], now);
        if (!out) throw problems.notFound();
        return out;
      });
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/dols/legal-change-review",
      tags: ["care"],
      summary: "Authorisations to review after the June 2026 judgment, and reviews under way",
      description:
        "Where the tenant flag dols.post_2026_review_workflow is on (England and Wales): authorisations granted before 2 June 2026 that are still in force and not yet reviewed, soonest ending first (HZ-020).",
      security,
      responses: {
        200: jsonBody(LegalChangeReviewList, "Reviews"),
        ...errorResponses,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.dols.manage");
      const now = new Date();
      const result = await withTenant(c, async (tx) => {
        const auths = await tx
          .select()
          .from(dolsAuthorisation)
          .where(
            and(eq(dolsAuthorisation.outcome, "granted"), isNull(dolsAuthorisation.deletedAt)),
          );
        const reviews = await tx
          .select()
          .from(dolsLegalChangeReview)
          .where(isNull(dolsLegalChangeReview.deletedAt));
        const flags = await flagRows(tx);
        const enabled = auths.filter((a) =>
          legalChangeReviewEnabled(flags, a.locationId, a.nation),
        );
        const awaiting: LegalChangeReviewItem[] = [];
        for (const nation of ["england", "wales"] as const) {
          const inNation = enabled.filter((a) => a.nation === nation);
          if (inNation.length === 0) continue;
          const rates = await dolsRates(tx, access.tenantId, nation, ukIsoDate(now));
          const listed = authorisationsAwaitingLegalChangeReview(
            inNation.map((a) => ({
              ...toDolsView(a),
              legalChangeReview: (reviews.find((r) => r.dolsAuthorisationId === a.id)?.state ??
                null) as LegalChangeReviewState | null,
            })),
            rates,
            now,
          );
          for (const entry of listed) {
            const auth = inNation.find((a) => a.id === entry.authorisation.id);
            if (!auth) continue;
            const review = reviews.find((r) => r.dolsAuthorisationId === auth.id);
            awaiting.push(reviewItem(auth, review, entry.endsAt));
          }
        }
        awaiting.sort(
          (x, y) =>
            (x.endsAt ? Date.parse(x.endsAt) : Number.POSITIVE_INFINITY) -
            (y.endsAt ? Date.parse(y.endsAt) : Number.POSITIVE_INFINITY),
        );
        const underWay = reviews
          .filter((r) => r.state !== "awaiting_review")
          .flatMap((r) => {
            const auth = auths.find((a) => a.id === r.dolsAuthorisationId);
            return auth ? [reviewItem(auth, r, dolsEndsAt(toDolsView(auth)))] : [];
          });
        await audit(c, tx, access, {
          action: "care.dols.legal_change_review.list",
          scope: { awaiting: awaiting.length, reviews: underWay.length },
        });
        return {
          judgment: {
            citation: DOLS_LEGAL_CHANGE.judgment.citation,
            decidedOn: DOLS_LEGAL_CHANGE.judgment.decidedOn,
            url: DOLS_LEGAL_CHANGE.judgment.url,
          },
          guidance: {
            title: DOLS_LEGAL_CHANGE.guidance.title,
            lastUpdatedOn: DOLS_LEGAL_CHANGE.guidance.lastUpdatedOn,
            url: DOLS_LEGAL_CHANGE.guidance.url,
          },
          awaiting,
          reviews: underWay,
        };
      });
      return c.json(result, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/dols/legal-change-review/{authorisationId}",
      tags: ["care"],
      summary:
        "Record the review of an authorisation: reviewed, referred to the local authority, or closed",
      description:
        "checkLegalChangeReview and legalChangeStepProblems decide what each step needs: the DHSC multifactorial assessment, objection and consent signs to record it as reviewed; the referral before closing when the person is no longer deprived of liberty or there is doubt. Each step goes through the workflow engine with its reason.",
      security,
      request: {
        params: ReviewParams,
        body: { content: { "application/json": { schema: LegalChangeReviewAction } } },
      },
      responses: {
        200: jsonBody(LegalChangeReviewItem, "Review recorded"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.dols.manage");
      const { authorisationId } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const item = await withTenant(c, async (tx) => {
        const [auth] = await tx
          .select()
          .from(dolsAuthorisation)
          .where(
            and(eq(dolsAuthorisation.id, authorisationId), isNull(dolsAuthorisation.deletedAt)),
          );
        if (!auth) throw problems.notFound();
        if (!legalChangeReviewEnabled(await flagRows(tx), auth.locationId, auth.nation)) {
          throw problems.featureDisabled(
            "The review of existing authorisations is switched off for this location.",
          );
        }
        let [review] = await tx
          .select()
          .from(dolsLegalChangeReview)
          .where(eq(dolsLegalChangeReview.dolsAuthorisationId, auth.id))
          .for("update");
        if ((review?.version ?? 0) !== body.version) throw problems.conflict();
        if (!review) {
          [review] = await tx
            .insert(dolsLegalChangeReview)
            .values({ personId: auth.personId, dolsAuthorisationId: auth.id })
            .returning();
          if (!review) throw problems.conflict();
          await startWorkflow(
            tx,
            access.tenantId,
            DOLS_LEGAL_CHANGE_REVIEW_WORKFLOW,
            {
              subjectType: "dols_legal_change_review",
              subjectId: review.id,
              personId: auth.personId,
            },
            now,
          );
        }
        const input = body.review ?? reviewInputFrom(review) ?? EMPTY_REVIEW;
        const decidedBy = input.decision ? (review.decidedBy ?? access.tenantUserId) : null;
        const domainInput = domainReview(input, decidedBy);
        const problemsFound = legalChangeStepProblems(
          review.state as LegalChangeReviewState,
          body.to,
          domainInput,
          dolsEndsAt(toDolsView(auth)),
          now,
        );
        if (problemsFound.length > 0) {
          const check = checkLegalChangeReview(domainInput);
          throw problems.invalid(
            problemsFound
              .map((p) =>
                p === "review_incomplete" ? issuesMessage(check.issues) : STEP_MESSAGES[p],
              )
              .join(" "),
          );
        }
        await moveOrRefuse(
          c,
          tx,
          DOLS_LEGAL_CHANGE_REVIEW_WORKFLOW,
          {
            subjectType: "dols_legal_change_review",
            subjectId: review.id,
            personId: auth.personId,
          },
          body.to,
          body.reason,
          now,
        );
        const check = checkLegalChangeReview(domainInput);
        const [row] = await tx
          .update(dolsLegalChangeReview)
          .set({
            state: body.to,
            factors: input.factors,
            objection: input.objection,
            objectionForms: input.objectionForms,
            consentSigns: input.consent,
            decision: input.decision,
            decidedAt: input.decidedAt ? new Date(input.decidedAt) : null,
            decidedBy,
            referralSentAt: input.referral ? new Date(input.referral.sentAt) : null,
            referralReference: input.referral?.reference ?? null,
            referralRequired: check.referralRequired,
            prompts: [...check.prompts],
            closedReason: body.to === "closed" ? (body.reason ?? null) : review.closedReason,
          })
          .where(
            and(
              eq(dolsLegalChangeReview.id, review.id),
              eq(dolsLegalChangeReview.version, review.version),
            ),
          )
          .returning();
        if (!row) throw problems.conflict();
        await audit(c, tx, access, {
          action: `care.dols.legal_change_review.${body.to}`,
          resourceType: "dols_legal_change_review",
          resourceId: row.id,
          scope: { authorisationId: auth.id },
        });
        return reviewItem(auth, row, dolsEndsAt(toDolsView(auth)));
      });
      return c.json(item, 200);
    },
  );
