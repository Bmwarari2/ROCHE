import {
  RaiseSafeguardingConcern,
  SafeguardingDetail,
  SafeguardingList,
  SafeguardingMeasures,
  SafeguardingRaised,
  SafeguardingState,
  SafeguardingStep,
  UpdateSafeguardingConcern,
} from "@harbour/contracts";
import {
  incident,
  type SafeguardingConcernRow,
  safeguardingConcern,
  statutoryNotification,
  type Transaction,
  task,
} from "@harbour/db";
import {
  type EnquiryFinding,
  type MeasuresOutcome,
  OPEN_SAFEGUARDING_STATES,
  protectiveMeasuresFor,
  SAFEGUARDING_WORKFLOW,
  type SafeguardingRecordView,
  type StaffHarmAnswer,
  type SafeguardingState as State,
  safeguardingClock,
  safeguardingLogProblems,
  safeguardingReferralTarget,
  safeguardingStepProblems,
  staffRemovedForHarm,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, isNull, type SQL } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx } from "../http/audit";
import {
  type AppEnv,
  mfaRefusal,
  permissionsReaching,
  requirePermission,
  type TenantAccess,
  withTenant,
} from "../http/context";
import { problems } from "../http/problem";
import { publish } from "../outbox";
import { loadPerson } from "../services/people";
import { rateNumber } from "../services/rates";
import {
  acknowledgeSafeguardingAlerts,
  alertSafeguardingRaised,
  finishSafeguardingReferralTask,
  SAFEGUARDING_REFERRAL_RATE_KEY,
  stopRaisedEscalation,
  tellManagersNotReferred,
} from "../services/safeguarding";
import { startWorkflow } from "../services/workflow";
import { iso } from "./care-shared";
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
 * The safeguarding log (Phase 2 slice 13; SAFE-006; docs/specs/safety.md "Safeguarding log";
 * hazards HZ-126 and HZ-013). Anyone who may report an incident about the person may raise a
 * concern; the log itself needs `safety.safeguarding.manage`; staff caring for the person read only
 * the protective measures of open concerns. Reads and writes are audited by record id, never
 * content. The web screens are slice 62.
 */

const ConcernParam = z.object({ id: z.uuid() });
const PersonParam = z.object({ id: z.uuid() });
const ListQuery = z.object({
  state: SafeguardingState.optional(),
  personId: z.uuid().optional(),
});

/** Five minutes' leeway for a device clock (sync.clock_drift_flag_minutes is the tenant's). */
const FUTURE_LEEWAY_MS = 5 * 60_000;
const LIST_LIMIT = 500;

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

async function referralHours(tx: Transaction, tenantId: string): Promise<number> {
  return rateNumber(tx, tenantId, SAFEGUARDING_REFERRAL_RATE_KEY);
}

function recordView(row: SafeguardingConcernRow): SafeguardingRecordView {
  return {
    referral:
      row.referredAt && row.referralLocalAuthority && row.referralMethod
        ? {
            localAuthority: row.referralLocalAuthority,
            method: row.referralMethod as "phone" | "online_form" | "email" | "in_person",
            referredAt: row.referredAt,
            reference: row.referralReference,
          }
        : null,
    enquiry:
      row.enquiryKind && row.enquiryOpenedAt
        ? {
            kind: row.enquiryKind as "s42_local_authority" | "s42_caused_to_provider",
            openedAt: row.enquiryOpenedAt,
          }
        : null,
    finding: (row.finding as EnquiryFinding | null) ?? null,
    personalOutcomes:
      row.mspAsked === null
        ? null
        : {
            asked: row.mspAsked,
            notAskedReason: row.mspNotAskedReason,
            desiredOutcomes: row.mspDesiredOutcomes,
            achieved: (row.mspAchieved as "fully" | "partly" | "not" | null) ?? null,
          },
    staffRemovedForHarm: staffRemovedForHarm(row.staffHarm as StaffHarmAnswer | null),
    dbsReferral:
      row.dbsDecision && row.dbsDecidedAt
        ? {
            decision: row.dbsDecision as "referred" | "not_required",
            reason: row.dbsReason,
            at: row.dbsDecidedAt,
          }
        : null,
  };
}

function logFacts(row: SafeguardingConcernRow) {
  return {
    staffHarm: (row.staffHarm as StaffHarmAnswer | null) ?? null,
    mspAsked: row.mspAsked,
    mspNotAskedReason: row.mspNotAskedReason,
    mspDesiredOutcomes: row.mspDesiredOutcomes,
    protectiveMeasures: row.protectiveMeasures,
    measuresOutcome: (row.measuresOutcome as MeasuresOutcome | null) ?? null,
  };
}

/** What a step needs: the slice 7 rules and the log's own (HZ-126, review round 1). */
function stepNeeds(to: State, row: SafeguardingConcernRow): string[] {
  return [
    ...safeguardingStepProblems(to, recordView(row)),
    ...safeguardingLogProblems(to, logFacts(row)),
  ];
}

/** Blank measures are no measures (review round 1). */
function measuresText(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

function clockOf(row: SafeguardingConcernRow, now: Date, hours: number) {
  const clock = safeguardingClock(row.state as State, row.referralDueAt, now, {
    safeguardingReferralHours: hours,
  });
  return { status: clock.status, dueAt: clock.dueAt.toISOString(), wording: clock.wording };
}

async function detail(
  tx: Transaction,
  access: TenantAccess,
  row: SafeguardingConcernRow,
  now: Date,
): Promise<SafeguardingDetail> {
  const hours = await referralHours(tx, access.tenantId);
  const view = recordView(row);
  const [draft] = row.notificationId
    ? await tx
        .select({
          id: statutoryNotification.id,
          status: statutoryNotification.status,
          dueAt: statutoryNotification.dueAt,
        })
        .from(statutoryNotification)
        .where(eq(statutoryNotification.id, row.notificationId))
    : [];
  const state = row.state as State;
  const nextSteps = SAFEGUARDING_WORKFLOW.transitions
    .filter((t) => (Array.isArray(t.from) ? t.from.includes(state) : t.from === state))
    .map((t) => ({ to: t.to, needs: stepNeeds(t.to, row) }));
  const warnings: string[] = [];
  if (draft && state !== "concern" && (draft.status === "draft" || draft.status === "ready")) {
    warnings.push(
      "The s.42 notification draft is still open. Record it as submitted, with the local authority's reference, or as not required.",
    );
  }
  if (OPEN_SAFEGUARDING_STATES.includes(state) && !measuresText(row.protectiveMeasures)) {
    warnings.push(
      "No protective measures are recorded. Staff caring for the person see that none are recorded.",
    );
  }
  return {
    id: row.id,
    personId: row.personId,
    locationId: row.locationId,
    incidentId: row.incidentId,
    notification: draft
      ? {
          id: draft.id,
          status: draft.status as "draft" | "ready" | "submitted" | "not_required",
          dueAt: draft.dueAt.toISOString(),
        }
      : null,
    decisionGuideTaskId: row.decisionGuideTaskId,
    state,
    abuseTypes: row.abuseTypes as SafeguardingDetail["abuseTypes"],
    description: row.description,
    raisedAt: row.raisedAt.toISOString(),
    raisedByYou: row.raisedBy === access.tenantUserId,
    clock: clockOf(row, now, hours),
    noReferralReason: row.noReferralReason,
    referral: view.referral
      ? { ...view.referral, referredAt: view.referral.referredAt.toISOString() }
      : null,
    enquiry: view.enquiry
      ? { ...view.enquiry, openedAt: view.enquiry.openedAt.toISOString() }
      : null,
    finding: view.finding,
    personalOutcomes: view.personalOutcomes,
    staffHarm: (row.staffHarm as StaffHarmAnswer | null) ?? null,
    dbsReferral: view.dbsReferral
      ? { ...view.dbsReferral, at: view.dbsReferral.at.toISOString() }
      : null,
    protectiveMeasures: row.protectiveMeasures,
    protectiveMeasuresUpdatedAt: iso(row.protectiveMeasuresUpdatedAt),
    measuresOutcome: (row.measuresOutcome as MeasuresOutcome | null) ?? null,
    closedAt: iso(row.closedAt),
    closedReason: row.closedReason,
    nextSteps,
    warnings,
    version: row.version,
  };
}

async function loadConcern(tx: Transaction, id: string, forUpdate = false) {
  const query = tx
    .select()
    .from(safeguardingConcern)
    .where(and(eq(safeguardingConcern.id, id), isNull(safeguardingConcern.deletedAt)));
  const [row] = forUpdate ? await query.for("update") : await query;
  if (!row) throw problems.notFound();
  return row;
}

/**
 * Reads the concern, checks the manage permission reaches its person, and only then locks it for a
 * change (security review round 1, L4).
 */
async function concernToChange(tx: Transaction, access: TenantAccess, id: string) {
  const seen = await loadConcern(tx, id);
  await requireManageReach(tx, access, seen.personId);
  return loadConcern(tx, id, true);
}

/** The concern's person must be reached by the manage permission (scope per permission). */
async function requireManageReach(tx: Transaction, access: TenantAccess, personId: string) {
  if (!access.mfaSatisfied) throw mfaRefusal(access);
  const reach = await permissionsReaching(tx, access, personId);
  if (!reach.has("safety.safeguarding.manage")) throw problems.forbidden();
}

function notFuture(at: Date, now: Date, what: string) {
  if (at.getTime() > now.getTime() + FUTURE_LEEWAY_MS) {
    throw problems.invalid(`${what} cannot be in the future.`);
  }
}

const SUBJECT = (row: { id: string; personId: string }) => ({
  subjectType: "safeguarding_concern",
  subjectId: row.id,
  personId: row.personId,
});

export const safeguardingRouter = createRouter()
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/safeguarding/concerns",
      tags: ["safety"],
      summary: "Raise a safeguarding concern about a person (Care Act 2014 s.42)",
      description:
        "Anyone who may report an incident about the person may raise one. The referral clock starts at raisedAt (safeguarding.referral_hours, a tenant target; the law says without delay). A client id makes a replay return the same concern. From a Phase 1 safeguarding_s42 draft, the person, location and incident come from the draft.",
      security,
      request: {
        body: { content: { "application/json": { schema: RaiseSafeguardingConcern } } },
      },
      responses: {
        201: jsonBody(SafeguardingRaised, "Raised (or the earlier copy of a replay)"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "safety.incident.report");
      if (!access.mfaSatisfied) throw mfaRefusal(access);
      const body = c.req.valid("json");
      const now = new Date();
      const raised = await withTenant(c, async (tx) => {
        const person = await loadPerson(tx, body.personId);
        const reach = await permissionsReaching(tx, access, person.id);
        if (!reach.has("safety.incident.report")) throw problems.forbidden();
        // A replay is answered only once the caller reaches the person (security review round 1, L1).
        if (body.id) {
          const [replayed] = await tx
            .select()
            .from(safeguardingConcern)
            .where(and(eq(safeguardingConcern.id, body.id), isNull(safeguardingConcern.deletedAt)));
          if (replayed) {
            if (replayed.raisedBy !== access.tenantUserId || replayed.personId !== person.id) {
              throw problems.invalid("That id is already used.");
            }
            return replayed;
          }
        }
        const raisedAt = body.raisedAt ? new Date(body.raisedAt) : now;
        notFuture(raisedAt, now, "When the concern was raised");
        let locationId = person.locationId;
        let incidentId = body.incidentId ?? null;
        if (body.notificationId) {
          const [draft] = await tx
            .select()
            .from(statutoryNotification)
            .where(eq(statutoryNotification.id, body.notificationId));
          if (!draft) throw problems.notFound();
          if (draft.kind !== "safeguarding_s42") {
            throw problems.invalid("Only a safeguarding concern draft can open a concern.");
          }
          if (draft.personId && draft.personId !== person.id) {
            throw problems.invalid("The draft is about someone else.");
          }
          if (incidentId && draft.incidentId && incidentId !== draft.incidentId) {
            throw problems.invalid("The draft belongs to another incident.");
          }
          locationId = draft.locationId;
          incidentId = draft.incidentId ?? incidentId;
        }
        if (incidentId) {
          const [found] = await tx
            .select({ personIds: incident.personIds })
            .from(incident)
            .where(eq(incident.id, incidentId));
          if (!found) throw problems.notFound();
          if (!found.personIds.includes(person.id)) {
            throw problems.invalid("The person must be on the incident.");
          }
        }
        if (body.decisionGuideTaskId) {
          const [guide] = await tx
            .select({ kind: task.kind, personId: task.personId })
            .from(task)
            .where(eq(task.id, body.decisionGuideTaskId));
          if (!guide) throw problems.notFound();
          if (!guide.kind.endsWith("safeguarding_decision_guide") || guide.personId !== person.id) {
            throw problems.invalid("Link the safeguarding decision guide for this person.");
          }
        }
        const hours = await referralHours(tx, access.tenantId);
        const { dueAt } = safeguardingReferralTarget(raisedAt, {
          safeguardingReferralHours: hours,
        });
        const [row] = await tx
          .insert(safeguardingConcern)
          .values({
            ...(body.id ? { id: body.id } : {}),
            locationId,
            personId: person.id,
            incidentId,
            notificationId: body.notificationId ?? null,
            decisionGuideTaskId: body.decisionGuideTaskId ?? null,
            abuseTypes: [...new Set(body.abuseTypes)],
            description: body.description,
            raisedAt,
            raisedBy: access.tenantUserId,
            referralDueAt: dueAt,
            protectiveMeasures: measuresText(body.protectiveMeasures),
            protectiveMeasuresUpdatedAt: measuresText(body.protectiveMeasures) ? now : null,
          })
          .returning()
          .catch((error: unknown) => {
            if (dbCode(error) === "23505") {
              const constraint =
                (error as { constraint?: string }).constraint ??
                (error as { cause?: { constraint?: string } }).cause?.constraint;
              if (constraint === "safeguarding_concern_notification_key") {
                throw problems.conflict("A concern is already open from this draft.");
              }
              throw problems.invalid("That id is already used.");
            }
            throw error;
          });
        if (!row) throw problems.conflict();
        await startWorkflow(tx, access.tenantId, SAFEGUARDING_WORKFLOW, SUBJECT(row), now);
        await audit(c, tx, access, {
          action: "safety.safeguarding.raise",
          resourceType: "safeguarding_concern",
          resourceId: row.id,
          scope: { personId: row.personId, locationId: row.locationId },
        });
        // HZ-126: the managers at the person's home are told at once, with a task to decide.
        await alertSafeguardingRaised(tx, row, now);
        await publish(tx, {
          context: "safety",
          aggregateType: "safeguarding_concern",
          aggregateId: row.id,
          type: "safety.safeguarding.raised",
          payload: { concernId: row.id, personId: row.personId, locationId: row.locationId },
        });
        return row;
      });
      return c.json(
        {
          id: raised.id,
          state: raised.state as State,
          referralDueAt: raised.referralDueAt.toISOString(),
          version: raised.version,
        },
        201,
      );
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/safeguarding/concerns",
      tags: ["safety"],
      summary: "The safeguarding log in scope, open concerns first, with each referral clock",
      security,
      request: { query: ListQuery },
      responses: { 200: jsonBody(SafeguardingList, "The log"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, "safety.safeguarding.manage");
      if (!access.mfaSatisfied) throw mfaRefusal(access);
      const query = c.req.valid("query");
      const now = new Date();
      const list = await withTenant(c, async (tx) => {
        const where: SQL[] = [isNull(safeguardingConcern.deletedAt)];
        if (query.state) where.push(eq(safeguardingConcern.state, query.state));
        if (query.personId) where.push(eq(safeguardingConcern.personId, query.personId));
        const rows = await tx
          .select()
          .from(safeguardingConcern)
          .where(and(...where))
          .orderBy(desc(safeguardingConcern.raisedAt))
          .limit(LIST_LIMIT + 1);
        const hours = await referralHours(tx, access.tenantId);
        // Row-level security lets the raiser read their own concern whatever their scope; the log
        // shows only the people the manage permission reaches (ADR-0071; security review round 1, M1).
        const reached = new Map<string, boolean>();
        const shown: SafeguardingConcernRow[] = [];
        for (const r of rows.slice(0, LIST_LIMIT)) {
          if (r.raisedBy === access.tenantUserId) {
            if (!reached.has(r.personId)) {
              const reach = await permissionsReaching(tx, access, r.personId);
              reached.set(r.personId, reach.has("safety.safeguarding.manage"));
            }
            if (!reached.get(r.personId)) continue;
          }
          shown.push(r);
        }
        const open = (r: SafeguardingConcernRow) =>
          OPEN_SAFEGUARDING_STATES.includes(r.state as State) ? 0 : 1;
        shown.sort((x, y) => open(x) - open(y));
        await audit(c, tx, access, {
          action: "safety.safeguarding.list",
          resourceType: "safeguarding_concern",
        });
        return {
          concerns: shown.map((r) => ({
            id: r.id,
            personId: r.personId,
            locationId: r.locationId,
            state: r.state as State,
            abuseTypes: r.abuseTypes as SafeguardingDetail["abuseTypes"],
            raisedAt: r.raisedAt.toISOString(),
            clock: clockOf(r, now, hours),
            version: r.version,
          })),
          truncated: rows.length > LIST_LIMIT,
        };
      });
      return c.json(list, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/safeguarding/concerns/{id}",
      tags: ["safety"],
      summary:
        "One safeguarding concern, its clock, the linked draft and what each next step needs",
      security,
      request: { params: ConcernParam },
      responses: {
        200: jsonBody(SafeguardingDetail, "The concern"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "safety.safeguarding.manage");
      const { id } = c.req.valid("param");
      const now = new Date();
      const view = await withTenant(c, async (tx) => {
        const row = await loadConcern(tx, id);
        await requireManageReach(tx, access, row.personId);
        await audit(c, tx, access, {
          action: "safety.safeguarding.view",
          resourceType: "safeguarding_concern",
          resourceId: row.id,
        });
        // A manager other than the raiser has seen it: the raised alerts stop escalating.
        if (row.state === "concern" && row.raisedBy !== access.tenantUserId) {
          await stopRaisedEscalation(tx, row.id);
        }
        return detail(tx, access, row, now);
      });
      return c.json(view, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/safeguarding/concerns/{id}",
      tags: ["safety"],
      summary:
        "Record the referral, enquiry, finding, Making Safeguarding Personal, DBS decision and protective measures",
      description:
        "Expected version. A concern that is closed or not referred cannot be changed. The workflow moves through /step.",
      security,
      request: {
        params: ConcernParam,
        body: { content: { "application/json": { schema: UpdateSafeguardingConcern } } },
      },
      responses: {
        200: jsonBody(SafeguardingDetail, "Saved"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "safety.safeguarding.manage");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const view = await withTenant(c, async (tx) => {
        const row = await concernToChange(tx, access, id);
        if (row.version !== body.version) throw problems.conflict();
        if (row.state === "closed" || row.state === "no_referral") {
          throw problems.invalid("This concern has ended, so it cannot be changed.");
        }
        if (body.referral) notFuture(new Date(body.referral.referredAt), now, "The referral");
        if (body.enquiry) notFuture(new Date(body.enquiry.openedAt), now, "The enquiry");
        if (body.dbsReferral) notFuture(new Date(body.dbsReferral.at), now, "The DBS decision");
        if (body.referral && new Date(body.referral.referredAt) < row.raisedAt) {
          throw problems.invalid("The referral cannot be before the concern was raised.");
        }
        if (Object.keys(body).every((k) => k === "version")) {
          throw problems.invalid(
            "Nothing to change. What the concern says stays as it was raised.",
          );
        }
        const [saved] = await tx
          .update(safeguardingConcern)
          .set({
            ...(body.abuseTypes ? { abuseTypes: [...new Set(body.abuseTypes)] } : {}),
            ...(body.referral !== undefined
              ? {
                  referralLocalAuthority: body.referral?.localAuthority ?? null,
                  referralMethod: body.referral?.method ?? null,
                  referredAt: body.referral ? new Date(body.referral.referredAt) : null,
                  referralReference: body.referral?.reference ?? null,
                }
              : {}),
            ...(body.enquiry !== undefined
              ? {
                  enquiryKind: body.enquiry?.kind ?? null,
                  enquiryOpenedAt: body.enquiry ? new Date(body.enquiry.openedAt) : null,
                }
              : {}),
            ...(body.finding !== undefined
              ? { finding: body.finding, findingRecordedAt: body.finding ? now : null }
              : {}),
            ...(body.personalOutcomes !== undefined
              ? {
                  mspAsked: body.personalOutcomes?.asked ?? null,
                  mspNotAskedReason: body.personalOutcomes?.notAskedReason ?? null,
                  mspDesiredOutcomes: body.personalOutcomes?.desiredOutcomes ?? null,
                  mspAchieved: body.personalOutcomes?.achieved ?? null,
                }
              : {}),
            ...(body.staffHarm !== undefined ? { staffHarm: body.staffHarm } : {}),
            ...(body.dbsReferral !== undefined
              ? {
                  dbsDecision: body.dbsReferral?.decision ?? null,
                  dbsReason: body.dbsReferral?.reason ?? null,
                  dbsDecidedAt: body.dbsReferral ? new Date(body.dbsReferral.at) : null,
                }
              : {}),
            ...(body.protectiveMeasures !== undefined
              ? {
                  protectiveMeasures: measuresText(body.protectiveMeasures),
                  protectiveMeasuresUpdatedAt: measuresText(body.protectiveMeasures) ? now : null,
                }
              : {}),
            // Changed measures need their outcome answered again, unless this update answers it
            // (HZ-126 rule 3: an answer about the old measures never closes the new ones).
            ...(body.measuresOutcome !== undefined
              ? { measuresOutcome: body.measuresOutcome }
              : body.protectiveMeasures !== undefined &&
                  measuresText(body.protectiveMeasures) !== row.protectiveMeasures
                ? { measuresOutcome: null }
                : {}),
          })
          .where(
            and(eq(safeguardingConcern.id, row.id), eq(safeguardingConcern.version, row.version)),
          )
          .returning()
          .catch((error: unknown) => {
            if (dbCode(error) === "23514") {
              throw problems.invalid("Some details do not fit together. Check them and try again.");
            }
            throw error;
          });
        if (!saved) throw problems.conflict();
        await audit(c, tx, access, {
          action: "safety.safeguarding.update",
          resourceType: "safeguarding_concern",
          resourceId: saved.id,
          scope: { fields: Object.keys(body).filter((k) => k !== "version") },
        });
        return detail(tx, access, saved, now);
      });
      return c.json(view, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/safeguarding/concerns/{id}/step",
      tags: ["safety"],
      summary: "Move the concern (safeguardingStepProblems says what each step needs)",
      description:
        "Not referring and closing need a reason. Referring or deciding not to refer stops the overdue alerts.",
      security,
      request: {
        params: ConcernParam,
        body: { content: { "application/json": { schema: SafeguardingStep } } },
      },
      responses: {
        200: jsonBody(SafeguardingDetail, "Moved"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "safety.safeguarding.manage");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const view = await withTenant(c, async (tx) => {
        const row = await concernToChange(tx, access, id);
        if (row.version !== body.version) throw problems.conflict();
        const to = body.to as State;
        const reason = body.reason?.trim() || null;
        if ((to === "no_referral" || to === "closed") && (!reason || reason.length < 10)) {
          throw problems.invalid(
            to === "no_referral"
              ? "Say why the concern is not referred, in 10 characters or more."
              : "Say why the concern can close, in 10 characters or more.",
          );
        }
        const needs = stepNeeds(to, row);
        if (needs.length > 0) throw problems.invalid(needs.join(" "));
        await moveOrRefuse(c, tx, SAFEGUARDING_WORKFLOW, SUBJECT(row), to, reason, now);
        const [saved] = await tx
          .update(safeguardingConcern)
          .set({
            state: to,
            ...(to === "no_referral"
              ? { noReferralReason: reason, noReferralDecidedBy: access.tenantUserId }
              : {}),
            ...(to === "closed"
              ? { closedAt: now, closedBy: access.tenantUserId, closedReason: reason }
              : {}),
          })
          .where(
            and(eq(safeguardingConcern.id, row.id), eq(safeguardingConcern.version, row.version)),
          )
          .returning();
        if (!saved) throw problems.conflict();
        if (to === "referred" || to === "no_referral") {
          await acknowledgeSafeguardingAlerts(tx, saved.id, now);
          await finishSafeguardingReferralTask(tx, saved.id, now, to, access.tenantUserId);
        }
        // A decision not to refer is never one person's alone and unseen: the other managers of
        // the log at the person's home are told (clinical review round 1; a second person: H-599).
        if (to === "no_referral")
          await tellManagersNotReferred(tx, saved, access.tenantUserId, now);
        await audit(c, tx, access, {
          action: `safety.safeguarding.${to}`,
          resourceType: "safeguarding_concern",
          resourceId: saved.id,
        });
        await publish(tx, {
          context: "safety",
          aggregateType: "safeguarding_concern",
          aggregateId: saved.id,
          type: "safety.safeguarding.moved",
          payload: { concernId: saved.id, from: row.state, to },
        });
        return detail(tx, access, saved, now);
      });
      return c.json(view, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/safeguarding/measures",
      tags: ["safety"],
      summary: "The protective measures of the person's open safeguarding concerns (HZ-126)",
      description:
        "For staff caring for the person: the measures only, never the allegation or who raised it. Open concerns with no measures recorded are counted.",
      security,
      request: { params: PersonParam },
      responses: {
        200: jsonBody(SafeguardingMeasures, "The measures"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "care.plan.read");
      const { id } = c.req.valid("param");
      const view = await withTenant(c, async (tx) => {
        const person = await loadPerson(tx, id);
        const rows = await tx
          .select({
            state: safeguardingConcern.state,
            protectiveMeasures: safeguardingConcern.protectiveMeasures,
            protectiveMeasuresUpdatedAt: safeguardingConcern.protectiveMeasuresUpdatedAt,
          })
          .from(safeguardingConcern)
          .where(
            and(eq(safeguardingConcern.personId, person.id), isNull(safeguardingConcern.deletedAt)),
          );
        const result = protectiveMeasuresFor(rows.map((r) => ({ ...r, state: r.state as State })));
        await audit(c, tx, access, {
          action: "safety.safeguarding.measures_view",
          resourceType: "person",
          resourceId: person.id,
        });
        return {
          measures: result.measures.map((m) => ({
            text: m.text,
            updatedAt: m.updatedAt.toISOString(),
          })),
          openWithoutMeasures: result.openWithoutMeasures,
        };
      });
      return c.json(view, 200);
    },
  );
