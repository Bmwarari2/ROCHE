import {
  CreateCompetenceSignOff,
  CreateSupervisionRecord,
  CreateTrainingRecord,
  DevelopmentRecord,
  PutRevalidationEvidence,
  PutTrainingRequirement,
  TrainingMatrix,
  TrainingMatrixQuery,
  TrainingRequirementItem,
  TrainingRequirementList,
  UpdateTrainingRecord,
  WithdrawCompetenceSignOff,
} from "@harbour/contracts";
import {
  competenceSignOff,
  competenceWithdrawal,
  revalidationEvidence,
  supervisionNote,
  supervisionRecord,
  type Transaction,
  trainingRecord,
  trainingRequirement,
} from "@harbour/db";
import { competenceRefreshMonths, competenceValidUntil, ukIsoDate } from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq } from "drizzle-orm";
import type { Context } from "hono";
import { AuditedRefusal, withAuditedRefusal, writeAudit } from "../http/audit";
import {
  type AppEnv,
  requireAnyPermission,
  requirePermission,
  type TenantAccess,
  withTenant,
} from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { publish } from "../outbox";
import {
  developmentRecord,
  endDevelopmentReminders,
  memberNation,
  trainingMatrixFor,
} from "../services/development";
import { workforceRates } from "../services/staff-files";
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
 * Training, observed competence, supervision and revalidation (workforce.md sections 2b, 3 and 5;
 * WORK-005, WORK-008, WORK-009, WORK-012; ADR-0085; hazards HZ-119 and HZ-124). Read
 * organisation-wide by holders of the workforce read permissions and by the member for their own;
 * never written by the member about themselves; a sign-off is in the observer's own name. The
 * database enforces the same (migration 0079). Audit events and outbox payloads carry opaque ids
 * and codes only.
 */

const TRAINING = "workforce.training.manage";
const OBSERVE = "workforce.competence.observe";
const SUPERVISION = "workforce.supervision.manage";
const STAFF_FILE_READ = "workforce.staff_file.read";
const SELF = "workforce.self.read";
const SOURCE = "development";
const A = {
  viewed: "workforce.development.viewed",
  matrix: "workforce.training_matrix.viewed",
  requirement: "workforce.training_requirement.saved",
  trained: "workforce.training.recorded",
  corrected: "workforce.training.corrected",
  signedOff: "workforce.competence.signed_off",
  withdrawn: "workforce.competence.withdrawn",
  supervised: "workforce.supervision.recorded",
  revalidation: "workforce.revalidation.recorded",
} as const;

const MemberParam = z.object({ memberId: z.uuid() });
const RecordParam = z.object({ memberId: z.uuid(), recordId: z.uuid() });
const SignOffParam = z.object({ memberId: z.uuid(), signOffId: z.uuid() });

const refused = (problem: HttpProblem, action: string, id: string | null, reason: string) =>
  new AuditedRefusal(problem, {
    action,
    outcome: "denied",
    resourceType: SOURCE,
    ...(id ? { resourceId: id } : {}),
    reason,
  });

const own = (action: string, memberId: string) =>
  refused(
    new HttpProblem(403, "own_development_record", "Someone else records this for you."),
    action,
    memberId,
    "own_record",
  );

/** Runs a change; refusals and the database's own (403, 409, 422) are audited. */
async function change<T>(
  c: Context<AppEnv>,
  access: TenantAccess,
  action: string,
  id: string | null,
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
      resourceType: SOURCE,
      ...(id ? { resourceId: id } : {}),
      reason: code === "42501" ? "refused_by_database" : `invalid_${code}`,
      requestId: c.get("requestId"),
    });
    if (code === "42501") throw problems.forbidden();
    if (code === "23505") throw problems.conflict("That is already recorded.");
    if (code === "23503") throw problems.notFound();
    throw problems.invalid(
      "Those details cannot be saved together. Check the dates and try again.",
    );
  }
}

const notFuture = (on: string, action: string, id: string) => {
  if (on > ukIsoDate(new Date())) {
    throw refused(
      problems.invalid("Use today's date or an earlier one."),
      action,
      id,
      "future_date",
    );
  }
};

async function recordFor(c: Context<AppEnv>, access: TenantAccess, memberId: string) {
  const record = await withTenant(c, (tx) =>
    developmentRecord(tx, access.tenantId, memberId, new Date()),
  );
  if (!record) throw problems.notFound();
  return record;
}

const requirementItem = (r: typeof trainingRequirement.$inferSelect) =>
  TrainingRequirementItem.parse({
    id: r.id,
    version: r.version,
    roleKey: r.roleKey,
    topic: r.topic,
    refreshYears: r.refreshYears,
    tier: r.tier,
    active: r.active,
  });

const developmentResponses = {
  200: jsonBody(DevelopmentRecord, "The member's development record"),
  ...errorResponses,
  ...notFoundResponse,
  ...conflictResponse,
};

export const developmentRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/workforce/training-requirements",
      tags: ["workforce"],
      summary: "The training matrix by role",
      description: "workforce.training.manage. Every requirement, by role and topic.",
      security,
      responses: { 200: jsonBody(TrainingRequirementList, "Requirements"), ...errorResponses },
    }),
    async (c) => {
      await requirePermission(c, TRAINING);
      const rows = await withTenant(c, (tx) =>
        tx
          .select()
          .from(trainingRequirement)
          .orderBy(asc(trainingRequirement.roleKey), asc(trainingRequirement.topic)),
      );
      return c.json({ items: rows.map(requirementItem) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/workforce/training-matrix",
      tags: ["workforce"],
      summary: "The organisation's training matrix",
      description:
        "workforce.training.manage, .competence.observe, .supervision.manage or .staff_file.read. Every member of staff whose roles need training, by name and job title, with each required topic's state today (valid, due soon, expired or missing), by the rules of the member's record. Filter by location (roles held there), role key, or attention (only members with a topic not valid). At most 2,000 members; truncated says when more match. Audited without names.",
      security,
      request: { query: TrainingMatrixQuery },
      responses: { 200: jsonBody(TrainingMatrix, "The matrix"), ...errorResponses },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [
        TRAINING,
        OBSERVE,
        SUPERVISION,
        STAFF_FILE_READ,
      ]);
      const query = c.req.valid("query");
      const matrix = await withTenant(c, async (tx) => {
        const found = await trainingMatrixFor(tx, access.tenantId, new Date(), {
          ...(query.locationId ? { locationId: query.locationId } : {}),
          ...(query.roleKey ? { roleKey: query.roleKey } : {}),
          attention: query.attention === "true",
        });
        if (!found) throw problems.forbidden();
        await audit(c, tx, access, {
          action: A.matrix,
          resourceType: SOURCE,
          scopeExtra: {
            locationId: query.locationId ?? null,
            roleKey: query.roleKey ?? null,
            members: found.members.length,
          },
        });
        return found;
      });
      return c.json(matrix, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/workforce/training-requirements",
      tags: ["workforce"],
      summary: "Set one role's requirement for a topic",
      description:
        "workforce.training.manage. Adds or changes one role and topic's requirement (expectedVersion when it exists). The Oliver McGowan topic needs its tier; others never have one. Audited.",
      security,
      request: { body: { content: { "application/json": { schema: PutTrainingRequirement } } } },
      responses: {
        200: jsonBody(TrainingRequirementItem, "Saved"),
        ...errorResponses,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, TRAINING);
      const body = c.req.valid("json");
      const row = await change(c, access, A.requirement, null, async (tx) => {
        const [existing] = await tx
          .select()
          .from(trainingRequirement)
          .where(
            and(
              eq(trainingRequirement.roleKey, body.roleKey),
              eq(trainingRequirement.topic, body.topic),
            ),
          );
        const values = {
          refreshYears: body.refreshYears,
          tier: body.tier,
          active: body.active,
        };
        let saved: typeof trainingRequirement.$inferSelect | undefined;
        if (existing) {
          if (body.expectedVersion !== existing.version) {
            throw refused(problems.conflict(), A.requirement, existing.id, "version_conflict");
          }
          [saved] = await tx
            .update(trainingRequirement)
            .set(values)
            .where(
              and(
                eq(trainingRequirement.id, existing.id),
                eq(trainingRequirement.version, existing.version),
              ),
            )
            .returning();
        } else {
          [saved] = await tx
            .insert(trainingRequirement)
            .values({ roleKey: body.roleKey, topic: body.topic, ...values })
            .returning();
        }
        if (!saved) throw refused(problems.conflict(), A.requirement, null, "version_conflict");
        await audit(c, tx, access, {
          action: A.requirement,
          resourceType: "training_requirement",
          resourceId: saved.id,
          scopeExtra: { roleKey: saved.roleKey, topic: saved.topic },
        });
        return saved;
      });
      return c.json(requirementItem(row), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/workforce/members/{memberId}/development",
      tags: ["workforce"],
      summary: "A member's development record",
      description:
        "workforce.training.manage, .competence.observe, .supervision.manage or .staff_file.read. The training matrix today (Oliver McGowan tiers in England), records, competences and their state, supervisions with the next supervision and appraisal, and the revalidation plan. Audited.",
      security,
      request: { params: MemberParam },
      responses: developmentResponses,
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [
        TRAINING,
        OBSERVE,
        SUPERVISION,
        STAFF_FILE_READ,
      ]);
      const { memberId } = c.req.valid("param");
      const record = await recordFor(c, access, memberId);
      await writeAudit(c.get("services").appPool, access, {
        action: A.viewed,
        resourceType: SOURCE,
        resourceId: memberId,
        requestId: c.get("requestId"),
      });
      return c.json(record, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/members/{memberId}/training-records",
      tags: ["workforce"],
      summary: "Record training",
      description:
        "workforce.training.manage, never for oneself. Completed on a date no later than today. Audited.",
      security,
      request: {
        params: MemberParam,
        body: { content: { "application/json": { schema: CreateTrainingRecord } } },
      },
      responses: developmentResponses,
    }),
    async (c) => {
      const access = await requirePermission(c, TRAINING);
      const { memberId } = c.req.valid("param");
      const body = c.req.valid("json");
      await change(c, access, A.trained, memberId, async (tx) => {
        if (memberId === access.tenantUserId) throw own(A.trained, memberId);
        notFuture(body.completedOn, A.trained, memberId);
        const [row] = await tx
          .insert(trainingRecord)
          .values({ workerId: memberId, ...body })
          .returning({ id: trainingRecord.id });
        await endDevelopmentReminders(tx, memberId, { trainingTopic: body.topic });
        await audit(c, tx, access, {
          action: A.trained,
          resourceType: "training_record",
          resourceId: row?.id ?? memberId,
          scopeExtra: { memberId, topic: body.topic },
        });
      });
      return c.json(await recordFor(c, access, memberId), 200);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/v1/workforce/members/{memberId}/training-records/{recordId}",
      tags: ["workforce"],
      summary: "Correct a training record",
      description:
        "workforce.training.manage, never for oneself, against the version you loaded; the earlier version is kept. Audited.",
      security,
      request: {
        params: RecordParam,
        body: { content: { "application/json": { schema: UpdateTrainingRecord } } },
      },
      responses: developmentResponses,
    }),
    async (c) => {
      const access = await requirePermission(c, TRAINING);
      const { memberId, recordId } = c.req.valid("param");
      const { expectedVersion, ...body } = c.req.valid("json");
      await change(c, access, A.corrected, recordId, async (tx) => {
        if (memberId === access.tenantUserId) throw own(A.corrected, memberId);
        notFuture(body.completedOn, A.corrected, recordId);
        const [found] = await tx
          .select({ version: trainingRecord.version })
          .from(trainingRecord)
          .where(and(eq(trainingRecord.id, recordId), eq(trainingRecord.workerId, memberId)));
        if (!found) throw refused(problems.notFound(), A.corrected, recordId, "not_found");
        const [row] = await tx
          .update(trainingRecord)
          .set(body)
          .where(and(eq(trainingRecord.id, recordId), eq(trainingRecord.version, expectedVersion)))
          .returning({ id: trainingRecord.id });
        if (!row) throw refused(problems.conflict(), A.corrected, recordId, "version_conflict");
        await audit(c, tx, access, {
          action: A.corrected,
          resourceType: "training_record",
          resourceId: recordId,
          scopeExtra: { memberId },
        });
      });
      return c.json(await recordFor(c, access, memberId), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/members/{memberId}/competences",
      tags: ["workforce"],
      summary: "Sign off an observed competence",
      description:
        "workforce.competence.observe, in the caller's own name, never for oneself, observed on a date no later than today. Valid until the day before the competence's refresh (competence.medicines.refresh_months or competence.default_refresh_months). Publishes workforce.competence.changed. Audited (HZ-119).",
      security,
      request: {
        params: MemberParam,
        body: { content: { "application/json": { schema: CreateCompetenceSignOff } } },
      },
      responses: developmentResponses,
    }),
    async (c) => {
      const access = await requirePermission(c, OBSERVE);
      const { memberId } = c.req.valid("param");
      const body = c.req.valid("json");
      await change(c, access, A.signedOff, memberId, async (tx) => {
        if (memberId === access.tenantUserId) throw own(A.signedOff, memberId);
        notFuture(body.observedOn, A.signedOff, memberId);
        // The member's own nation's figures (clinical safety review round 1, finding 4).
        const nation = await memberNation(tx, memberId, new Date());
        const rates = await workforceRates(tx, access.tenantId, nation, body.observedOn);
        const validUntil = competenceValidUntil(
          body.observedOn,
          competenceRefreshMonths(body.competence, rates),
        );
        const [row] = await tx
          .insert(competenceSignOff)
          .values({
            workerId: memberId,
            competence: body.competence,
            observedOn: body.observedOn,
            observerId: access.tenantUserId,
            validUntil,
          })
          .returning({ id: competenceSignOff.id });
        if (!row) throw new Error("sign-off not stored");
        await audit(c, tx, access, {
          action: A.signedOff,
          resourceType: "competence_sign_off",
          resourceId: row.id,
          scopeExtra: { memberId, competence: body.competence },
        });
        await endDevelopmentReminders(tx, memberId, { competence: body.competence });
        await publish(tx, {
          context: "workforce",
          aggregateType: "competence_sign_off",
          aggregateId: row.id,
          type: "workforce.competence.changed",
          payload: { memberId, competence: body.competence, change: "signed_off", validUntil },
        });
      });
      return c.json(await recordFor(c, access, memberId), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/members/{memberId}/competences/{signOffId}/withdraw",
      tags: ["workforce"],
      summary: "Withdraw a competence sign-off",
      description:
        "workforce.competence.observe or workforce.training.manage, never for oneself, with a reason. From the day it is withdrawn the sign-off no longer counts. Publishes workforce.competence.changed. Audited (HZ-119).",
      security,
      request: {
        params: SignOffParam,
        body: { content: { "application/json": { schema: WithdrawCompetenceSignOff } } },
      },
      responses: developmentResponses,
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [OBSERVE, TRAINING]);
      const { memberId, signOffId } = c.req.valid("param");
      const body = c.req.valid("json");
      await change(c, access, A.withdrawn, signOffId, async (tx) => {
        if (memberId === access.tenantUserId) throw own(A.withdrawn, memberId);
        const [found] = await tx
          .select({ competence: competenceSignOff.competence })
          .from(competenceSignOff)
          .where(
            and(eq(competenceSignOff.id, signOffId), eq(competenceSignOff.workerId, memberId)),
          );
        if (!found) throw refused(problems.notFound(), A.withdrawn, signOffId, "not_found");
        await tx
          .insert(competenceWithdrawal)
          .values({ signOffId, reason: body.reason, withdrawnBy: access.tenantUserId });
        await audit(c, tx, access, {
          action: A.withdrawn,
          resourceType: "competence_sign_off",
          resourceId: signOffId,
          scopeExtra: { memberId, competence: found.competence },
        });
        await publish(tx, {
          context: "workforce",
          aggregateType: "competence_sign_off",
          aggregateId: signOffId,
          type: "workforce.competence.changed",
          payload: {
            memberId,
            competence: found.competence,
            change: "withdrawn",
            validUntil: null,
          },
        });
      });
      return c.json(await recordFor(c, access, memberId), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/members/{memberId}/supervisions",
      tags: ["workforce"],
      summary: "Record a supervision, appraisal or spot check",
      description:
        "workforce.supervision.manage, held by the caller, never for oneself, on a date no later than today. An optional note (what was discussed and the actions agreed; H-692's default, ADR-0114) is read only by supervision holders and the member. Audited without the note.",
      security,
      request: {
        params: MemberParam,
        body: { content: { "application/json": { schema: CreateSupervisionRecord } } },
      },
      responses: developmentResponses,
    }),
    async (c) => {
      const access = await requirePermission(c, SUPERVISION);
      const { memberId } = c.req.valid("param");
      const body = c.req.valid("json");
      await change(c, access, A.supervised, memberId, async (tx) => {
        if (memberId === access.tenantUserId) throw own(A.supervised, memberId);
        notFuture(body.heldOn, A.supervised, memberId);
        const [row] = await tx
          .insert(supervisionRecord)
          .values({
            workerId: memberId,
            kind: body.kind,
            heldOn: body.heldOn,
            heldBy: access.tenantUserId,
          })
          .returning({ id: supervisionRecord.id });
        if (row && body.note) {
          await tx.insert(supervisionNote).values({
            supervisionId: row.id,
            workerId: memberId,
            discussion: body.note.discussion,
            actions: body.note.actions,
            writtenBy: access.tenantUserId,
          });
        }
        await audit(c, tx, access, {
          action: A.supervised,
          resourceType: "supervision_record",
          resourceId: row?.id ?? memberId,
          // Whether a note was written, never what it says.
          scopeExtra: { memberId, kind: body.kind, note: body.note !== null },
        });
      });
      return c.json(await recordFor(c, access, memberId), 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/workforce/members/{memberId}/revalidation",
      tags: ["workforce"],
      summary: "Record revalidation evidence for a cycle",
      description:
        "workforce.training.manage, never for oneself. One record per member and revalidation date (expectedVersion when it exists); counted against the NMC figures in the rate table. Audited.",
      security,
      request: {
        params: MemberParam,
        body: { content: { "application/json": { schema: PutRevalidationEvidence } } },
      },
      responses: developmentResponses,
    }),
    async (c) => {
      const access = await requirePermission(c, TRAINING);
      const { memberId } = c.req.valid("param");
      const { expectedVersion, ...body } = c.req.valid("json");
      await change(c, access, A.revalidation, memberId, async (tx) => {
        if (memberId === access.tenantUserId) throw own(A.revalidation, memberId);
        const [existing] = await tx
          .select({ id: revalidationEvidence.id, version: revalidationEvidence.version })
          .from(revalidationEvidence)
          .where(
            and(
              eq(revalidationEvidence.workerId, memberId),
              eq(revalidationEvidence.cycleDueOn, body.cycleDueOn),
            ),
          );
        let id: string | undefined;
        if (existing) {
          if (expectedVersion !== existing.version) {
            throw refused(problems.conflict(), A.revalidation, existing.id, "version_conflict");
          }
          const [row] = await tx
            .update(revalidationEvidence)
            .set(body)
            .where(
              and(
                eq(revalidationEvidence.id, existing.id),
                eq(revalidationEvidence.version, existing.version),
              ),
            )
            .returning({ id: revalidationEvidence.id });
          id = row?.id;
        } else {
          const [row] = await tx
            .insert(revalidationEvidence)
            .values({ workerId: memberId, ...body })
            .returning({ id: revalidationEvidence.id });
          id = row?.id;
        }
        if (!id) throw refused(problems.conflict(), A.revalidation, memberId, "version_conflict");
        await audit(c, tx, access, {
          action: A.revalidation,
          resourceType: "revalidation_evidence",
          resourceId: id,
          scopeExtra: { memberId },
        });
      });
      return c.json(await recordFor(c, access, memberId), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/me/development",
      tags: ["workforce"],
      summary: "My development record",
      description:
        "workforce.self.read. The member's own training, competences, supervisions and revalidation.",
      security,
      responses: { 200: jsonBody(DevelopmentRecord, "Your development record"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, SELF);
      const record = await recordFor(c, access, access.tenantUserId);
      await writeAudit(c.get("services").appPool, access, {
        action: A.viewed,
        resourceType: SOURCE,
        resourceId: access.tenantUserId,
        requestId: c.get("requestId"),
      });
      return c.json(record, 200);
    },
  );
