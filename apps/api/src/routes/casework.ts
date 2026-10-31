import {
  AddCaseNote,
  ArrangeHearing,
  CaseDetail,
  type CaseHearing,
  CaseList,
  type CaseMember,
  type CaseSummary,
  ChangeSuspension,
  LinkSafeguarding,
  MoveCase,
  NameCaseMember,
  OpenCase,
  RecordReferral,
  RemoveCaseMember,
  UpdateHearing,
} from "@harbour/contracts";
import {
  employeeCase,
  employeeCaseEvent,
  employeeCaseHearing,
  employeeCaseMember,
  type Transaction,
} from "@harbour/db";
import {
  type ActiveMember,
  type AppealOutcome,
  type CaseClosingReason,
  type CaseFacts,
  type CaseMemberRole,
  type CaseMove,
  type CaseOutcome,
  type CaseStage,
  type CaseType,
  caseTimeline,
  checkCaseMove,
  checkHearingChange,
  checkHearingInvitation,
  checkMemberAppointment,
  checkMemberRemoval,
  checkReferralDecision,
  checkSuspension,
  type HearingState,
  type ReferralDecision,
  referralDecisionsDue,
  suspensionReviewOverdue,
  ukIsoDate,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Context } from "hono";
import { AuditedRefusal, withAuditedRefusal, writeAudit } from "../http/audit";
import {
  type AppEnv,
  mfaRefusal,
  requirePermission,
  type TenantAccess,
  withTenant,
} from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { staffNames } from "../services/staff";
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
 * Employee relations casework (workforce.md section 2c, rules 15 to 18 and section 5; WORK-010;
 * plan slice 39). A restricted silo (ADR-0089): only the members named on a case read it or act
 * on it, whatever else they hold; the database enforces the same (migration 0101), so a case the
 * caller is not named on is simply not found. Opening one needs the silo permission
 * workforce.casework.manage. Every route needs MFA: cases hold health and allegations of criminal
 * conduct. Audit events carry opaque ids and codes only: never the member of staff, the summary,
 * the grounds, notes or outcomes' reasons.
 */

const OPEN = "workforce.casework.manage";
const A = {
  opened: "workforce.case.opened",
  viewed: "workforce.case.viewed",
  listed: "workforce.case.listed",
  memberNamed: "workforce.case.member_named",
  memberRemoved: "workforce.case.member_removed",
  moved: "workforce.case.moved",
  hearingArranged: "workforce.case.hearing_arranged",
  hearingUpdated: "workforce.case.hearing_updated",
  suspension: "workforce.case.suspension",
  referral: "workforce.case.referral_recorded",
  safeguarding: "workforce.case.safeguarding_linked",
  note: "workforce.case.note_added",
} as const;

const IdParam = z.object({ id: z.uuid() });
const MemberParam = z.object({ id: z.uuid(), memberId: z.uuid() });
const HearingParam = z.object({ id: z.uuid(), hearingId: z.uuid() });

type CaseRow = typeof employeeCase.$inferSelect;
type MemberRow = typeof employeeCaseMember.$inferSelect;
type HearingRow = typeof employeeCaseHearing.$inferSelect;

const refused = (problem: HttpProblem, action: string, id: string, reason: string) =>
  new AuditedRefusal(problem, {
    action,
    outcome: "denied",
    resourceType: "employee_case",
    resourceId: id,
    reason,
  });

/** A case member's request: MFA always (special category data), whatever their roles. */
function memberAccess(c: Context<AppEnv>): TenantAccess {
  const access = c.get("access");
  if (!access.mfaSatisfied) throw mfaRefusal(access);
  return access;
}

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
    if (code === "23505")
      throw new HttpProblem(409, "already_recorded", "This is already recorded.");
    if (code === "23503") throw problems.invalid("Choose members of this organisation.");
    throw problems.invalid("Those details cannot be saved together. Check them and try again.");
  }
}

const today = () => ukIsoDate(new Date());

const activeMembers = (rows: readonly MemberRow[]): ActiveMember[] =>
  rows
    .filter((m) => m.removedAt === null)
    .map((m) => ({ tenantUserId: m.tenantUserId, role: m.memberRole as CaseMemberRole }));

/** The case (only found by its members), its members and the caller's own roles on it. */
async function loadCase(tx: Transaction, access: TenantAccess, action: string, id: string) {
  const [row] = await tx
    .select()
    .from(employeeCase)
    .where(and(eq(employeeCase.id, id), isNull(employeeCase.deletedAt)));
  if (!row) throw refused(problems.notFound(), action, id, "not_found");
  const members = await tx
    .select()
    .from(employeeCaseMember)
    .where(eq(employeeCaseMember.caseId, id))
    .orderBy(asc(employeeCaseMember.createdAt), asc(employeeCaseMember.id));
  const myRoles = activeMembers(members)
    .filter((m) => m.tenantUserId === access.tenantUserId)
    .map((m) => m.role);
  return { row, members, myRoles };
}

type Loaded = Awaited<ReturnType<typeof loadCase>>;

function requireRole(loaded: Loaded, action: string, roles: readonly CaseMemberRole[]) {
  if (!loaded.myRoles.some((r) => roles.includes(r))) {
    throw refused(problems.forbidden(), action, loaded.row.id, "case_role_required");
  }
}

function requireVersion(row: CaseRow, action: string, expected: number) {
  if (row.version !== expected)
    throw refused(problems.conflict(), action, row.id, "version_conflict");
}

async function factsOf(tx: Transaction, row: CaseRow): Promise<CaseFacts> {
  const hearings = await tx
    .select({ kind: employeeCaseHearing.kind, state: employeeCaseHearing.state })
    .from(employeeCaseHearing)
    .where(eq(employeeCaseHearing.caseId, row.id));
  const count = (kind: string, state: string) =>
    hearings.filter((h) => h.kind === kind && h.state === state).length;
  return {
    type: row.caseType as CaseType,
    stage: row.stage as CaseStage,
    hearingsHeld: count("hearing", "held"),
    hearingsNotAttended: count("hearing", "not_attended"),
    appealHearingsHeld: count("appeal_hearing", "held"),
    suspended: row.suspendedOn !== null,
    outcome: (row.outcome ?? null) as CaseOutcome | null,
    dbsReferral: (row.dbsReferral ?? null) as ReferralDecision | null,
    regulatorReferral: (row.regulatorReferral ?? null) as ReferralDecision | null,
    subjectRegistered: row.subjectRegistered,
    linkedToSafeguarding: row.safeguardingIncidentId !== null,
  };
}

/** Updates the case at the version the caller saw; a lost race is a 409. */
async function updateCase(
  tx: Transaction,
  row: CaseRow,
  action: string,
  set: Partial<typeof employeeCase.$inferInsert>,
): Promise<CaseRow> {
  const [updated] = await tx
    .update(employeeCase)
    .set(set)
    .where(and(eq(employeeCase.id, row.id), eq(employeeCase.version, row.version)))
    .returning();
  if (!updated) throw refused(problems.conflict(), action, row.id, "version_conflict");
  return updated;
}

const event = (
  tx: Transaction,
  caseId: string,
  kind: (typeof employeeCaseEvent.$inferInsert)["kind"],
  occurredOn: string,
  extra: Partial<typeof employeeCaseEvent.$inferInsert> = {},
) => tx.insert(employeeCaseEvent).values({ caseId, kind, occurredOn, ...extra });

function summaryOf(
  row: CaseRow,
  myRoles: readonly CaseMemberRole[],
  subjectName: string | null,
): CaseSummary {
  return {
    id: row.id,
    caseType: row.caseType as CaseType,
    subjectTenantUserId: row.subjectTenantUserId,
    subjectName,
    stage: row.stage as CaseStage,
    stageSince: row.stageSince,
    openedOn: row.openedOn,
    myRoles: [...myRoles],
    suspended: row.suspendedOn !== null,
    version: row.version,
  };
}

function memberOf(m: MemberRow): CaseMember {
  return {
    id: m.id,
    tenantUserId: m.tenantUserId,
    role: m.memberRole as CaseMemberRole,
    independenceException: (m.independenceException ?? null) as CaseMember["independenceException"],
    addedBy: m.addedBy,
    removedAt: m.removedAt?.toISOString() ?? null,
    version: m.version,
  };
}

function hearingOf(h: HearingRow): CaseHearing {
  return {
    id: h.id,
    kind: h.kind as CaseHearing["kind"],
    ledBy: h.ledBy,
    invitedOn: h.invitedOn,
    scheduledAt: h.scheduledAt.toISOString(),
    issueSetOut: h.issueSetOut,
    evidenceShared: h.evidenceShared,
    companionRightGiven: h.companionRightGiven,
    state: h.state as HearingState,
    heldOn: h.heldOn,
    accompanied: h.accompanied,
    postponedReason: (h.postponedReason ?? null) as CaseHearing["postponedReason"],
    version: h.version,
  };
}

async function detailOf(tx: Transaction, loaded: Loaded): Promise<CaseDetail> {
  const { row, members, myRoles } = loaded;
  const hearings = await tx
    .select()
    .from(employeeCaseHearing)
    .where(eq(employeeCaseHearing.caseId, row.id))
    .orderBy(asc(employeeCaseHearing.scheduledAt), asc(employeeCaseHearing.id));
  const events = await tx
    .select()
    .from(employeeCaseEvent)
    .where(eq(employeeCaseEvent.caseId, row.id))
    .orderBy(asc(employeeCaseEvent.createdAt), asc(employeeCaseEvent.id));
  const facts = await factsOf(tx, row);
  const due = referralDecisionsDue(facts, (row.closedReason ?? null) as CaseClosingReason | null);
  const names = await staffNames(tx, [
    row.subjectTenantUserId,
    ...members.flatMap((m) => [m.tenantUserId, m.addedBy]),
    ...hearings.map((h) => h.ledBy),
    ...events.map((e) => e.recordedBy),
  ]);
  const staff = [
    ...new Set([
      row.subjectTenantUserId,
      ...members.flatMap((m) => [m.tenantUserId, m.addedBy]),
      ...hearings.map((h) => h.ledBy),
      ...events.map((e) => e.recordedBy),
    ]),
  ].flatMap((id) => {
    const found = names(id);
    return found ? [found] : [];
  });
  const stageSteps = events
    .filter((e) => e.toStage !== null && (e.kind === "opened" || e.kind === "stage_changed"))
    .map((e) => ({ stage: e.toStage as CaseStage, on: e.occurredOn }));
  return {
    case: {
      ...summaryOf(row, myRoles, names(row.subjectTenantUserId)?.displayName ?? null),
      summary: row.summary,
      subjectRegistered: row.subjectRegistered,
      outcome: (row.outcome ?? null) as CaseOutcome | null,
      outcomeDecidedOn: row.outcomeDecidedOn,
      warningExpiresOn: row.warningExpiresOn,
      appealOutcome: (row.appealOutcome ?? null) as AppealOutcome | null,
      appealDecidedOn: row.appealDecidedOn,
      suspendedOn: row.suspendedOn,
      suspensionReviewOn: row.suspensionReviewOn,
      suspensionReviewOverdue: suspensionReviewOverdue(row.suspensionReviewOn, today()),
      closedReason: (row.closedReason ?? null) as CaseDetail["case"]["closedReason"],
      closedOn: row.closedOn,
      safeguardingIncidentId: row.safeguardingIncidentId,
    },
    referrals: {
      dbs: {
        due: due.dbs,
        decision: facts.dbsReferral,
        referredOn: row.dbsReferralOn,
        reason: (row.dbsReferralReason ?? null) as CaseDetail["referrals"]["dbs"]["reason"],
      },
      regulator: {
        due: due.regulator,
        decision: facts.regulatorReferral,
        referredOn: row.regulatorReferralOn,
        reason: (row.regulatorReferralReason ?? null) as CaseDetail["referrals"]["dbs"]["reason"],
      },
    },
    members: members.map(memberOf),
    staff,
    hearings: hearings.map(hearingOf),
    timeline: events.map((e) => ({
      id: e.id,
      kind: e.kind,
      fromStage: (e.fromStage ?? null) as CaseStage | null,
      toStage: (e.toStage ?? null) as CaseStage | null,
      occurredOn: e.occurredOn,
      body: e.body,
      recordedBy: e.recordedBy,
      recordedAt: e.createdAt.toISOString(),
    })),
    daysAtStage: row.stage === "closed" ? null : caseTimeline(stageSteps, today()).daysAtStage,
  };
}

/** Writes the audit event for a case action: the case id and codes only. */
// No codes either: a case's type, stage or referral would tell readers of the audit log about a
// case they are not named on (ADR-0089).
const auditCase = (
  c: Context<AppEnv>,
  tx: Transaction,
  access: TenantAccess,
  action: string,
  id: string,
) => audit(c, tx, access, { action, resourceType: "employee_case", resourceId: id });

const detailResponses = {
  200: jsonBody(CaseDetail, "The case"),
  ...errorResponses,
  ...notFoundResponse,
  ...conflictResponse,
};

/** Loads, checks, changes and returns the case's detail, all in one audited transaction. */
async function withCase(
  c: Context<AppEnv>,
  action: string,
  id: string,
  fn: (tx: Transaction, loaded: Loaded, access: TenantAccess) => Promise<void>,
): Promise<CaseDetail> {
  const access = memberAccess(c);
  return change(c, access, action, async (tx) => {
    const loaded = await loadCase(tx, access, action, id);
    await fn(tx, loaded, access);
    return detailOf(tx, await loadCase(tx, access, action, id));
  });
}

export const caseworkRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/workforce/cases",
      tags: ["workforce"],
      summary: "My employee relations cases",
      description:
        "Any member of staff, with MFA. Only the cases the caller is named on (ADR-0089): no role reaches any other, the owner and the Registered Manager included. Audited.",
      security,
      responses: { 200: jsonBody(CaseList, "The cases"), ...errorResponses },
    }),
    async (c) => {
      const access = memberAccess(c);
      const items = await withTenant(c, async (tx) => {
        const mine = await tx
          .select()
          .from(employeeCaseMember)
          .where(
            and(
              eq(employeeCaseMember.tenantUserId, access.tenantUserId),
              isNull(employeeCaseMember.removedAt),
            ),
          );
        const ids = [...new Set(mine.map((m) => m.caseId))];
        const rows = ids.length
          ? await tx
              .select()
              .from(employeeCase)
              .where(and(inArray(employeeCase.id, ids), isNull(employeeCase.deletedAt)))
              .orderBy(asc(employeeCase.openedOn), asc(employeeCase.id))
          : [];
        await audit(c, tx, access, { action: A.listed, resourceType: "employee_case" });
        const names = await staffNames(
          tx,
          rows.map((r) => r.subjectTenantUserId),
        );
        return rows.map((r) =>
          summaryOf(
            r,
            mine
              .filter((m) => m.caseId === r.id && m.removedAt === null)
              .map((m) => m.memberRole as CaseMemberRole),
            names(r.subjectTenantUserId)?.displayName ?? null,
          ),
        );
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/cases",
      tags: ["workforce"],
      summary: "Open an employee relations case",
      description:
        "workforce.casework.manage (a silo permission, MFA). Opens a grievance, disciplinary, capability, sickness absence or probation case about another member of staff and names the caller its first case manager. Audited with ids only.",
      security,
      request: { body: { content: { "application/json": { schema: OpenCase } } } },
      responses: { 201: jsonBody(CaseDetail, "Opened"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, OPEN);
      const body = c.req.valid("json");
      if (body.subjectTenantUserId === access.tenantUserId) {
        await writeAudit(c.get("services").appPool, access, {
          action: A.opened,
          outcome: "denied",
          reason: "own_case",
          requestId: c.get("requestId"),
        });
        throw problems.invalid("You cannot open a case about yourself.");
      }
      const detail = await change(c, access, A.opened, async (tx) => {
        // The definer opens the case, names the caller its first case manager and writes the
        // opening event together (migration 0101).
        const opened = await tx.execute<{ id: string }>(
          sql`SELECT app.open_employee_case(${body.caseType}, ${body.subjectTenantUserId}::uuid, ${body.summary}, ${body.openedOn}::date) AS id`,
        );
        const row = { id: opened.rows[0]?.id ?? "" };
        if (!row.id) throw new Error("case not opened");
        await auditCase(c, tx, access, A.opened, row.id);
        return detailOf(tx, await loadCase(tx, access, A.opened, row.id));
      });
      return c.json(detail, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/workforce/cases/{id}",
      tags: ["workforce"],
      summary: "An employee relations case",
      description:
        "A member of the case, with MFA: the case, its members, hearings, referral decisions and timeline. Not found for anyone else. Every view is audited.",
      security,
      request: { params: IdParam },
      responses: { 200: jsonBody(CaseDetail, "The case"), ...errorResponses, ...notFoundResponse },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const access = memberAccess(c);
      const detail = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          const loaded = await loadCase(tx, access, A.viewed, id);
          await auditCase(c, tx, access, A.viewed, id);
          return detailOf(tx, loaded);
        }),
      );
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/cases/{id}/members",
      tags: ["workforce"],
      summary: "Name a member of a case",
      description:
        "A case manager of the case. Never the member of staff it is about, never oneself; the investigation, hearing and appeal are taken by different people unless the exception is recorded (rule 16). Audited.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: NameCaseMember } } },
      },
      responses: detailResponses,
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const detail = await withCase(c, A.memberNamed, id, async (tx, loaded, access) => {
        requireRole(loaded, A.memberNamed, ["case_manager"]);
        if (loaded.row.stage === "closed") {
          throw refused(problems.invalid("This case is closed."), A.memberNamed, id, "closed");
        }
        if (body.tenantUserId === access.tenantUserId) {
          throw refused(
            problems.invalid("Ask another case manager to name you."),
            A.memberNamed,
            id,
            "self_appointment",
          );
        }
        const check = checkMemberAppointment({
          tenantUserId: body.tenantUserId,
          role: body.role,
          subjectTenantUserId: loaded.row.subjectTenantUserId,
          active: activeMembers(loaded.members),
          removed: loaded.members
            .filter((m) => m.removedAt !== null)
            .map((m) => ({ tenantUserId: m.tenantUserId, role: m.memberRole as CaseMemberRole })),
          exception: body.independenceException,
        });
        if (!check.ok) {
          throw refused(
            problems.invalid("That person cannot take this part of the case."),
            A.memberNamed,
            id,
            check.problem,
          );
        }
        await tx.insert(employeeCaseMember).values({
          caseId: id,
          tenantUserId: body.tenantUserId,
          memberRole: body.role,
          independenceException: body.independenceException,
          addedBy: access.tenantUserId,
        });
        await event(tx, id, "member_added", today());
        await auditCase(c, tx, access, A.memberNamed, id);
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/cases/{id}/members/{memberId}/remove",
      tags: ["workforce"],
      summary: "Remove a member from a case",
      description:
        "A case manager of the case, with expectedVersion (the membership's). The member then reads nothing of the case; the last case manager stays. Audited.",
      security,
      request: {
        params: MemberParam,
        body: { content: { "application/json": { schema: RemoveCaseMember } } },
      },
      responses: detailResponses,
    }),
    async (c) => {
      const { id, memberId } = c.req.valid("param");
      const body = c.req.valid("json");
      const detail = await withCase(c, A.memberRemoved, id, async (tx, loaded, access) => {
        requireRole(loaded, A.memberRemoved, ["case_manager"]);
        const member = loaded.members.find((m) => m.id === memberId && m.removedAt === null);
        if (!member) throw refused(problems.notFound(), A.memberRemoved, id, "member_not_found");
        if (member.version !== body.expectedVersion) {
          throw refused(problems.conflict(), A.memberRemoved, id, "version_conflict");
        }
        const check = checkMemberRemoval(
          { tenantUserId: member.tenantUserId, role: member.memberRole as CaseMemberRole },
          activeMembers(loaded.members),
        );
        if (!check.ok) {
          throw refused(
            problems.invalid("Name another case manager first."),
            A.memberRemoved,
            id,
            check.problem,
          );
        }
        await tx
          .update(employeeCaseMember)
          .set({ removedAt: new Date(), removedBy: access.tenantUserId })
          .where(
            and(
              eq(employeeCaseMember.id, memberId),
              eq(employeeCaseMember.version, member.version),
            ),
          );
        await event(tx, id, "member_removed", today());
        await auditCase(c, tx, access, A.memberRemoved, id);
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/cases/{id}/move",
      tags: ["workforce"],
      summary: "Move a case on",
      description:
        "With expectedVersion. A case manager starts the investigation, moves to a hearing, records an appeal and closes the case; the hearing chair decides the outcome; the appeal chair decides the appeal as the case closes (rule 15). Closing needs any due DBS and regulator referral decisions recorded (rule 17). Audited with codes only.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: MoveCase } } },
      },
      responses: detailResponses,
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const detail = await withCase(c, A.moved, id, async (tx, loaded, access) => {
        const { row } = loaded;
        requireVersion(row, A.moved, body.expectedVersion);
        const decider: CaseMemberRole =
          body.to === "outcome"
            ? "hearing_chair"
            : body.to === "closed" && body.reason === "appeal_decided"
              ? "appeal_chair"
              : "case_manager";
        requireRole(loaded, A.moved, [decider]);
        const active = activeMembers(loaded.members);
        let move: CaseMove;
        switch (body.to) {
          case "investigation":
            move = {
              to: "investigation",
              investigatorNamed: active.some((m) => m.role === "investigator"),
            };
            break;
          case "hearing":
            move = { to: "hearing" };
            break;
          case "outcome":
            move = {
              to: "outcome",
              outcome: body.outcome,
              decidedOn: body.on,
              warningExpiresOn: body.warningExpiresOn,
              appealRightGiven: body.appealRightGiven,
              noHearingReason: body.noHearingReason,
            };
            break;
          case "appeal":
            move = { to: "appeal" };
            break;
          case "closed":
            move = { to: "closed", reason: body.reason, appealOutcome: body.appealOutcome };
            break;
        }
        const check = checkCaseMove(await factsOf(tx, row), move);
        if (!check.ok) {
          throw refused(
            problems.invalid("The case cannot move on like that yet."),
            A.moved,
            id,
            check.problem,
          );
        }
        if (body.on < row.stageSince) {
          throw refused(
            problems.invalid("The date is before the case reached its current stage."),
            A.moved,
            id,
            "date_before_stage",
          );
        }
        await updateCase(tx, row, A.moved, {
          stage: check.to,
          stageSince: body.on,
          ...(body.to === "outcome"
            ? {
                outcome: body.outcome,
                outcomeDecidedOn: body.on,
                warningExpiresOn: body.warningExpiresOn,
              }
            : {}),
          ...(body.to === "closed"
            ? {
                closedOn: body.on,
                closedReason: body.reason,
                ...(body.reason === "appeal_decided"
                  ? { appealOutcome: body.appealOutcome, appealDecidedOn: body.on }
                  : {}),
              }
            : {}),
        });
        await event(tx, id, "stage_changed", body.on, { fromStage: row.stage, toStage: check.to });
        if (body.to === "appeal") {
          await event(tx, id, "appeal_grounds", body.on, { body: body.grounds });
        }
        await auditCase(c, tx, access, A.moved, id);
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/cases/{id}/hearings",
      tags: ["workforce"],
      summary: "Arrange a meeting or hearing",
      description:
        "A case manager. An investigation meeting is led by the investigator, a hearing by the hearing chair and an appeal hearing by the appeal chair; a hearing needs the issue in writing, the evidence (disciplinary and capability) and the right to be accompanied, for a later date (rule 18). Audited.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: ArrangeHearing } } },
      },
      responses: detailResponses,
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const detail = await withCase(c, A.hearingArranged, id, async (tx, loaded, access) => {
        requireRole(loaded, A.hearingArranged, ["case_manager"]);
        const check = checkHearingInvitation({
          type: loaded.row.caseType as CaseType,
          stage: loaded.row.stage as CaseStage,
          kind: body.kind,
          invitedOn: body.invitedOn,
          scheduledOn: ukIsoDate(new Date(body.scheduledAt)),
          issueSetOut: body.issueSetOut,
          evidenceShared: body.evidenceShared,
          companionRightGiven: body.companionRightGiven,
        });
        if (!check.ok) {
          throw refused(
            problems.invalid("The invitation does not meet the Acas Code yet."),
            A.hearingArranged,
            id,
            check.problem,
          );
        }
        const lead: CaseMemberRole =
          body.kind === "investigation_meeting"
            ? "investigator"
            : body.kind === "hearing"
              ? "hearing_chair"
              : "appeal_chair";
        if (
          !activeMembers(loaded.members).some(
            (m) => m.tenantUserId === body.ledBy && m.role === lead,
          )
        ) {
          throw refused(
            problems.invalid("Name the person leading it on the case first."),
            A.hearingArranged,
            id,
            "lead_not_named",
          );
        }
        await tx.insert(employeeCaseHearing).values({
          caseId: id,
          kind: body.kind,
          ledBy: body.ledBy,
          invitedOn: body.invitedOn,
          scheduledAt: new Date(body.scheduledAt),
          issueSetOut: body.issueSetOut,
          evidenceShared: body.evidenceShared,
          companionRightGiven: body.companionRightGiven,
        });
        await event(tx, id, "hearing_arranged", body.invitedOn);
        await auditCase(c, tx, access, A.hearingArranged, id);
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/v1/workforce/cases/{id}/hearings/{hearingId}",
      tags: ["workforce"],
      summary: "Record what happened at a meeting or hearing",
      description:
        "The case manager or the member leading it, with expectedVersion (the hearing's): held (with the date and whether the employee was accompanied), not attended, postponed with a reason, rearranged or cancelled. A held, unattended or cancelled one is final. Audited.",
      security,
      request: {
        params: HearingParam,
        body: { content: { "application/json": { schema: UpdateHearing } } },
      },
      responses: detailResponses,
    }),
    async (c) => {
      const { id, hearingId } = c.req.valid("param");
      const body = c.req.valid("json");
      const detail = await withCase(c, A.hearingUpdated, id, async (tx, loaded, access) => {
        const [hearing] = await tx
          .select()
          .from(employeeCaseHearing)
          .where(and(eq(employeeCaseHearing.id, hearingId), eq(employeeCaseHearing.caseId, id)));
        if (!hearing) throw refused(problems.notFound(), A.hearingUpdated, id, "hearing_not_found");
        if (hearing.ledBy !== access.tenantUserId) {
          requireRole(loaded, A.hearingUpdated, ["case_manager"]);
        }
        if (hearing.version !== body.expectedVersion) {
          throw refused(problems.conflict(), A.hearingUpdated, id, "version_conflict");
        }
        const rearranged = body.state === "scheduled" && hearing.state === "postponed";
        if (!rearranged && !checkHearingChange(hearing.state as HearingState, body.state)) {
          throw refused(
            problems.invalid("This meeting has already been recorded."),
            A.hearingUpdated,
            id,
            "hearing_final",
          );
        }
        const held = body.state === "held";
        if (
          held !== (body.heldOn !== null) ||
          (body.state === "postponed") !== (body.postponedReason !== null)
        ) {
          throw refused(
            problems.invalid("Give the date it was held, or the reason it was postponed."),
            A.hearingUpdated,
            id,
            "details_required",
          );
        }
        if (rearranged && !body.scheduledAt) {
          throw refused(
            problems.invalid("Give the new date."),
            A.hearingUpdated,
            id,
            "date_required",
          );
        }
        await tx
          .update(employeeCaseHearing)
          .set({
            state: body.state,
            heldOn: body.heldOn,
            accompanied: held ? body.accompanied : null,
            postponedReason: body.postponedReason,
            ...(body.scheduledAt ? { scheduledAt: new Date(body.scheduledAt) } : {}),
          })
          .where(
            and(
              eq(employeeCaseHearing.id, hearingId),
              eq(employeeCaseHearing.version, hearing.version),
            ),
          );
        await event(tx, id, "hearing_updated", body.heldOn ?? today());
        await auditCase(c, tx, access, A.hearingUpdated, id);
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/workforce/cases/{id}/suspension",
      tags: ["workforce"],
      summary: "Suspend, review a suspension or end it",
      description:
        "A case manager of a disciplinary case, with expectedVersion. A precaution, never a sanction: it carries the date it is next reviewed and ends before the case closes (rule 18). Audited.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: ChangeSuspension } } },
      },
      responses: detailResponses,
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const detail = await withCase(c, A.suspension, id, async (tx, loaded, access) => {
        requireRole(loaded, A.suspension, ["case_manager"]);
        const { row } = loaded;
        requireVersion(row, A.suspension, body.expectedVersion);
        const requested =
          body.kind === "end"
            ? ({ kind: "end", on: body.on } as const)
            : ({ kind: body.kind, on: body.on, reviewOn: body.reviewOn ?? body.on } as const);
        const check = checkSuspension(
          {
            type: row.caseType as CaseType,
            stage: row.stage as CaseStage,
            suspendedOn: row.suspendedOn,
          },
          requested,
        );
        if (!check.ok) {
          throw refused(
            problems.invalid("The suspension cannot be changed like that."),
            A.suspension,
            id,
            check.problem,
          );
        }
        await updateCase(
          tx,
          row,
          A.suspension,
          body.kind === "end"
            ? { suspendedOn: null, suspensionReviewOn: null }
            : body.kind === "start"
              ? { suspendedOn: body.on, suspensionReviewOn: body.reviewOn }
              : { suspensionReviewOn: body.reviewOn },
        );
        const kind =
          body.kind === "start"
            ? "suspension_started"
            : body.kind === "review"
              ? "suspension_reviewed"
              : "suspension_ended";
        await event(tx, id, kind, body.on);
        await auditCase(c, tx, access, A.suspension, id);
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/workforce/cases/{id}/referrals",
      tags: ["workforce"],
      summary: "Record a DBS or regulator referral decision",
      description:
        "A case manager, with expectedVersion: referred on a date, or not required with a reason (rule 17). The decision is the people's; Harbour refers nobody. Audited with codes only.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: RecordReferral } } },
      },
      responses: detailResponses,
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const detail = await withCase(c, A.referral, id, async (tx, loaded, access) => {
        requireRole(loaded, A.referral, ["case_manager"]);
        const { row } = loaded;
        requireVersion(row, A.referral, body.expectedVersion);
        if (row.stage === "closed") {
          throw refused(problems.invalid("This case is closed."), A.referral, id, "closed");
        }
        const check = checkReferralDecision(body);
        if (!check.ok) {
          throw refused(
            problems.invalid("Give the referral date, or the reason none is needed."),
            A.referral,
            id,
            check.problem,
          );
        }
        await updateCase(
          tx,
          row,
          A.referral,
          body.body === "dbs"
            ? {
                dbsReferral: body.decision,
                dbsReferralOn: body.referredOn,
                dbsReferralReason: body.reason,
              }
            : {
                regulatorReferral: body.decision,
                regulatorReferralOn: body.referredOn,
                regulatorReferralReason: body.reason,
              },
        );
        await event(tx, id, "referral_recorded", body.referredOn ?? today());
        await auditCase(c, tx, access, A.referral, id);
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/workforce/cases/{id}/safeguarding-link",
      tags: ["workforce"],
      summary: "Link the case to a safeguarding concern",
      description:
        "A case manager who can see the concern in the safeguarding log, with expectedVersion. Set once. The safeguarding log learns nothing of the case. Audited.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: LinkSafeguarding } } },
      },
      responses: detailResponses,
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const detail = await withCase(c, A.safeguarding, id, async (tx, loaded, access) => {
        requireRole(loaded, A.safeguarding, ["case_manager"]);
        requireVersion(loaded.row, A.safeguarding, body.expectedVersion);
        await updateCase(tx, loaded.row, A.safeguarding, {
          safeguardingIncidentId: body.incidentId,
        });
        await event(tx, id, "safeguarding_linked", today());
        await auditCase(c, tx, access, A.safeguarding, id);
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/cases/{id}/notes",
      tags: ["workforce"],
      summary: "Add a note to a case's timeline",
      description:
        "Any member of the case, in their own name, until it closes. Notes are never changed or deleted. Audited without the text.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: AddCaseNote } } },
      },
      responses: detailResponses,
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const detail = await withCase(c, A.note, id, async (tx, loaded, access) => {
        if (loaded.row.stage === "closed") {
          throw refused(problems.invalid("This case is closed."), A.note, id, "closed");
        }
        await event(tx, id, "note", body.occurredOn, { body: body.body });
        await auditCase(c, tx, access, A.note, id);
      });
      return c.json(detail, 200);
    },
  );
