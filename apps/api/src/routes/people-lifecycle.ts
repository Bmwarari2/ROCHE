import {
  type AdmissionConditionItem,
  type AdmissionDecisionItem,
  AdmissionDecisionList,
  AdmissionResult,
  AdmissionView,
  BedBoard,
  BedHistory,
  type BedOccupancyItem,
  ConfirmAdmissionCondition,
  CreateAdmissionDecision,
  CreateBedMove,
  PersonStatusChange,
  PersonStatusChangeResult,
  PersonSummary,
  type PlacementItem,
  type PreAdmissionAssessmentItem,
  type PreAdmissionSection,
  PreAdmissionView,
  RecordAdmission,
  UpdateCommunicationNeeds,
  UpdatePreAdmission,
  UpdateWelcomeChecklistItem,
  UpdateWelcomeChecklistTemplate,
  type WelcomeChecklist,
  WelcomeChecklistTemplate,
} from "@harbour/contracts";
import {
  admissionCondition,
  admissionDecision,
  bedOccupancy,
  location,
  person,
  placement,
  preAdmissionAssessment,
  room,
  service,
  type Transaction,
  welcomeChecklistItem,
  welcomeChecklistTemplate,
} from "@harbour/db";
import {
  type AdmissionDecision,
  type AdmissionDecisionProblem,
  type AdmissionReadinessProblem,
  type ChecklistItemState,
  checkAdmissionDecision,
  checkAdmissionReadiness,
  checkWelcomeChecklistDefinition,
  DEFAULT_WELCOME_CHECKLIST,
  type InformationSource,
  PRE_ADMISSION_SECTIONS,
  type PreAdmissionAssessment,
  type PreAdmissionSectionKey,
  type PreAdmissionSectionState,
  planBedMove,
  planBedRelease,
  preAdmissionCompleteness,
  roomLabelOn,
  ukIsoDate,
  type WelcomeChecklistItemDefinition,
  welcomeChecklistStatus,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, desc, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { permissionsReaching, requirePermission, withTenant } from "../http/context";
import { problems } from "../http/problem";
import { publish } from "../outbox";
import {
  currentPlacement,
  currentRecords,
  loadPerson,
  occupancyRows,
  type PersonRecord,
  requireVersion,
  requireWrite,
  toPeriod,
  toRoomView,
} from "../services/people";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import { personSummaries } from "./people";
import {
  audit,
  changeStatus,
  invalidOnForeignKey,
  iso,
  PersonParam,
  requireAnyPermission,
  requireLocationInScope,
} from "./people-shared";

/**
 * The people lifecycle (slice 8; people.md rules 1 to 6): status changes through
 * `checkPersonStatusChange`, communication needs, the pre-admission assessment and the decision
 * to admit, admission into a dated bed, bed moves and the bed board, room clearance after a death,
 * and the welcome checklist. Every rule is the domain's; reads and writes are audited by record id.
 */

const DecisionParams = PersonParam.extend({ decisionId: z.uuid() });
const ConditionParams = DecisionParams.extend({ conditionId: z.uuid() });
const ItemParams = PersonParam.extend({ itemKey: z.string().max(80) });
const LocationParam = z.object({ id: z.uuid() });
const RoomParam = z.object({ roomId: z.uuid() });

// ------------------------------------------------------------------------------------------------
// Pre-admission (rule 4)
// ------------------------------------------------------------------------------------------------

interface StoredSection {
  readonly status: "in_progress" | "complete" | "not_applicable";
  readonly notes: string | null;
  readonly notApplicableReason: string | null;
  readonly medicines: PreAdmissionSection["medicines"];
  readonly completedBy: string | null;
  readonly completedAt: string | null;
}

type AssessmentRow = typeof preAdmissionAssessment.$inferSelect;

const storedSections = (row: AssessmentRow) =>
  (row.sections ?? {}) as Partial<Record<PreAdmissionSectionKey, StoredSection>>;

function sectionState(s: StoredSection): PreAdmissionSectionState {
  if (s.completedBy && s.completedAt) {
    if (s.status === "complete") {
      return {
        status: "complete",
        completedBy: s.completedBy,
        completedAt: new Date(s.completedAt),
      };
    }
    if (s.status === "not_applicable") {
      return {
        status: "not_applicable",
        reason: s.notApplicableReason ?? "",
        completedBy: s.completedBy,
        completedAt: new Date(s.completedAt),
      };
    }
  }
  return { status: "in_progress" };
}

function domainAssessment(row: AssessmentRow): PreAdmissionAssessment {
  const sections = storedSections(row);
  return {
    sections: Object.fromEntries(
      Object.entries(sections).map(([key, s]) => [key, sectionState(s as StoredSection)]),
    ),
    sources: row.informationSources as InformationSource[],
    personInvolvement:
      row.personInvolved === true
        ? { involved: true }
        : { involved: false, reason: row.involvementReason ?? "" },
  };
}

function assessmentItem(row: AssessmentRow): PreAdmissionAssessmentItem {
  const completeness = preAdmissionCompleteness(domainAssessment(row));
  return {
    id: row.id,
    personId: row.personId,
    serviceId: row.serviceId,
    placementTypeSought: row.placementTypeSought,
    status: row.status as PreAdmissionAssessmentItem["status"],
    sections: storedSections(row) as PreAdmissionAssessmentItem["sections"],
    informationSources: row.informationSources as InformationSource[],
    personInvolvement:
      row.personInvolved === null
        ? null
        : row.personInvolved
          ? { involved: true }
          : { involved: false, reason: row.involvementReason ?? "" },
    assessorTenantUserId: row.assessorTenantUserId,
    completeness: {
      complete: completeness.complete,
      outstanding: completeness.outstanding.map((o) => ({ key: o.key, problem: o.problem })),
      sourcesMissing: completeness.sourcesMissing,
      involvementMissing: completeness.involvementMissing,
      lastCompletedAt: iso(completeness.lastCompletedAt),
    },
    version: row.version,
  };
}

const SECTION_TITLES = new Map<string, string>(PRE_ADMISSION_SECTIONS.map((s) => [s.key, s.title]));

async function openAssessment(tx: Transaction, personId: string) {
  const [row] = await tx
    .select()
    .from(preAdmissionAssessment)
    .where(
      and(
        eq(preAdmissionAssessment.personId, personId),
        notInArray(preAdmissionAssessment.status, ["decided"]),
        isNull(preAdmissionAssessment.deletedAt),
      ),
    );
  return row ?? null;
}

async function latestAssessment(tx: Transaction, personId: string) {
  const [row] = await tx
    .select()
    .from(preAdmissionAssessment)
    .where(
      and(eq(preAdmissionAssessment.personId, personId), isNull(preAdmissionAssessment.deletedAt)),
    )
    .orderBy(desc(preAdmissionAssessment.createdAt))
    .limit(1);
  return row ?? null;
}

// ------------------------------------------------------------------------------------------------
// Decision to admit (rule 5)
// ------------------------------------------------------------------------------------------------

const DECISION_MESSAGES: Record<AdmissionDecisionProblem, string> = {
  assessment_incomplete: "Finish the pre-admission assessment before deciding.",
  reasons_required: "Give the reasons for the decision in a sentence or more.",
  conditions_required: "List the conditions that must be met before admission.",
  conditions_blank: "A condition cannot be blank.",
  not_authorised: "Only someone who manages admissions can make this decision.",
  decided_before_assessment: "The decision cannot be dated before the assessment was finished.",
  invalid_date: "Enter the dates as real dates.",
  trial_ends_before_admission: "A trial period must end after the planned admission.",
};

const READINESS_MESSAGES: Record<AdmissionReadinessProblem, string> = {
  no_decision: "Record the decision to admit first.",
  decision_declined: "The decision was that the home cannot meet this person's needs.",
  conditions_not_met: "Confirm that every condition of the decision has been met.",
  invalid_start_date: "Enter the start date as a real date.",
  trial_end_required: "Give the date the trial ends.",
  trial_ends_before_start: "The trial must end after it starts.",
  bed_required: "Choose a room and bed for a residential or nursing placement.",
  bed_not_available: "That bed is not available on that date.",
};

type DecisionRow = typeof admissionDecision.$inferSelect;
type ConditionRow = typeof admissionCondition.$inferSelect;

function conditionItem(row: ConditionRow): AdmissionConditionItem {
  return {
    id: row.id,
    position: row.position,
    condition: row.condition,
    metBy: row.metBy,
    metAt: iso(row.metAt),
    version: row.version,
  };
}

function decisionItem(
  row: DecisionRow,
  conditions: readonly ConditionRow[],
  superseded: ReadonlySet<string>,
): AdmissionDecisionItem {
  return {
    id: row.id,
    personId: row.personId,
    assessmentId: row.assessmentId,
    canMeetNeeds: row.canMeetNeeds as AdmissionDecisionItem["canMeetNeeds"],
    admit: row.canMeetNeeds !== "no",
    reasons: row.reasons,
    plannedAdmissionOn: row.plannedAdmissionOn,
    trialEndsOn: row.trialEndsOn,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt.toISOString(),
    toldWho: row.toldWho,
    toldAt: iso(row.toldAt),
    supersedesId: row.supersedesId,
    correctionReason: row.correctionReason,
    superseded: superseded.has(row.id),
    conditions: conditions
      .filter((c) => c.decisionId === row.id)
      .sort((a, b) => a.position - b.position)
      .map(conditionItem),
  };
}

async function decisionsFor(tx: Transaction, personId: string) {
  const rows = await tx
    .select()
    .from(admissionDecision)
    .where(eq(admissionDecision.personId, personId))
    .orderBy(desc(admissionDecision.decidedAt));
  const conditions =
    rows.length === 0
      ? []
      : await tx
          .select()
          .from(admissionCondition)
          .where(
            inArray(
              admissionCondition.decisionId,
              rows.map((r) => r.id),
            ),
          );
  const current = currentRecords(rows);
  return { rows, conditions, current: current[0] ?? null };
}

function domainDecision(row: DecisionRow, conditions: readonly ConditionRow[]): AdmissionDecision {
  return {
    canMeetNeeds: row.canMeetNeeds as AdmissionDecision["canMeetNeeds"],
    admit: row.canMeetNeeds !== "no",
    reasons: row.reasons,
    conditions: conditions
      .filter((c) => c.decisionId === row.id)
      .sort((a, b) => a.position - b.position)
      .map((c) => c.condition),
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
    plannedAdmissionOn: row.plannedAdmissionOn,
    trialEndsOn: row.trialEndsOn,
  };
}

// ------------------------------------------------------------------------------------------------
// Placements, beds and the welcome checklist (rules 5 and 6)
// ------------------------------------------------------------------------------------------------

function placementItem(row: typeof placement.$inferSelect): PlacementItem {
  return {
    id: row.id,
    personId: row.personId,
    serviceId: row.serviceId,
    roomId: row.roomId,
    type: row.type,
    startDate: row.startDate,
    endDate: row.endDate,
    endReason: row.endReason,
    trialEndsOn: row.trialEndsOn,
    trialReviewedOn: row.trialReviewedOn,
    localAuthorityFunded: row.localAuthorityFunded,
    nhsFunded: row.nhsFunded,
    admissionDecisionId: row.admissionDecisionId,
    version: row.version,
  };
}

function occupancyItem(
  row: typeof bedOccupancy.$inferSelect,
  labels: ReadonlyMap<string, string>,
): BedOccupancyItem {
  return {
    id: row.id,
    personId: row.personId,
    roomId: row.roomId,
    roomLabel: labels.get(row.roomId) ?? "",
    bed: row.bed,
    from: row.fromDate,
    to: row.toDate,
    reason: row.reason,
    backdated: row.backdated,
    recordedBy: row.createdBy,
    recordedAt: row.createdAt.toISOString(),
  };
}

async function bedHistory(tx: Transaction, p: PersonRecord, today: string) {
  const rows = (await occupancyRows(tx, { personId: p.id })).filter((r) => r.personId === p.id);
  const roomIds = [...new Set(rows.map((r) => r.roomId))];
  const rooms =
    roomIds.length === 0 ? [] : await tx.select().from(room).where(inArray(room.id, roomIds));
  const labels = new Map(rooms.map((r) => [r.id, r.label]));
  return {
    personId: p.id,
    roomLabel: roomLabelOn(rows.map(toPeriod), rooms.map(toRoomView), p.id, today),
    items: rows.map((r) => occupancyItem(r, labels)),
  };
}

/** The tenant's checklist definition, or Harbour's default. */
async function checklistDefinition(tx: Transaction) {
  const [row] = await tx
    .select()
    .from(welcomeChecklistTemplate)
    .where(isNull(welcomeChecklistTemplate.deletedAt));
  return {
    row: row ?? null,
    items: (row?.items as WelcomeChecklistItemDefinition[] | undefined) ?? [
      ...DEFAULT_WELCOME_CHECKLIST,
    ],
  };
}

type ChecklistRow = typeof welcomeChecklistItem.$inferSelect;

function checklistState(row: ChecklistRow): ChecklistItemState {
  if (row.status === "done" && row.doneBy && row.doneAt) {
    return { status: "done", by: row.doneBy, at: row.doneAt };
  }
  if (row.status === "not_applicable" && row.doneBy && row.doneAt) {
    return { status: "not_applicable", reason: row.reason ?? "", by: row.doneBy, at: row.doneAt };
  }
  return { status: "pending" };
}

function checklistOut(placementId: string | null, rows: readonly ChecklistRow[]): WelcomeChecklist {
  const ordered = [...rows].sort((a, b) => a.position - b.position);
  const status = welcomeChecklistStatus(
    ordered.map((r) => ({
      key: r.itemKey,
      title: r.title,
      required: r.required,
      safetyCritical: r.safetyCritical,
      allowNotApplicable: r.allowNotApplicable,
      hazardIds: [],
    })),
    Object.fromEntries(ordered.map((r) => [r.itemKey, checklistState(r)])),
  );
  return {
    placementId,
    items: ordered.map((r) => ({
      key: r.itemKey,
      title: r.title,
      required: r.required,
      safetyCritical: r.safetyCritical,
      allowNotApplicable: r.allowNotApplicable,
      status: r.status as "pending" | "done" | "not_applicable",
      reason: r.reason,
      doneBy: r.doneBy,
      doneAt: iso(r.doneAt),
      version: r.version,
    })),
    complete: status.complete,
    outstanding: [...status.outstanding],
    safetyCriticalOutstanding: [...status.safetyCriticalOutstanding],
    invalid: [...status.invalid],
  };
}

async function welcomeChecklistFor(tx: Transaction, personId: string): Promise<WelcomeChecklist> {
  const current = await currentPlacement(tx, personId);
  if (!current) return checklistOut(null, []);
  const rows = await tx
    .select()
    .from(welcomeChecklistItem)
    .where(
      and(eq(welcomeChecklistItem.placementId, current.id), isNull(welcomeChecklistItem.deletedAt)),
    );
  return checklistOut(current.id, rows);
}

async function summaryOf(tx: Transaction, personId: string): Promise<PersonSummary> {
  const [summary] = await personSummaries(tx, [personId]);
  if (!summary) throw problems.notFound();
  return summary;
}

// ------------------------------------------------------------------------------------------------
// Routes
// ------------------------------------------------------------------------------------------------

export const peopleLifecycleRouter = createRouter()
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/status",
      tags: ["people"],
      summary: "Change a person's status (people.md rules 1 and 2)",
      description:
        "Checked with checkPersonStatusChange: the permission, reason and step-up of the PERSON_LIFECYCLE move, a time neither in the future (beyond the clock-drift tolerance) nor before the current status began, a discharge that says whether it is a transfer, archiving only once the exit workflow has closed, and no re-admission after a death. Admission has its own route. The effects run in the same transaction: rounds paused or resumed, future tasks cancelled, sharing closed, the bed released or the room held, the exit workflow started or cancelled, and one outbox event. A death recorded in error is corrected with a reason and step-up (HZ-001).",
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: PersonStatusChange } } },
      },
      responses: {
        200: jsonBody(PersonStatusChangeResult, "Status changed"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [
        "people.admission.manage",
        "people.movement.record",
        "people.enquiry.manage",
      ]);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const result = await withTenant(c, async (tx) => {
        const p = await loadPerson(tx, id, true);
        requireVersion(p.version, body.version);
        if (p.status === "pre_admission" && body.to === "active") {
          throw problems.invalid("Record the admission with its placement and bed instead.");
        }
        const outcome = await changeStatus(
          c,
          tx,
          p,
          {
            to: body.to,
            effectiveAt: new Date(body.effectiveAt),
            reason: body.reason ?? null,
            ...(body.exitKind ? { exitKind: body.exitKind } : {}),
            ...(body.exit ? { exit: body.exit } : {}),
            ...(body.serviceId ? { serviceId: body.serviceId } : {}),
            ...(body.placementTypeSought ? { placementTypeSought: body.placementTypeSought } : {}),
          },
          now,
        );
        await audit(c, tx, access, {
          action: `people.person.status.${body.to}`,
          resourceType: "person",
          resourceId: id,
          reason: body.reason,
          scope: { from: p.status, to: body.to, event: outcome.check.event },
        });
        return {
          personId: id,
          status: outcome.person.status,
          statusChangedAt: outcome.person.statusChangedAt.toISOString(),
          event: outcome.check.event,
          effects: [...outcome.check.effects],
          correction: outcome.check.correction,
          exitRecordId: outcome.exitRecordId,
          version: outcome.person.version,
        };
      });
      return c.json(result, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/people/{id}/communication-needs",
      tags: ["people"],
      summary: "Record communication needs, or confirm there are none (HZ-023)",
      description:
        "An empty list means 'not recorded' until someone confirms 'none identified', which records who confirmed it and when; that statement then prints in the hospital transfer pack.",
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: UpdateCommunicationNeeds } } },
      },
      responses: {
        200: jsonBody(PersonSummary, "Saved"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.person.update");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      if ((body.status === "none_identified") !== (body.needs.length === 0)) {
        throw problems.invalid(
          body.status === "none_identified"
            ? "'None identified' means the list of needs is empty."
            : "List the needs, or confirm that none were identified.",
        );
      }
      const summary = await withTenant(c, async (tx) => {
        const p = await loadPerson(tx, id, true);
        requireVersion(p.version, body.version);
        requireWrite(p, "demographics");
        // Who recorded the needs, or confirmed there are none, and when (HZ-023; printed in the
        // transfer pack): set on every change, never taken from the last edit of the person.
        const [updated] = await tx
          .update(person)
          .set({
            communicationNeeds: body.needs,
            communicationNeedsStatus: body.status,
            communicationNeedsConfirmedBy: access.tenantUserId,
            communicationNeedsConfirmedAt: now,
          })
          .where(and(eq(person.id, id), eq(person.version, body.version)))
          .returning({ id: person.id });
        if (!updated) throw problems.conflict();
        await audit(c, tx, access, {
          action: "people.communication_needs.update",
          resourceType: "person",
          resourceId: id,
          scope: { status: body.status, count: body.needs.length },
        });
        return summaryOf(tx, id);
      });
      return c.json(summary, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/pre-admission",
      tags: ["people"],
      summary: "The pre-admission assessment, with what is still outstanding",
      security,
      request: { params: PersonParam },
      responses: {
        200: jsonBody(PreAdmissionView, "Assessment"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.person.read");
      const { id } = c.req.valid("param");
      const view = await withTenant(c, async (tx) => {
        await loadPerson(tx, id);
        const row = (await openAssessment(tx, id)) ?? (await latestAssessment(tx, id));
        await audit(c, tx, access, {
          action: "people.pre_admission.view",
          resourceType: "pre_admission_assessment",
          resourceId: row?.id ?? id,
        });
        return {
          assessment: row ? assessmentItem(row) : null,
          definitions: PRE_ADMISSION_SECTIONS.map((s) => ({
            key: s.key,
            title: s.title,
            required: s.required,
            allowNotApplicable: s.allowNotApplicable,
            hazardIds: [...s.hazardIds],
          })),
        };
      });
      return c.json(view, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/people/{id}/pre-admission",
      tags: ["people"],
      summary: "Write sections of the pre-admission assessment (rule 4)",
      description:
        "Allowed while the person is at pre-admission. 'Not applicable' is refused where it would hide a safety fact (allergies, resuscitation, IDDSI levels and every section except equipment and the two optional ones), and needs a reason where it is allowed (HZ-007, HZ-015, HZ-016). The medicines section carries the list the hospital transfer pack prints until the eMAR (Phase 2).",
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: UpdatePreAdmission } } },
      },
      responses: {
        200: jsonBody(PreAdmissionView, "Saved"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, ["care.plan.write", "people.admission.manage"]);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const view = await withTenant(c, async (tx) => {
        const p = await loadPerson(tx, id);
        requireWrite(p, "pre_admission_assessment");
        let row = await openAssessment(tx, id);
        if (!row) {
          const [created] = await tx
            .insert(preAdmissionAssessment)
            .values({ personId: id })
            .returning();
          if (!created) throw problems.conflict();
          row = created;
        }
        requireVersion(row.version, body.version);
        const sections = { ...storedSections(row) };
        for (const [key, input] of Object.entries(body.sections) as [
          PreAdmissionSectionKey,
          NonNullable<(typeof body.sections)[PreAdmissionSectionKey]>,
        ][]) {
          if (input.medicines !== undefined && key !== "medicines") {
            throw problems.invalid("A list of medicines belongs in the medicines section.");
          }
          const done = input.status !== "in_progress";
          sections[key] = {
            status: input.status,
            notes: input.notes ?? null,
            notApplicableReason: input.notApplicableReason ?? null,
            medicines: key === "medicines" ? (input.medicines ?? []) : null,
            completedBy: done ? access.tenantUserId : null,
            completedAt: done ? now.toISOString() : null,
          };
        }
        const next: AssessmentRow = {
          ...row,
          sections,
          informationSources: body.informationSources ?? row.informationSources,
          personInvolved: body.personInvolvement
            ? body.personInvolvement.involved
            : row.personInvolved,
          involvementReason: body.personInvolvement
            ? body.personInvolvement.involved
              ? null
              : body.personInvolvement.reason
            : row.involvementReason,
        };
        // The domain decides what a section may hold; a write it would never accept is refused.
        const completeness = preAdmissionCompleteness(domainAssessment(next));
        const refused = completeness.outstanding.filter(
          (o) =>
            o.key in body.sections &&
            (o.problem === "not_applicable_not_allowed" ||
              o.problem === "not_applicable_reason_required"),
        );
        if (refused.length > 0) {
          throw problems.invalid(
            refused
              .map((o) =>
                o.problem === "not_applicable_not_allowed"
                  ? `${SECTION_TITLES.get(o.key)}: 'not applicable' cannot be recorded here; record what is known.`
                  : `${SECTION_TITLES.get(o.key)}: say why it does not apply.`,
              )
              .join(" "),
          );
        }
        const [updated] = await tx
          .update(preAdmissionAssessment)
          .set({
            sections,
            informationSources: next.informationSources,
            personInvolved: next.personInvolved,
            involvementReason: next.involvementReason,
            serviceId: body.serviceId ?? row.serviceId,
            placementTypeSought: body.placementTypeSought ?? row.placementTypeSought,
            assessorTenantUserId: access.tenantUserId,
            status: completeness.complete ? "complete" : "in_progress",
          })
          .where(
            and(
              eq(preAdmissionAssessment.id, row.id),
              eq(preAdmissionAssessment.version, body.version),
            ),
          )
          .returning()
          .catch(invalidOnForeignKey("service"));
        if (!updated) throw problems.conflict();
        await audit(c, tx, access, {
          action: "people.pre_admission.update",
          resourceType: "pre_admission_assessment",
          resourceId: updated.id,
          scope: { sections: Object.keys(body.sections) },
        });
        return {
          assessment: assessmentItem(updated),
          definitions: PRE_ADMISSION_SECTIONS.map((s) => ({
            key: s.key,
            title: s.title,
            required: s.required,
            allowNotApplicable: s.allowNotApplicable,
            hazardIds: [...s.hazardIds],
          })),
        };
      });
      return c.json(view, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/admission-decisions",
      tags: ["people"],
      summary: "Decisions to admit, newest first, with their conditions",
      security,
      request: { params: PersonParam },
      responses: {
        200: jsonBody(AdmissionDecisionList, "Decisions"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.person.read");
      const { id } = c.req.valid("param");
      const items = await withTenant(c, async (tx) => {
        await loadPerson(tx, id);
        const { rows, conditions } = await decisionsFor(tx, id);
        const superseded = new Set(rows.flatMap((r) => (r.supersedesId ? [r.supersedesId] : [])));
        await audit(c, tx, access, {
          action: "people.admission_decision.list",
          resourceType: "person",
          resourceId: id,
          scope: { count: rows.length },
        });
        return rows.map((r) => decisionItem(r, conditions, superseded));
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/admission-decisions",
      tags: ["people"],
      summary: "Record whether the home can meet the person's needs (rule 5)",
      description:
        "checkAdmissionDecision: the assessment complete, reasons of at least a sentence, conditions when conditional, a decider holding people.admission.manage, a time not before the last completed section, and a trial that ends after the planned admission. Append-only: a change is a new decision that supersedes the earlier one with a reason.",
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: CreateAdmissionDecision } } },
      },
      responses: {
        201: jsonBody(AdmissionDecisionList.shape.items.element, "Recorded"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.admission.manage");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const decidedAt = body.decidedAt ? new Date(body.decidedAt) : now;
      if (decidedAt.getTime() > now.getTime()) {
        throw problems.invalid("The decision cannot be dated in the future.");
      }
      if (body.supersedesId && !body.correctionReason) {
        throw problems.invalid("Say why the earlier decision is being replaced.");
      }
      if ((body.toldWho === undefined) !== (body.toldAt === undefined)) {
        throw problems.invalid("Say who was told about the decision and when.");
      }
      const item = await withTenant(c, async (tx) => {
        const p = await loadPerson(tx, id, true);
        requireWrite(p, "admission_decision");
        let assessment: AssessmentRow | null = null;
        if (body.supersedesId) {
          const [original] = await tx
            .select()
            .from(admissionDecision)
            .where(eq(admissionDecision.id, body.supersedesId));
          if (original?.personId !== id)
            throw problems.invalid("The earlier decision was not found.");
          const [row] = await tx
            .select()
            .from(preAdmissionAssessment)
            .where(eq(preAdmissionAssessment.id, original.assessmentId));
          assessment = row ?? null;
        } else {
          assessment = await openAssessment(tx, id);
        }
        if (!assessment) throw problems.invalid("Start the pre-admission assessment first.");
        const check = checkAdmissionDecision(domainAssessment(assessment), {
          canMeetNeeds: body.canMeetNeeds,
          reasons: body.reasons,
          conditions: body.conditions,
          decidedBy: access.tenantUserId,
          decidedAt,
          // Only the permissions reaching this person (ADR-0071 review round 1, L9).
          deciderPermissions: new Set(await permissionsReaching(tx, access, id)),
          plannedAdmissionOn: body.plannedAdmissionOn ?? null,
          trialEndsOn: body.trialEndsOn ?? null,
        });
        if (!check.ok) {
          const outstanding = check.outstanding.map((o) => SECTION_TITLES.get(o.key) ?? o.key);
          throw problems.invalid(
            [
              ...check.problems.map((problem) => DECISION_MESSAGES[problem]),
              ...(outstanding.length > 0 ? [`Outstanding: ${outstanding.join("; ")}.`] : []),
            ].join(" "),
          );
        }
        const decision = check.decision;
        const [row] = await tx
          .insert(admissionDecision)
          .values({
            personId: id,
            assessmentId: assessment.id,
            canMeetNeeds: decision.canMeetNeeds,
            reasons: decision.reasons,
            plannedAdmissionOn: decision.plannedAdmissionOn,
            trialEndsOn: decision.trialEndsOn,
            decidedBy: decision.decidedBy,
            decidedAt: decision.decidedAt,
            toldWho: body.toldWho ?? null,
            toldAt: body.toldAt ? new Date(body.toldAt) : null,
            supersedesId: body.supersedesId ?? null,
            correctionReason: body.correctionReason ?? null,
          })
          .returning()
          .catch((error: unknown) => {
            const code =
              (error as { code?: string }).code ??
              (error as { cause?: { code?: string } }).cause?.code;
            if (code === "23505")
              throw problems.invalid("That decision has already been replaced.");
            throw error;
          });
        if (!row) throw problems.conflict();
        const conditions: ConditionRow[] = [];
        for (const [position, condition] of decision.conditions.entries()) {
          const [created] = await tx
            .insert(admissionCondition)
            .values({ personId: id, decisionId: row.id, position, condition })
            .returning();
          if (created) conditions.push(created);
        }
        await tx
          .update(preAdmissionAssessment)
          .set({ status: "decided" })
          .where(eq(preAdmissionAssessment.id, assessment.id));
        await audit(c, tx, access, {
          action: body.supersedesId
            ? "people.admission_decision.correct"
            : "people.admission_decision.create",
          resourceType: "admission_decision",
          resourceId: row.id,
          reason: body.correctionReason,
          scope: { canMeetNeeds: row.canMeetNeeds },
        });
        return decisionItem(row, conditions, new Set());
      });
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/admission-decisions/{decisionId}/conditions/{conditionId}/met",
      tags: ["people"],
      summary: "Confirm that a condition of the decision to admit has been met",
      security,
      request: {
        params: ConditionParams,
        body: { content: { "application/json": { schema: ConfirmAdmissionCondition } } },
      },
      responses: {
        200: jsonBody(AdmissionDecisionList.shape.items.element.shape.conditions.element, "Met"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.admission.manage");
      const { id, decisionId, conditionId } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const item = await withTenant(c, async (tx) => {
        const p = await loadPerson(tx, id);
        requireWrite(p, "admission_decision");
        const [row] = await tx
          .select()
          .from(admissionCondition)
          .where(
            and(
              eq(admissionCondition.id, conditionId),
              eq(admissionCondition.decisionId, decisionId),
            ),
          );
        if (row?.personId !== id) throw problems.notFound();
        requireVersion(row.version, body.version);
        const [updated] = await tx
          .update(admissionCondition)
          .set({ metBy: access.tenantUserId, metAt: now })
          .where(
            and(eq(admissionCondition.id, row.id), eq(admissionCondition.version, body.version)),
          )
          .returning();
        if (!updated) throw problems.conflict();
        await audit(c, tx, access, {
          action: "people.admission_condition.met",
          resourceType: "admission_condition",
          resourceId: row.id,
        });
        return conditionItem(updated);
      });
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/admission",
      tags: ["people"],
      summary:
        "The decision to admit, the conditions outstanding, the placement and the welcome checklist",
      security,
      request: { params: PersonParam },
      responses: {
        200: jsonBody(AdmissionView, "Admission"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.person.read");
      const { id } = c.req.valid("param");
      const view = await withTenant(c, async (tx) => {
        await loadPerson(tx, id);
        const { rows, conditions, current } = await decisionsFor(tx, id);
        const superseded = new Set(rows.flatMap((r) => (r.supersedesId ? [r.supersedesId] : [])));
        const currentPlacementRow = await currentPlacement(tx, id);
        await audit(c, tx, access, {
          action: "people.admission.view",
          resourceType: "person",
          resourceId: id,
        });
        return {
          decision: current ? decisionItem(current, conditions, superseded) : null,
          conditionsOutstanding: current
            ? conditions
                .filter((x) => x.decisionId === current.id && x.metAt === null)
                .sort((a, b) => a.position - b.position)
                .map((x) => x.condition)
            : [],
          placement: currentPlacementRow ? placementItem(currentPlacementRow) : null,
          welcomeChecklist: await welcomeChecklistFor(tx, id),
        };
      });
      return c.json(view, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/admission",
      tags: ["people"],
      summary: "Admit the person into a placement and a dated bed (rules 5 and 6)",
      description:
        "checkAdmissionReadiness: a positive decision whose conditions are all met, a valid placement (a trial with its end date) and, for residential and nursing placements, a free bed from planBedMove. Then the status change to active through checkPersonStatusChange, the placement, the bed period (the header's room label comes from it, HZ-001), the welcome checklist from the tenant's definition, and people.person.admitted.",
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: RecordAdmission } } },
      },
      responses: {
        201: jsonBody(AdmissionResult, "Admitted"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.admission.manage");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const today = ukIsoDate(now);
      const result = await withTenant(c, async (tx) => {
        const p = await loadPerson(tx, id, true);
        requireVersion(p.version, body.version);
        if (p.status !== "pre_admission") {
          throw problems.invalid("Only a person at pre-admission can be admitted.");
        }
        const [svc] = await tx.select().from(service).where(eq(service.id, body.serviceId));
        if (!svc) throw problems.invalid("The service was not found.");
        const { conditions, current } = await decisionsFor(tx, id);
        const decision = current ? domainDecision(current, conditions) : null;
        const conditionsMet = current
          ? conditions
              .filter((x) => x.decisionId === current.id)
              .sort((a, b) => a.position - b.position)
              .map((x) => x.metAt !== null)
          : [];
        let targetRoom: typeof room.$inferSelect | null = null;
        let plan: ReturnType<typeof planBedMove> | null = null;
        if (body.roomId) {
          const [found] = await tx.select().from(room).where(eq(room.id, body.roomId));
          if (!found || found.deletedAt) throw problems.invalid("The room was not found.");
          if (found.locationId !== svc.locationId) {
            throw problems.invalid("The room is not at the service's location.");
          }
          requireLocationInScope(access, found.locationId);
          targetRoom = found;
          const periods = await occupancyRows(tx, { roomIds: [found.id] });
          const own = await occupancyRows(tx, { personId: id });
          plan = planBedMove(
            [...periods, ...own.filter((o) => !periods.some((x) => x.id === o.id))].map(toPeriod),
            [toRoomView(found)],
            {
              personId: id,
              toRoomId: found.id,
              toBed: body.bed,
              on: body.startDate,
              reason: "Admission",
            },
            today,
          );
        }
        const readiness = checkAdmissionReadiness({
          decision,
          conditionsMet,
          placement: {
            type: body.placementType,
            startDate: body.startDate,
            trialEndsOn: body.trialEndsOn ?? null,
          },
          bed: body.placementType === "package" ? null : plan,
        });
        if (!readiness.ready) {
          throw problems.invalid(
            [
              ...readiness.problems.map((problem) => READINESS_MESSAGES[problem]),
              ...(plan && !plan.ok ? [plan.message] : []),
            ].join(" "),
          );
        }
        const outcome = await changeStatus(
          c,
          tx,
          p,
          {
            to: "active",
            effectiveAt: new Date(body.admittedAt),
            reason: null,
            admissionReady: true,
          },
          now,
        );
        const [placed] = await tx
          .insert(placement)
          .values({
            personId: id,
            serviceId: svc.id,
            roomId: targetRoom?.id ?? null,
            type: body.placementType,
            startDate: body.startDate,
            trialEndsOn: body.trialEndsOn ?? decision?.trialEndsOn ?? null,
            localAuthorityFunded: body.localAuthorityFunded,
            nhsFunded: body.nhsFunded,
            dependencyCategory: body.dependencyCategory ?? null,
            admissionDecisionId: current?.id ?? null,
          })
          .returning();
        if (!placed) throw problems.conflict();
        let bed: BedOccupancyItem | null = null;
        let personRow = outcome.person;
        if (plan?.ok && targetRoom) {
          const [period] = await tx
            .insert(bedOccupancy)
            .values({
              personId: id,
              roomId: targetRoom.id,
              bed: plan.open.bed,
              fromDate: plan.open.from,
              reason: "Admission",
              backdated: plan.backdated,
            })
            .returning();
          if (period) bed = occupancyItem(period, new Map([[targetRoom.id, targetRoom.label]]));
          const label = roomLabelOn(
            period ? [toPeriod(period)] : [],
            [toRoomView(targetRoom)],
            id,
            today,
          );
          const [labelled] = await tx
            .update(person)
            .set({ roomLabel: label, locationId: targetRoom.locationId })
            .where(eq(person.id, id))
            .returning();
          if (labelled) personRow = labelled;
        }
        const { items } = await checklistDefinition(tx);
        for (const [position, item] of items.entries()) {
          await tx.insert(welcomeChecklistItem).values({
            personId: id,
            placementId: placed.id,
            itemKey: item.key,
            title: item.title,
            required: item.required,
            safetyCritical: item.safetyCritical,
            allowNotApplicable: item.allowNotApplicable,
            position,
          });
        }
        await audit(c, tx, access, {
          action: "people.person.admit",
          resourceType: "person",
          resourceId: id,
          scope: { placementId: placed.id, type: body.placementType },
        });
        return {
          personId: id,
          status: personRow.status,
          placement: placementItem(placed),
          bed,
          welcomeChecklist: await welcomeChecklistFor(tx, id),
          version: personRow.version,
        };
      });
      return c.json(result, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/bed-moves",
      tags: ["people"],
      summary: "The person's bed history and the room label it gives the header",
      security,
      request: { params: PersonParam },
      responses: { 200: jsonBody(BedHistory, "History"), ...errorResponses, ...notFoundResponse },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.person.read");
      const { id } = c.req.valid("param");
      const history = await withTenant(c, async (tx) => {
        const p = await loadPerson(tx, id);
        await audit(c, tx, access, {
          action: "people.bed.history",
          resourceType: "person",
          resourceId: id,
        });
        return bedHistory(tx, p, ukIsoDate(new Date()));
      });
      return c.json(history, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/bed-moves",
      tags: ["people"],
      summary: "Move the person to another bed (rule 6)",
      description:
        "planBedMove: a real date that is not in the future, not before the current bed and not the same day as it, a reason, a bed the room has in a room that is available, and nobody else in it on or after that day. A move recorded after the day it happened is flagged as backdated. The database refuses overlaps whatever the caller can see (exclusion constraints).",
      security,
      request: {
        params: PersonParam,
        body: { content: { "application/json": { schema: CreateBedMove } } },
      },
      responses: {
        201: jsonBody(BedHistory, "Moved"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.admission.manage");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const today = ukIsoDate(new Date());
      const history = await withTenant(c, async (tx) => {
        const p = await loadPerson(tx, id, true);
        requireVersion(p.version, body.version);
        requireWrite(p, "room_move");
        const [target] = await tx.select().from(room).where(eq(room.id, body.roomId));
        if (!target || target.deletedAt) throw problems.invalid("The room was not found.");
        // The room must be at a location the caller works at (rooms have only the tenant policy).
        try {
          requireLocationInScope(access, target.locationId);
        } catch {
          throw problems.invalid("The room was not found.");
        }
        const own = await occupancyRows(tx, { personId: id });
        const inRoom = await occupancyRows(tx, { roomIds: [target.id] });
        const periods = [...own, ...inRoom.filter((r) => !own.some((o) => o.id === r.id))];
        const roomIds = [...new Set([target.id, ...own.map((o) => o.roomId)])];
        const rooms = await tx.select().from(room).where(inArray(room.id, roomIds));
        const plan = planBedMove(
          periods.map(toPeriod),
          rooms.map(toRoomView),
          { personId: id, toRoomId: target.id, toBed: body.bed, on: body.on, reason: body.reason },
          today,
        );
        if (!plan.ok) throw problems.invalid(plan.message);
        if (plan.close) {
          await tx
            .update(bedOccupancy)
            .set({ toDate: plan.close.to })
            .where(eq(bedOccupancy.id, plan.close.periodId));
        }
        const [opened] = await tx
          .insert(bedOccupancy)
          .values({
            personId: id,
            roomId: target.id,
            bed: plan.open.bed,
            fromDate: plan.open.from,
            reason: body.reason,
            backdated: plan.backdated,
          })
          .returning()
          .catch((error: unknown) => {
            const code =
              (error as { code?: string }).code ??
              (error as { cause?: { code?: string } }).cause?.code;
            if (code === "23P01")
              throw problems.invalid("Someone else occupies that bed on or after that date.");
            throw error;
          });
        if (!opened) throw problems.conflict();
        await tx
          .update(placement)
          .set({ roomId: target.id })
          .where(
            and(eq(placement.personId, id), isNull(placement.endDate), isNull(placement.deletedAt)),
          );
        const after = await occupancyRows(tx, { personId: id });
        await tx
          .update(person)
          .set({
            roomLabel: roomLabelOn(after.map(toPeriod), rooms.map(toRoomView), id, today),
            locationId: target.locationId,
          })
          .where(and(eq(person.id, id), eq(person.version, body.version)));
        // A move changes the room, and perhaps the home, on the downtime packs (#47 review round
        // 1, H2): operations builds them again at both locations.
        await publish(tx, {
          context: "people",
          aggregateType: "person",
          aggregateId: id,
          type: "people.person.moved",
          payload: {
            personId: id,
            locationId: p.locationId,
            toLocationId: target.locationId,
            roomChanged: true,
          },
        });
        await audit(c, tx, access, {
          action: "people.bed.move",
          resourceType: "bed_occupancy",
          resourceId: opened.id,
          reason: body.reason,
          scope: { backdated: plan.backdated },
        });
        return bedHistory(tx, { ...p, locationId: target.locationId }, today);
      });
      return c.json(history, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/locations/{id}/beds",
      tags: ["people"],
      summary: "The bed board on a date: every room and bed, and who occupies it",
      description:
        "Every occupied bed shows as occupied; the occupant is named only when the person is in your access.",
      security,
      request: { params: LocationParam, query: z.object({ date: z.iso.date().optional() }) },
      responses: { 200: jsonBody(BedBoard, "Bed board"), ...errorResponses, ...notFoundResponse },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [
        "operations.occupancy.manage",
        "people.admission.manage",
        "people.person.read",
      ]);
      const { id } = c.req.valid("param");
      const date = c.req.valid("query").date ?? ukIsoDate(new Date());
      const board = await withTenant(c, async (tx) => {
        const [loc] = await tx
          .select({ id: location.id })
          .from(location)
          .where(eq(location.id, id));
        if (!loc) throw problems.notFound();
        // A care worker (assigned scope) sees the board of a home where they care for someone.
        if (access.context.scope === "assigned") {
          const [anyone] = await tx
            .select({ id: person.id })
            .from(person)
            .where(and(eq(person.locationId, id), isNull(person.deletedAt)))
            .limit(1);
          if (!anyone) throw problems.notFound();
        } else {
          requireLocationInScope(access, id);
        }
        const rooms = await tx
          .select()
          .from(room)
          .where(and(eq(room.locationId, id), isNull(room.deletedAt)))
          .orderBy(asc(room.label));
        const periods = await occupancyRows(tx, { roomIds: rooms.map((r) => r.id) });
        const onDate = periods.filter(
          (p) => p.fromDate <= date && (p.toDate === null || p.toDate > date),
        );
        const visible =
          onDate.length === 0
            ? []
            : await tx
                .select({ id: person.id, given: person.givenName, family: person.familyName })
                .from(person)
                .where(inArray(person.id, [...new Set(onDate.map((p) => p.personId))]));
        const names = new Map(visible.map((v) => [v.id, `${v.given} ${v.family}`]));
        await audit(c, tx, access, {
          action: "people.bed_board.view",
          resourceType: "location",
          resourceId: id,
          scope: { date, occupied: onDate.length },
        });
        return {
          locationId: id,
          date,
          rooms: rooms.map((r) => ({
            roomId: r.id,
            label: r.label,
            unitName: r.unitName,
            status: r.status as "available" | "out_of_service" | "awaiting_clearance",
            beds: Array.from({ length: r.beds }, (_, i) => {
              const period = onDate.find((p) => p.roomId === r.id && p.bed === i + 1);
              const name = period ? (names.get(period.personId) ?? null) : null;
              return {
                bed: i + 1,
                occupied: period !== undefined,
                personId: period && name ? period.personId : null,
                name,
                since: period?.fromDate ?? null,
              };
            }),
          })),
        };
      });
      return c.json(board, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/rooms/{roomId}/clearance",
      tags: ["people"],
      summary: "Record that a room held after a death has been cleared (rule 6)",
      description:
        "Ends the bed period of the person who died on the day the room was cleared (planBedRelease) and makes the room available again.",
      security,
      request: {
        params: RoomParam,
        body: {
          content: {
            "application/json": {
              schema: z.object({ on: z.iso.date(), version: z.number().int().min(1) }),
            },
          },
        },
      },
      responses: {
        200: jsonBody(
          z.object({ roomId: z.uuid(), status: z.string(), version: z.number().int() }),
          "Cleared",
        ),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [
        "people.admission.manage",
        "people.property.manage",
      ]);
      const { roomId } = c.req.valid("param");
      const body = c.req.valid("json");
      if (body.on > ukIsoDate(new Date()))
        throw problems.invalid("The room cannot be cleared in the future.");
      const result = await withTenant(c, async (tx) => {
        const [target] = await tx.select().from(room).where(eq(room.id, roomId));
        if (!target) throw problems.notFound();
        requireLocationInScope(access, target.locationId);
        requireVersion(target.version, body.version);
        if (target.status !== "awaiting_clearance") {
          throw problems.invalid("This room is not waiting to be cleared.");
        }
        const periods = await occupancyRows(tx, { roomIds: [roomId] });
        const open = periods.filter((p) => p.toDate === null);
        const occupants =
          open.length === 0
            ? []
            : await tx
                .select({ id: person.id, status: person.status })
                .from(person)
                .where(
                  inArray(
                    person.id,
                    open.map((p) => p.personId),
                  ),
                );
        // Someone the caller cannot see is still in the room: a manager who can see them clears it.
        if (open.some((period) => !occupants.some((o) => o.id === period.personId))) {
          throw problems.invalid(
            "Someone outside your access still has a bed in this room. Ask a manager who can see them.",
          );
        }
        for (const period of open) {
          const occupant = occupants.find((o) => o.id === period.personId);
          if (occupant?.status !== "deceased" && occupant?.status !== "archived") continue;
          const release = planBedRelease(periods.map(toPeriod), period.personId, body.on);
          if (!release)
            throw problems.invalid("The clearance cannot be before the person's bed period began.");
          await tx
            .update(bedOccupancy)
            .set({ toDate: release.to })
            .where(eq(bedOccupancy.id, release.periodId));
        }
        const [updated] = await tx
          .update(room)
          .set({ status: "available" })
          .where(and(eq(room.id, roomId), eq(room.version, body.version)))
          .returning();
        if (!updated) throw problems.conflict();
        await audit(c, tx, access, {
          action: "people.room.clear",
          resourceType: "room",
          resourceId: roomId,
          scope: { on: body.on },
        });
        return { roomId, status: updated.status, version: updated.version };
      });
      return c.json(result, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/welcome-checklist",
      tags: ["people"],
      summary: "The welcome checklist of the current placement, safety-critical items first",
      security,
      request: { params: PersonParam },
      responses: {
        200: jsonBody(AdmissionView.shape.welcomeChecklist, "Checklist"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.person.read");
      const { id } = c.req.valid("param");
      const checklist = await withTenant(c, async (tx) => {
        await loadPerson(tx, id);
        await audit(c, tx, access, {
          action: "people.welcome_checklist.view",
          resourceType: "person",
          resourceId: id,
        });
        return welcomeChecklistFor(tx, id);
      });
      return c.json(checklist, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/people/{id}/welcome-checklist/{itemKey}",
      tags: ["people"],
      summary: "Tick an item of the welcome checklist, or mark it not applicable with a reason",
      security,
      request: {
        params: ItemParams,
        body: { content: { "application/json": { schema: UpdateWelcomeChecklistItem } } },
      },
      responses: {
        200: jsonBody(AdmissionView.shape.welcomeChecklist, "Saved"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, ["people.admission.manage", "care.plan.write"]);
      const { id, itemKey } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const checklist = await withTenant(c, async (tx) => {
        const p = await loadPerson(tx, id);
        requireWrite(p, "care_plan");
        const current = await currentPlacement(tx, id);
        if (!current) throw problems.notFound();
        const rows = await tx
          .select()
          .from(welcomeChecklistItem)
          .where(
            and(
              eq(welcomeChecklistItem.placementId, current.id),
              isNull(welcomeChecklistItem.deletedAt),
            ),
          );
        const row = rows.find((r) => r.itemKey === itemKey);
        if (!row) throw problems.notFound();
        requireVersion(row.version, body.version);
        const next = {
          ...row,
          status: body.status,
          reason: body.status === "not_applicable" ? (body.reason ?? null) : null,
          doneBy: body.status === "pending" ? null : access.tenantUserId,
          doneAt: body.status === "pending" ? null : now,
        };
        const status = checklistOut(
          current.id,
          rows.map((r) => (r.id === row.id ? next : r)),
        );
        if (status.invalid.includes(itemKey)) {
          throw problems.invalid(
            row.allowNotApplicable
              ? "Say why this item does not apply."
              : "This item cannot be marked not applicable.",
          );
        }
        const [updated] = await tx
          .update(welcomeChecklistItem)
          .set({
            status: next.status,
            reason: next.reason,
            doneBy: next.doneBy,
            doneAt: next.doneAt,
          })
          .where(
            and(
              eq(welcomeChecklistItem.id, row.id),
              eq(welcomeChecklistItem.version, body.version),
            ),
          )
          .returning();
        if (!updated) throw problems.conflict();
        await audit(c, tx, access, {
          action: "people.welcome_checklist.update",
          resourceType: "welcome_checklist_item",
          resourceId: row.id,
          scope: { itemKey, status: body.status },
        });
        return welcomeChecklistFor(tx, id);
      });
      return c.json(checklist, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/settings/welcome-checklist",
      tags: ["people"],
      summary: "The organisation's welcome checklist (Harbour's default until it is changed)",
      security,
      responses: { 200: jsonBody(WelcomeChecklistTemplate, "Checklist"), ...errorResponses },
    }),
    async (c) => {
      await requirePermission(c, "platform.tenant.manage");
      const template = await withTenant(c, async (tx) => {
        const { row, items } = await checklistDefinition(tx);
        return {
          items: items.map((i) => ({ ...i, hazardIds: [...i.hazardIds] })),
          isDefault: row === null,
          version: row?.version ?? 0,
        };
      });
      return c.json(template, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/settings/welcome-checklist",
      tags: ["people"],
      summary: "Change the organisation's welcome checklist",
      description:
        "checkWelcomeChecklistDefinition: a tenant may add items but never remove or weaken Harbour's safety-critical ones (photo, allergies, medicines, diet and IDDSI levels, evacuation plan). New admissions use it; earlier checklists keep their items.",
      security,
      request: {
        body: { content: { "application/json": { schema: UpdateWelcomeChecklistTemplate } } },
      },
      responses: {
        200: jsonBody(WelcomeChecklistTemplate, "Saved"),
        ...errorResponses,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "platform.tenant.manage");
      const body = c.req.valid("json");
      const issues = checkWelcomeChecklistDefinition(body.items);
      if (issues.length > 0) {
        throw problems.invalid(
          issues
            .map((i) =>
              i.kind === "duplicate_key"
                ? `${i.key} is listed twice.`
                : i.kind === "safety_item_missing"
                  ? `${i.key} is safety-critical and cannot be removed.`
                  : `${i.key} is safety-critical: keep it required and do not allow 'not applicable'.`,
            )
            .join(" "),
        );
      }
      const template = await withTenant(c, async (tx) => {
        const { row } = await checklistDefinition(tx);
        requireVersion(row?.version ?? 0, body.version);
        const saved = row
          ? (
              await tx
                .update(welcomeChecklistTemplate)
                .set({ items: body.items })
                .where(
                  and(
                    eq(welcomeChecklistTemplate.id, row.id),
                    eq(welcomeChecklistTemplate.version, body.version),
                  ),
                )
                .returning()
            )[0]
          : (
              await tx.insert(welcomeChecklistTemplate).values({ items: body.items }).returning()
            )[0];
        if (!saved) throw problems.conflict();
        await audit(c, tx, access, {
          action: "people.welcome_checklist_template.update",
          resourceType: "welcome_checklist_template",
          resourceId: saved.id,
          scope: { items: body.items.length },
        });
        return { items: body.items, isDefault: false, version: saved.version };
      });
      return c.json(template, 200);
    },
  );
