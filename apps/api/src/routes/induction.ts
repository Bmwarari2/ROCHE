import {
  AnswerReferenceRequest,
  CareCertificateView,
  DecideProbation,
  InductionDetail,
  LeavingDetail,
  RecordCareCertificateStep,
  RecordExitInterview,
  RecordLeaving,
  RecordProbationReview,
  RecordReferenceRequest,
  RecordShadowShift,
  SetInductionPlan,
  TickItem,
} from "@harbour/contracts";
import {
  careCertificateProgress as careCertificateTable,
  inductionPlan,
  leaverRecord,
  probationReview,
  referenceRequest,
  retentionClass,
  shadowShift,
  staffChecklistItem,
  staffProfile,
  type Transaction,
} from "@harbour/db";
import {
  CARE_CERTIFICATE_STANDARDS,
  type CareCertificateStandardId,
  careCertificateProgress,
  checkExitInterview,
  checkLeaving,
  checkProbationDecision,
  checkStandardChange,
  checkSupervisedEntry,
  type ExitInterviewState,
  type InductionItemKind,
  inductionState,
  type LeaverItemKind,
  leaverState,
  type ProbationOutcome,
  resolveRate,
  type StandardProgress,
  staffFileRetainUntil,
  ukIsoDate,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import type { Context } from "hono";
import { AuditedRefusal, withAuditedRefusal, writeAudit } from "../http/audit";
import {
  type AppEnv,
  refusalOf,
  requireAnyPermission,
  requirePermission,
  stepUpFresh,
  stepUpRefusal,
  type TenantAccess,
  withTenant,
} from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { rateRows } from "../services/rates";
import {
  fileState,
  loadStaffFile,
  nationOf,
  type StaffProfileRow,
  workforceRates,
} from "../services/staff-files";
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
 * Induction, the Care Certificate and leavers (workforce.md section 2e, rules 19 to 23 and
 * section 5; WORK-004, WORK-013; plan slice 29). Read with workforce.staff_file.read (or the
 * worker's own with workforce.self.read); written with .manage, never on one's own file; Care
 * Certificate observations by holders of workforce.competence.observe. The database enforces the
 * same (migration 0091). Audit events carry opaque ids and codes only: never notes, the exit
 * interview summary or a requester's name.
 */

const READ = "workforce.staff_file.read";
const MANAGE = "workforce.staff_file.manage";
const OBSERVE = "workforce.competence.observe";
const SELF = "workforce.self.read";
const A = {
  viewed: "workforce.induction.viewed",
  planSet: "workforce.induction.plan_set",
  ticked: "workforce.induction.item_ticked",
  shadow: "workforce.induction.shadow_shift",
  review: "workforce.induction.probation_review",
  probation: "workforce.induction.probation_decided",
  careCertificate: "workforce.care_certificate.recorded",
  leavingViewed: "workforce.leaving.viewed",
  leaving: "workforce.leaving.recorded",
  leaverTicked: "workforce.leaving.item_ticked",
  exitInterview: "workforce.leaving.exit_interview",
  accessEnded: "workforce.leaving.access_ended",
  referenceRequested: "workforce.reference.requested",
  referenceAnswered: "workforce.reference.answered",
} as const;
const SOURCE = "staff_profile";

const FileParam = z.object({ id: z.uuid() });
const InductionItemParam = z.object({
  id: z.uuid(),
  kind: z.enum([
    "contract_issued",
    "system_access_set_up",
    "uniform_and_badge",
    "location_induction",
    "fire_safety_briefing",
    "shadowing_signed_off",
  ]),
});
const LeaverItemParam = z.object({
  id: z.uuid(),
  kind: z.enum(["property_returned", "final_pay_notified"]),
});
const StandardParam = z.object({
  id: z.uuid(),
  standardId: z.enum(CARE_CERTIFICATE_STANDARDS.map((s) => s.id) as [string, ...string[]]),
});
const ReferenceParam = z.object({ id: z.uuid(), referenceId: z.uuid() });

const refused = (problem: HttpProblem, action: string, id: string, reason: string) =>
  new AuditedRefusal(problem, {
    action,
    outcome: "denied",
    resourceType: SOURCE,
    resourceId: id,
    reason,
  });

const today = () => ukIsoDate(new Date());

/** Runs a change; refusals and the database's own are audited. */
async function change<T>(
  c: Context<AppEnv>,
  access: TenantAccess,
  action: string,
  id: string,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  try {
    return await withAuditedRefusal(c, access, () => withTenant(c, fn));
  } catch (error) {
    const code = dbCode(error);
    if (!["42501", "23000", "23505", "23503", "23514", "55000"].includes(code ?? "")) throw error;
    await writeAudit(c.get("services").appPool, access, {
      action,
      outcome: "denied",
      resourceType: SOURCE,
      resourceId: id,
      reason: code === "42501" ? "refused_by_database" : `invalid_${code}`,
      requestId: c.get("requestId"),
    });
    if (code === "42501") throw problems.forbidden();
    if (code === "23505")
      throw new HttpProblem(409, "already_recorded", "This is already recorded.");
    if (code === "23503")
      throw problems.invalid("Choose members and locations of this organisation.");
    throw problems.invalid("Those details cannot be saved together. Check them and try again.");
  }
}

/** The staff file the caller can see; with `notOwn`, refused on the caller's own file. */
async function profileFor(
  tx: Transaction,
  access: TenantAccess,
  action: string,
  id: string,
  notOwn: boolean,
): Promise<StaffProfileRow> {
  const found = await loadStaffFile(tx, id);
  if (!found) throw refused(problems.notFound(), action, id, "not_found");
  if (notOwn && found.profile.tenantUserId === access.tenantUserId) {
    throw refused(
      new HttpProblem(403, "own_staff_file", "Someone else records this on your own staff file."),
      action,
      id,
      "own_staff_file",
    );
  }
  return found.profile;
}

/** The start date a rule counts from; refused until the staff file records one. */
function startOf(profile: StaffProfileRow, action: string): string {
  if (profile.startsOn === null) {
    throw refused(
      problems.invalid("Record the start date on the staff file first."),
      action,
      profile.id,
      "no_start_date",
    );
  }
  return profile.startsOn;
}

async function inductionOf(
  tx: Transaction,
  access: TenantAccess,
  profile: StaffProfileRow,
): Promise<InductionDetail> {
  const on = today();
  const [plan] = await tx
    .select()
    .from(inductionPlan)
    .where(eq(inductionPlan.staffProfileId, profile.id));
  const ticks = await tx
    .select()
    .from(staffChecklistItem)
    .where(
      and(
        eq(staffChecklistItem.staffProfileId, profile.id),
        eq(staffChecklistItem.checklist, "induction"),
      ),
    );
  const standards = await tx
    .select()
    .from(careCertificateTable)
    .where(eq(careCertificateTable.staffProfileId, profile.id));
  const shadows = await tx
    .select()
    .from(shadowShift)
    .where(eq(shadowShift.staffProfileId, profile.id))
    .orderBy(asc(shadowShift.shiftOn), asc(shadowShift.id));
  const reviews = await tx
    .select()
    .from(probationReview)
    .where(eq(probationReview.staffProfileId, profile.id))
    .orderBy(asc(probationReview.reviewOn), asc(probationReview.id));
  const signing = await tx.execute<{ required: number; signed: number }>(
    sql`SELECT * FROM app.induction_policy_signing(${profile.id}::uuid)`,
  );
  const policies = signing.rows[0] ?? { required: 0, signed: 0 };
  const items = await loadStaffFile(tx, profile.id);
  const rates = await workforceRates(
    tx,
    access.tenantId,
    await nationOf(tx, profile.locationId),
    on,
  );
  const fileComplete = fileState(profile, items?.items ?? [], on, rates).state.complete;
  const progress: StandardProgress[] = standards.map((s) => ({
    standardId: s.standardId as CareCertificateStandardId,
    knowledgeAssessedOn: s.knowledgeAssessedOn,
    knowledgeAssessedBy: s.knowledgeAssessedBy,
    observedOn: s.observedOn,
    observedBy: s.observedBy,
  }));
  const cc = careCertificateProgress(progress);
  const state = inductionState({
    ticked: new Set(ticks.map((t) => t.kind as InductionItemKind)),
    staffFileComplete: fileComplete,
    policies,
    careCertificate: { complete: cc.complete, alreadyHeld: plan?.careCertificateHeld ?? false },
    probation: {
      endsOn: plan?.probationEndsOn ?? null,
      outcome: (plan?.probationOutcome ?? null) as ProbationOutcome | null,
    },
    // No start date yet: nothing is overdue.
    startsOn: profile.startsOn ?? "9999-12-31",
    today: on,
  });
  return {
    staffProfileId: profile.id,
    startsOn: profile.startsOn,
    planVersion: plan?.version ?? null,
    careCertificateHeld: plan?.careCertificateHeld ?? false,
    checklist: state.map((s) => ({
      ...s,
      doneOn: ticks.find((t) => t.kind === s.kind)?.doneOn ?? null,
    })),
    policies: { required: Number(policies.required), signed: Number(policies.signed) },
    careCertificate: {
      ...cc,
      standards: cc.standards.map((s) => {
        const row = standards.find((r) => r.standardId === s.id);
        return {
          ...s,
          knowledgeAssessedOn: row?.knowledgeAssessedOn ?? null,
          knowledgeAssessedBy: row?.knowledgeAssessedBy ?? null,
          observedOn: row?.observedOn ?? null,
          observedBy: row?.observedBy ?? null,
          version: row?.version ?? null,
        };
      }),
    },
    shadowShifts: shadows.map((s) => ({
      id: s.id,
      shiftOn: s.shiftOn,
      locationId: s.locationId,
      shadowedId: s.shadowedId,
    })),
    probation: {
      endsOn: plan?.probationEndsOn ?? null,
      outcome: (plan?.probationOutcome ?? null) as ProbationOutcome | null,
      decidedOn: plan?.probationDecidedOn ?? null,
      decidedBy: plan?.probationDecidedBy ?? null,
      reviews: reviews.map((r) => ({
        id: r.id,
        reviewOn: r.reviewOn,
        reviewerId: r.reviewerId,
        outcome: r.outcome as "on_track" | "concerns",
        notes: r.notes,
      })),
    },
    asOf: on,
  };
}

/** The Care Certificate part alone: what an assessor without the staff file may see. */
async function careCertificateView(
  tx: Transaction,
  profileId: string,
): Promise<CareCertificateView> {
  const rows = await tx
    .select()
    .from(careCertificateTable)
    .where(eq(careCertificateTable.staffProfileId, profileId));
  const cc = careCertificateProgress(
    rows.map((s) => ({
      standardId: s.standardId as CareCertificateStandardId,
      knowledgeAssessedOn: s.knowledgeAssessedOn,
      knowledgeAssessedBy: s.knowledgeAssessedBy,
      observedOn: s.observedOn,
      observedBy: s.observedBy,
    })),
  );
  return {
    staffProfileId: profileId,
    careCertificate: {
      ...cc,
      standards: cc.standards.map((s) => {
        const row = rows.find((r) => r.standardId === s.id);
        return {
          ...s,
          knowledgeAssessedOn: row?.knowledgeAssessedOn ?? null,
          knowledgeAssessedBy: row?.knowledgeAssessedBy ?? null,
          observedOn: row?.observedOn ?? null,
          observedBy: row?.observedBy ?? null,
          version: row?.version ?? null,
        };
      }),
    },
  };
}

async function leavingOf(tx: Transaction, profileId: string): Promise<LeavingDetail | null> {
  const [leaver] = await tx
    .select()
    .from(leaverRecord)
    .where(eq(leaverRecord.staffProfileId, profileId));
  if (!leaver) return null;
  const ticks = await tx
    .select()
    .from(staffChecklistItem)
    .where(
      and(
        eq(staffChecklistItem.staffProfileId, profileId),
        eq(staffChecklistItem.checklist, "leaving"),
      ),
    );
  const references = await tx
    .select()
    .from(referenceRequest)
    .where(eq(referenceRequest.staffProfileId, profileId))
    .orderBy(asc(referenceRequest.requestedOn), asc(referenceRequest.id));
  const on = today();
  const state = leaverState({
    ticked: new Set(ticks.map((t) => t.kind as LeaverItemKind)),
    accessRemoved: leaver.accessRemovedAt !== null,
    exitInterview: leaver.exitInterview as ExitInterviewState,
    leavingOn: leaver.leavingOn,
    today: on,
  });
  return {
    staffProfileId: profileId,
    leavingOn: leaver.leavingOn,
    reason: leaver.reason as LeavingDetail["reason"],
    accessRemovedAt: leaver.accessRemovedAt?.toISOString() ?? null,
    exitInterview: leaver.exitInterview as ExitInterviewState,
    exitInterviewOn: leaver.exitInterviewOn,
    exitInterviewSummary: leaver.exitInterviewSummary,
    staffFileRetainUntil: leaver.staffFileRetainUntil,
    checklist: state.map((s) => ({
      ...s,
      doneOn: ticks.find((t) => t.kind === s.kind)?.doneOn ?? null,
    })),
    references: references.map((r) => ({
      id: r.id,
      requestedOn: r.requestedOn,
      requester: r.requester,
      kind: r.kind as "factual" | "conduct",
      state: r.state as "requested" | "sent" | "declined",
      sentOn: r.sentOn,
      declinedReason: r.declinedReason,
      version: r.version,
    })),
    version: leaver.version,
    asOf: on,
  };
}

/**
 * How long the staff file is kept (rule 23): the organisation's chosen staff file row (its own
 * `staff_file.after_leaving` row when it set one, else the default to the 75th birthday; H-874),
 * and the birthday age from the rate table.
 */
async function retainUntil(
  tx: Transaction,
  tenantId: string,
  profile: StaffProfileRow,
  leftOn: string,
): Promise<string | null> {
  const rows = await tx
    .select()
    .from(retentionClass)
    .where(
      and(
        eq(retentionClass.recordClass, "staff_file.after_leaving"),
        or(isNull(retentionClass.tenantId), eq(retentionClass.tenantId, tenantId)),
      ),
    );
  const own = rows.find((r) => r.tenantId === tenantId);
  const global = rows.find((r) => r.tenantId === null);
  const row = own ?? global;
  if (!row) throw new Error("retention class staff_file.after_leaving is not seeded");
  const nation = await nationOf(tx, profile.locationId);
  const age = resolveRate(
    await rateRows(tx, ["retention.staff_file.birthday_age"]),
    "retention.staff_file.birthday_age",
    nation,
    leftOn,
    tenantId,
  ).value;
  return staffFileRetainUntil({
    leftOn,
    dateOfBirth: profile.dateOfBirth,
    choice: own ? "staff_file.after_leaving" : "staff_file.to_75th_birthday",
    afterLeaving: { period: row.period, unit: row.unit as "years" | "months" },
    birthdayAge: age,
  });
}

const auditFile = (
  c: Context<AppEnv>,
  tx: Transaction,
  access: TenantAccess,
  action: string,
  id: string,
  scopeExtra?: Record<string, string>,
) =>
  audit(c, tx, access, {
    action,
    resourceType: SOURCE,
    resourceId: id,
    ...(scopeExtra ? { scopeExtra } : {}),
  });

const inductionResponses = {
  200: jsonBody(InductionDetail, "The induction"),
  ...errorResponses,
  ...notFoundResponse,
  ...conflictResponse,
};
const leavingResponses = {
  200: jsonBody(LeavingDetail, "The leaving"),
  ...errorResponses,
  ...notFoundResponse,
  ...conflictResponse,
};

/** A change to someone else's induction with .manage, returning the induction. */
async function inductionChange(
  c: Context<AppEnv>,
  action: string,
  id: string,
  fn: (tx: Transaction, profile: StaffProfileRow, access: TenantAccess) => Promise<void>,
): Promise<InductionDetail> {
  const access = await requirePermission(c, MANAGE);
  return change(c, access, action, id, async (tx) => {
    const profile = await profileFor(tx, access, action, id, true);
    await fn(tx, profile, access);
    return inductionOf(tx, access, profile);
  });
}

async function leavingChange(
  c: Context<AppEnv>,
  action: string,
  id: string,
  fn: (tx: Transaction, profile: StaffProfileRow, access: TenantAccess) => Promise<void>,
): Promise<LeavingDetail> {
  const access = await requirePermission(c, MANAGE);
  return change(c, access, action, id, async (tx) => {
    const profile = await profileFor(tx, access, action, id, true);
    await fn(tx, profile, access);
    const detail = await leavingOf(tx, id);
    if (!detail) throw refused(problems.notFound(), action, id, "not_leaving");
    return detail;
  });
}

const domainRefusal = (action: string, id: string, problem: string, message: string) =>
  refused(problems.invalid(message), action, id, problem);

export const inductionRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/workforce/staff-files/{id}/induction",
      tags: ["workforce"],
      summary: "A new starter's induction",
      description:
        "workforce.staff_file.read. The checklist with each item's status, read-and-sign counts, the Care Certificate, shadow shifts and probation. Audited.",
      security,
      request: { params: FileParam },
      responses: {
        200: jsonBody(InductionDetail, "The induction"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const access = await requirePermission(c, READ);
      const detail = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          const profile = await profileFor(tx, access, A.viewed, id, false);
          await auditFile(c, tx, access, A.viewed, id);
          return inductionOf(tx, access, profile);
        }),
      );
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/me/induction",
      tags: ["workforce"],
      summary: "My induction",
      description: "workforce.self.read. The member's own induction and Care Certificate.",
      security,
      responses: {
        200: jsonBody(InductionDetail, "Your induction"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, SELF);
      const detail = await withTenant(c, async (tx) => {
        const [profile] = await tx
          .select()
          .from(staffProfile)
          .where(
            and(eq(staffProfile.tenantUserId, access.tenantUserId), isNull(staffProfile.deletedAt)),
          );
        if (!profile) return null;
        await auditFile(c, tx, access, A.viewed, profile.id);
        return inductionOf(tx, access, profile);
      });
      if (!detail) throw problems.notFound();
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/workforce/staff-files/{id}/induction",
      tags: ["workforce"],
      summary: "Set up the induction plan",
      description:
        "workforce.staff_file.manage, never on one's own file. The probation end date and whether the worker already holds the Care Certificate; expectedVersion once the plan exists. Audited.",
      security,
      request: {
        params: FileParam,
        body: { content: { "application/json": { schema: SetInductionPlan } } },
      },
      responses: inductionResponses,
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const detail = await inductionChange(c, A.planSet, id, async (tx, profile, access) => {
        if (body.probationEndsOn !== null && body.probationEndsOn <= startOf(profile, A.planSet)) {
          throw domainRefusal(
            A.planSet,
            id,
            "probation_before_start",
            "Probation ends after the start date.",
          );
        }
        const [plan] = await tx
          .select()
          .from(inductionPlan)
          .where(eq(inductionPlan.staffProfileId, id));
        if (!plan) {
          await tx.insert(inductionPlan).values({
            staffProfileId: id,
            probationEndsOn: body.probationEndsOn,
            careCertificateHeld: body.careCertificateHeld,
          });
        } else {
          if (plan.version !== body.expectedVersion) {
            throw refused(problems.conflict(), A.planSet, id, "version_conflict");
          }
          if (plan.probationOutcome !== null && body.probationEndsOn !== plan.probationEndsOn) {
            throw domainRefusal(
              A.planSet,
              id,
              "probation_decided",
              "Probation has been decided; record a decision instead.",
            );
          }
          const [updated] = await tx
            .update(inductionPlan)
            .set({
              probationEndsOn: body.probationEndsOn,
              careCertificateHeld: body.careCertificateHeld,
            })
            .where(and(eq(inductionPlan.id, plan.id), eq(inductionPlan.version, plan.version)))
            .returning();
          if (!updated) throw refused(problems.conflict(), A.planSet, id, "version_conflict");
        }
        await auditFile(c, tx, access, A.planSet, id);
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/staff-files/{id}/induction/items/{kind}",
      tags: ["workforce"],
      summary: "Tick an induction item",
      description:
        "workforce.staff_file.manage, never on one's own file, in the caller's own name. Audited.",
      security,
      request: {
        params: InductionItemParam,
        body: { content: { "application/json": { schema: TickItem } } },
      },
      responses: inductionResponses,
    }),
    async (c) => {
      const { id, kind } = c.req.valid("param");
      const body = c.req.valid("json");
      const detail = await inductionChange(c, A.ticked, id, async (tx, _profile, access) => {
        if (body.doneOn > today()) {
          throw domainRefusal(A.ticked, id, "date_in_future", "The date cannot be in the future.");
        }
        await tx.insert(staffChecklistItem).values({
          staffProfileId: id,
          checklist: "induction",
          kind,
          doneOn: body.doneOn,
          doneBy: access.tenantUserId,
        });
        await auditFile(c, tx, access, A.ticked, id, { kind });
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/staff-files/{id}/induction/shadow-shifts",
      tags: ["workforce"],
      summary: "Record a shadow shift",
      description:
        "workforce.staff_file.manage, never on one's own file: the day, where, and the colleague shadowed (never the worker). Audited.",
      security,
      request: {
        params: FileParam,
        body: { content: { "application/json": { schema: RecordShadowShift } } },
      },
      responses: inductionResponses,
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const detail = await inductionChange(c, A.shadow, id, async (tx, profile, access) => {
        const check = checkSupervisedEntry({
          workerId: profile.tenantUserId,
          byId: body.shadowedId,
          on: body.shiftOn,
          today: today(),
          startsOn: startOf(profile, A.shadow),
        });
        if (!check.ok) {
          throw domainRefusal(
            A.shadow,
            id,
            check.problem,
            "Check the date and the colleague shadowed.",
          );
        }
        await tx.insert(shadowShift).values({
          staffProfileId: id,
          shiftOn: body.shiftOn,
          locationId: body.locationId,
          shadowedId: body.shadowedId,
          recordedBy: access.tenantUserId,
        });
        await auditFile(c, tx, access, A.shadow, id);
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/staff-files/{id}/induction/probation-reviews",
      tags: ["workforce"],
      summary: "Record a probation review",
      description:
        "workforce.staff_file.manage, never on one's own file, in the reviewer's own name: on track or concerns, with notes. Audited without the notes.",
      security,
      request: {
        params: FileParam,
        body: { content: { "application/json": { schema: RecordProbationReview } } },
      },
      responses: inductionResponses,
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const detail = await inductionChange(c, A.review, id, async (tx, profile, access) => {
        const check = checkSupervisedEntry({
          workerId: profile.tenantUserId,
          byId: access.tenantUserId,
          on: body.reviewOn,
          today: today(),
          startsOn: startOf(profile, A.review),
        });
        if (!check.ok) throw domainRefusal(A.review, id, check.problem, "Check the review date.");
        await tx.insert(probationReview).values({
          staffProfileId: id,
          reviewOn: body.reviewOn,
          reviewerId: access.tenantUserId,
          outcome: body.outcome,
          notes: body.notes,
        });
        await auditFile(c, tx, access, A.review, id);
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/staff-files/{id}/induction/probation-decision",
      tags: ["workforce"],
      summary: "Decide probation",
      description:
        "workforce.staff_file.manage, never on one's own file, with the plan's expectedVersion: passed, extended to a later date, or not passed (the dismissal itself goes through an employee relations case of type probation). Audited.",
      security,
      request: {
        params: FileParam,
        body: { content: { "application/json": { schema: DecideProbation } } },
      },
      responses: inductionResponses,
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const detail = await inductionChange(c, A.probation, id, async (tx, profile, access) => {
        const [plan] = await tx
          .select()
          .from(inductionPlan)
          .where(eq(inductionPlan.staffProfileId, id));
        if (!plan)
          throw domainRefusal(A.probation, id, "no_plan", "Set up the induction plan first.");
        if (plan.version !== body.expectedVersion) {
          throw refused(problems.conflict(), A.probation, id, "version_conflict");
        }
        const check = checkProbationDecision({
          workerId: profile.tenantUserId,
          actorId: access.tenantUserId,
          endsOn: plan.probationEndsOn,
          currentOutcome: (plan.probationOutcome ?? null) as ProbationOutcome | null,
          outcome: body.outcome,
          decidedOn: body.decidedOn,
          startsOn: startOf(profile, A.probation),
          newEndsOn: body.newEndsOn,
        });
        if (!check.ok) {
          throw domainRefusal(
            A.probation,
            id,
            check.problem,
            "Probation cannot be decided like that.",
          );
        }
        const [updated] = await tx
          .update(inductionPlan)
          .set({
            probationOutcome: body.outcome,
            probationDecidedOn: body.decidedOn,
            probationDecidedBy: access.tenantUserId,
            ...(body.outcome === "extended" ? { probationEndsOn: body.newEndsOn } : {}),
          })
          .where(and(eq(inductionPlan.id, plan.id), eq(inductionPlan.version, plan.version)))
          .returning();
        if (!updated) throw refused(problems.conflict(), A.probation, id, "version_conflict");
        await auditFile(c, tx, access, A.probation, id);
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/workforce/staff-files/{id}/care-certificate/{standardId}",
      tags: ["workforce"],
      summary: "Record a Care Certificate standard's assessment or observation",
      description:
        "workforce.staff_file.manage or workforce.competence.observe, never on one's own file, in the caller's own name: the knowledge assessment, then the observation in practice (observers only). Audited.",
      security,
      request: {
        params: StandardParam,
        body: { content: { "application/json": { schema: RecordCareCertificateStep } } },
      },
      responses: {
        200: jsonBody(CareCertificateView, "The Care Certificate"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const { id, standardId } = c.req.valid("param");
      const body = c.req.valid("json");
      const access = await requireAnyPermission(c, [MANAGE, OBSERVE]);
      const observes = refusalOf(access, OBSERVE) === null;
      const detail = await change(c, access, A.careCertificate, id, async (tx) => {
        // An assessor may not read the staff file: the database tells only whether it is theirs.
        const worker = await tx.execute<{ id: string | null }>(
          sql`SELECT app.staff_profile_worker(${id}::uuid) AS id`,
        );
        const workerId = worker.rows[0]?.id ?? null;
        if (!workerId) throw refused(problems.notFound(), A.careCertificate, id, "not_found");
        const [visible] = await tx
          .select({ startsOn: staffProfile.startsOn })
          .from(staffProfile)
          .where(eq(staffProfile.id, id));
        const [current] = await tx
          .select()
          .from(careCertificateTable)
          .where(
            and(
              eq(careCertificateTable.staffProfileId, id),
              eq(careCertificateTable.standardId, standardId),
            ),
          );
        const check = checkStandardChange({
          current: current
            ? {
                standardId: current.standardId as CareCertificateStandardId,
                knowledgeAssessedOn: current.knowledgeAssessedOn,
                knowledgeAssessedBy: current.knowledgeAssessedBy,
                observedOn: current.observedOn,
                observedBy: current.observedBy,
              }
            : undefined,
          step: body.step,
          on: body.on,
          today: today(),
          // Without the staff file, an assessor's dates are checked against today only; the
          // database refuses an observation before its knowledge assessment.
          startsOn: visible?.startsOn ?? "0001-01-01",
          workerId,
          actorId: access.tenantUserId,
          actorObserves: observes,
        });
        if (!check.ok) {
          throw domainRefusal(
            A.careCertificate,
            id,
            check.problem,
            "That cannot be recorded for this standard.",
          );
        }
        if (body.step === "knowledge") {
          await tx.insert(careCertificateTable).values({
            staffProfileId: id,
            standardId,
            knowledgeAssessedOn: body.on,
            knowledgeAssessedBy: access.tenantUserId,
          });
        } else if (current) {
          await tx
            .update(careCertificateTable)
            .set({ observedOn: body.on, observedBy: access.tenantUserId })
            .where(eq(careCertificateTable.id, current.id));
        }
        await auditFile(c, tx, access, A.careCertificate, id, { standardId, step: body.step });
        return careCertificateView(tx, id);
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/workforce/staff-files/{id}/leaving",
      tags: ["workforce"],
      summary: "A leaver's record",
      description:
        "workforce.staff_file.read. The leaving date and reason, the checklist, when access ended, the exit interview, references and how long the staff file is kept. Audited.",
      security,
      request: { params: FileParam },
      responses: {
        200: jsonBody(LeavingDetail, "The leaving"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const access = await requirePermission(c, READ);
      const detail = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          await profileFor(tx, access, A.leavingViewed, id, false);
          const found = await leavingOf(tx, id);
          if (!found) throw refused(problems.notFound(), A.leavingViewed, id, "not_leaving");
          await auditFile(c, tx, access, A.leavingViewed, id);
          return found;
        }),
      );
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/staff-files/{id}/leaving",
      tags: ["workforce"],
      summary: "Record a leaving",
      description:
        "workforce.staff_file.manage, never one's own: the last day and reason. Sets the staff file's leaving date and works out how long the file is kept; access ends from the day after the leaving date (the sweep), or at once with end-access. Audited.",
      security,
      request: {
        params: FileParam,
        body: { content: { "application/json": { schema: RecordLeaving } } },
      },
      responses: { ...leavingResponses, 201: jsonBody(LeavingDetail, "Recorded") },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const detail = await leavingChange(c, A.leaving, id, async (tx, profile, access) => {
        const [existing] = await tx
          .select()
          .from(leaverRecord)
          .where(eq(leaverRecord.staffProfileId, id));
        const check = checkLeaving({
          startsOn: startOf(profile, A.leaving),
          leavingOn: body.leavingOn,
          alreadyLeaving: existing !== undefined,
          workerId: profile.tenantUserId,
          actorId: access.tenantUserId,
        });
        if (!check.ok)
          throw domainRefusal(
            A.leaving,
            id,
            check.problem,
            "The leaving cannot be recorded like that.",
          );
        const keep = await retainUntil(tx, access.tenantId, profile, body.leavingOn);
        await tx.insert(leaverRecord).values({
          staffProfileId: id,
          leavingOn: body.leavingOn,
          reason: body.reason,
          staffFileRetainUntil: keep,
        });
        await tx
          .update(staffProfile)
          .set({ leftOn: body.leavingOn })
          .where(eq(staffProfile.id, id));
        await auditFile(c, tx, access, A.leaving, id);
      });
      return c.json(detail, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/staff-files/{id}/leaving/items/{kind}",
      tags: ["workforce"],
      summary: "Tick a leaving item",
      description:
        "workforce.staff_file.manage, never on one's own file, in the caller's own name. Audited.",
      security,
      request: {
        params: LeaverItemParam,
        body: { content: { "application/json": { schema: TickItem } } },
      },
      responses: leavingResponses,
    }),
    async (c) => {
      const { id, kind } = c.req.valid("param");
      const body = c.req.valid("json");
      const detail = await leavingChange(c, A.leaverTicked, id, async (tx, _profile, access) => {
        if (body.doneOn > today()) {
          throw domainRefusal(
            A.leaverTicked,
            id,
            "date_in_future",
            "The date cannot be in the future.",
          );
        }
        await tx.insert(staffChecklistItem).values({
          staffProfileId: id,
          checklist: "leaving",
          kind,
          doneOn: body.doneOn,
          doneBy: access.tenantUserId,
        });
        await auditFile(c, tx, access, A.leaverTicked, id, { kind });
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/workforce/staff-files/{id}/leaving/exit-interview",
      tags: ["workforce"],
      summary: "Record the exit interview",
      description:
        "workforce.staff_file.manage, with expectedVersion: offered, declined, or held with its date and a summary (which the leaver may see). Audited without the summary.",
      security,
      request: {
        params: FileParam,
        body: { content: { "application/json": { schema: RecordExitInterview } } },
      },
      responses: leavingResponses,
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const detail = await leavingChange(c, A.exitInterview, id, async (tx, _profile, access) => {
        const [leaver] = await tx
          .select()
          .from(leaverRecord)
          .where(eq(leaverRecord.staffProfileId, id));
        if (!leaver) throw refused(problems.notFound(), A.exitInterview, id, "not_leaving");
        if (leaver.version !== body.expectedVersion) {
          throw refused(problems.conflict(), A.exitInterview, id, "version_conflict");
        }
        const check = checkExitInterview(
          leaver.exitInterview as ExitInterviewState,
          body.state,
          body.heldOn,
        );
        if (!check.ok || (body.state !== "held" && body.summary !== null)) {
          throw domainRefusal(
            A.exitInterview,
            id,
            check.ok ? "summary_not_allowed" : check.problem,
            "The exit interview cannot be recorded like that.",
          );
        }
        if (body.heldOn !== null && body.heldOn > today()) {
          throw domainRefusal(
            A.exitInterview,
            id,
            "date_in_future",
            "The date cannot be in the future.",
          );
        }
        const [updated] = await tx
          .update(leaverRecord)
          .set({
            exitInterview: body.state,
            exitInterviewOn: body.heldOn,
            exitInterviewSummary: body.summary,
          })
          .where(and(eq(leaverRecord.id, leaver.id), eq(leaverRecord.version, leaver.version)))
          .returning();
        if (!updated) throw refused(problems.conflict(), A.exitInterview, id, "version_conflict");
        await auditFile(c, tx, access, A.exitInterview, id, { state: body.state });
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/staff-files/{id}/leaving/end-access",
      tags: ["workforce"],
      summary: "End a leaver's access now",
      description:
        "workforce.staff_file.manage with step-up, never one's own: marks the member as left, ends their roles and revokes their grants at once (a dismissal, for example), instead of waiting for the day after the leaving date. A member who manages users, roles or grants, or holds a silo role, needs platform.user.manage too, and the last member who manages users keeps their access. Once only. Audited.",
      security,
      request: { params: FileParam },
      responses: leavingResponses,
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      // Ending someone's access at once is a step-up action (security review of slice 29).
      const stepUp = c.get("access");
      if (!stepUpFresh(stepUp)) throw stepUpRefusal(stepUp);
      const detail = await leavingChange(c, A.accessEnded, id, async (tx, _profile, access) => {
        const ended = await tx.execute<{ ended: boolean }>(
          sql`SELECT app.end_leaver_access(${id}::uuid) AS ended`,
        );
        if (!ended.rows[0]?.ended) {
          throw refused(
            new HttpProblem(409, "access_already_ended", "This member's access has already ended."),
            A.accessEnded,
            id,
            "already_ended",
          );
        }
        await auditFile(c, tx, access, A.accessEnded, id);
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/staff-files/{id}/references",
      tags: ["workforce"],
      summary: "Record a reference request",
      description:
        "workforce.staff_file.manage, never one's own: the organisation asking (never a person's name) and whether a factual or a conduct reference. Audited without the requester.",
      security,
      request: {
        params: FileParam,
        body: { content: { "application/json": { schema: RecordReferenceRequest } } },
      },
      responses: leavingResponses,
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const detail = await leavingChange(
        c,
        A.referenceRequested,
        id,
        async (tx, _profile, access) => {
          await tx.insert(referenceRequest).values({
            staffProfileId: id,
            requestedOn: body.requestedOn,
            requester: body.requester,
            kind: body.kind,
          });
          await auditFile(c, tx, access, A.referenceRequested, id, { kind: body.kind });
        },
      );
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/v1/workforce/staff-files/{id}/references/{referenceId}",
      tags: ["workforce"],
      summary: "Answer a reference request",
      description:
        "workforce.staff_file.manage, never one's own, with the request's expectedVersion: sent (in the caller's own name) or declined with a reason. Once only. Audited.",
      security,
      request: {
        params: ReferenceParam,
        body: { content: { "application/json": { schema: AnswerReferenceRequest } } },
      },
      responses: leavingResponses,
    }),
    async (c) => {
      const { id, referenceId } = c.req.valid("param");
      const body = c.req.valid("json");
      const detail = await leavingChange(
        c,
        A.referenceAnswered,
        id,
        async (tx, _profile, access) => {
          const [request] = await tx
            .select()
            .from(referenceRequest)
            .where(
              and(eq(referenceRequest.id, referenceId), eq(referenceRequest.staffProfileId, id)),
            );
          if (!request)
            throw refused(problems.notFound(), A.referenceAnswered, id, "reference_not_found");
          if (request.version !== body.expectedVersion) {
            throw refused(problems.conflict(), A.referenceAnswered, id, "version_conflict");
          }
          const sent = body.state === "sent";
          if (
            request.state !== "requested" ||
            sent !== (body.sentOn !== null) ||
            sent === (body.declinedReason !== null)
          ) {
            throw domainRefusal(
              A.referenceAnswered,
              id,
              "answer_invalid",
              "Give the date it was sent, or why it was declined.",
            );
          }
          await tx
            .update(referenceRequest)
            .set({
              state: body.state,
              sentOn: body.sentOn,
              sentBy: sent ? access.tenantUserId : null,
              declinedReason: body.declinedReason,
            })
            .where(
              and(
                eq(referenceRequest.id, referenceId),
                eq(referenceRequest.version, request.version),
              ),
            );
          await auditFile(c, tx, access, A.referenceAnswered, id, { state: body.state });
        },
      );
      return c.json(detail, 200);
    },
  );
