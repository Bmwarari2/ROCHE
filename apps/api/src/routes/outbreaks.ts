import {
  CloseOutbreak,
  DeclareOutbreak,
  IpcAuditCriteria,
  IpcCriterionList,
  OutbreakDetail,
  OutbreakList,
  RecordOutbreakCase,
  UpdateOutbreak,
} from "@harbour/contracts";
import {
  auditRecord,
  ipcCodeCriterion,
  location,
  outbreak,
  outbreakCase,
  person,
  roleAssignment,
  statutoryNotification,
  type Transaction,
  tenantUser,
} from "@harbour/db";
import {
  auditScoreMethod,
  checkOutbreakCase,
  checkOutbreakClosure,
  currentCases,
  type IpcAuditQuestion,
  ipcCriteriaResults,
  OUTBREAK_CASE_MESSAGES,
  OUTBREAK_CLOSURE_MESSAGES,
  scoreAudit,
  ukIsoDate,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, desc, eq, gt, isNull, lte, or } from "drizzle-orm";
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
import {
  allOutbreakCases,
  domainCase,
  draftReport,
  outbreakDetail,
  outbreakSummary,
} from "../services/outbreaks";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import { audit, dbCode } from "./people-shared";
import { notificationSummary } from "./safety-shared";

/**
 * Outbreak management and IPC audits (safety.md section 11; SAFE-013; HZ-013; migration 0093).
 * Outbreaks are `safety.outbreak.manage` at their location (row-level security holds the same
 * line); a resident's case is seen only by those who can see the person. Declaring an outbreak
 * drafts its own UKHSA report, due without delay, so the notification centre carries its clock;
 * closing waits until that report is decided. The line list is append-only; the report's fields
 * are counted from all of it, shown on the outbreak and never written into the report. IPC audits are read against the Code of
 * Practice criteria with the audit's own scoring. Every change, view and refusal is audited with
 * ids only.
 */

const MANAGE = "safety.outbreak.manage";
const A = {
  declared: "safety.outbreak.declared",
  viewed: "safety.outbreak.view",
  updated: "safety.outbreak.updated",
  caseRecorded: "safety.outbreak.case_recorded",
  closed: "safety.outbreak.closed",
} as const;
type Action = (typeof A)[keyof typeof A];

const IdParam = z.object({ id: z.uuid() });

const refused = (problem: HttpProblem, action: Action, id: string | null, reason: string) =>
  new AuditedRefusal(problem, {
    action,
    outcome: "denied",
    resourceType: "outbreak",
    ...(id ? { resourceId: id } : {}),
    reason,
  });

const stateConflict = (detail: string) => new HttpProblem(409, "invalid_state", detail);

/** Runs a change; refusals and the database's own (403, 409) are audited. */
async function change<T>(
  c: Context<AppEnv>,
  access: TenantAccess,
  action: Action,
  id: string | null,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  try {
    return await withAuditedRefusal(c, access, () => withTenant(c, fn));
  } catch (error) {
    const code = dbCode(error) ?? "";
    if (!["42501", "23000", "23514", "23505", "23503"].includes(code)) throw error;
    await writeAudit(c.get("services").appPool, access, {
      action,
      outcome: "denied",
      resourceType: "outbreak",
      ...(id ? { resourceId: id } : {}),
      reason: code === "42501" ? "refused_by_database" : "invalid_state",
      requestId: c.get("requestId"),
    });
    if (code === "42501") throw problems.forbidden();
    if (code === "23505") {
      throw stateConflict(
        action === A.declared
          ? "An outbreak of this illness is already open at this location."
          : "This case was updated since you read it. Reload and try again.",
      );
    }
    throw stateConflict("This changed since you read it. Reload and try again.");
  }
}

async function findOutbreak(tx: Transaction, id: string, action: Action | null, lock = false) {
  const query = tx.select().from(outbreak).where(eq(outbreak.id, id));
  const [row] = lock ? await query.for("update") : await query;
  if (row) return row;
  if (action) throw refused(problems.notFound(), action, id, "outbreak_not_found_or_out_of_scope");
  throw problems.notFound();
}

const summarise = (now: Date) => (n: typeof statutoryNotification.$inferSelect) =>
  notificationSummary(n, now);

export const outbreaksRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/safety/ipc-criteria",
      tags: ["safety"],
      summary: "The IPC Code of Practice criteria",
      description:
        "safety.outbreak.manage or quality.audit.manage. Global reference data: the 10 criteria of the Code of Practice on the prevention and control of infections, in Harbour's summary, that IPC audit questions are mapped to.",
      security,
      responses: { 200: jsonBody(IpcCriterionList, "Criteria"), ...errorResponses },
    }),
    async (c) => {
      await requireAnyPermission(c, [MANAGE, "quality.audit.manage"]);
      const items = await withTenant(c, (tx) =>
        tx.select().from(ipcCodeCriterion).orderBy(asc(ipcCodeCriterion.number)),
      );
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/safety/ipc-audits/{id}/criteria",
      tags: ["safety"],
      summary: "An IPC audit read against the Code of Practice criteria",
      description:
        "quality.audit.manage at the audit's location. Each criterion with the questions mapped to it, the audit's own weighted score over them and the answers that fell short; a criterion no question covers has no score, so a gap shows. Only for audits of kind `ipc` (409 otherwise). Read from the questions the audit started with.",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(IpcAuditCriteria, "Criteria results"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      await requirePermission(c, "quality.audit.manage");
      const { id } = c.req.valid("param");
      const result = await withTenant(c, async (tx) => {
        const [row] = await tx.select().from(auditRecord).where(eq(auditRecord.id, id));
        if (!row) throw problems.notFound();
        if (row.kind !== "ipc") {
          throw stateConflict("Only an IPC audit is read against the Code of Practice criteria.");
        }
        const questions = row.questions as IpcAuditQuestion[];
        const answers = row.answers as Record<string, "yes" | "partial" | "no" | "not_applicable">;
        return {
          auditId: row.id,
          criteria: ipcCriteriaResults(questions, answers).map((r) => ({
            id: r.criterion.id,
            number: r.criterion.number,
            title: r.criterion.title,
            questionKeys: [...r.questionKeys],
            percent: r.percent,
            achieved: r.achieved,
            possible: r.possible,
            fellShort: [...r.fellShort],
          })),
          method: auditScoreMethod(scoreAudit({ questions }, answers)),
        };
      });
      return c.json(result, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/safety/outbreaks",
      tags: ["safety"],
      summary: "Outbreaks",
      description:
        "safety.outbreak.manage, at the locations where you hold it. Newest first, at most 200, by location or state.",
      security,
      request: {
        query: z.object({
          locationId: z.uuid().optional(),
          state: z.enum(["declared", "closed"]).optional(),
        }),
      },
      responses: { 200: jsonBody(OutbreakList, "Outbreaks"), ...errorResponses },
    }),
    async (c) => {
      await requirePermission(c, MANAGE);
      const q = c.req.valid("query");
      const rows = await withTenant(c, (tx) =>
        tx
          .select()
          .from(outbreak)
          .where(
            and(
              q.locationId ? eq(outbreak.locationId, q.locationId) : undefined,
              q.state ? eq(outbreak.state, q.state) : undefined,
              isNull(outbreak.deletedAt),
            ),
          )
          .orderBy(desc(outbreak.declaredAt))
          .limit(200),
      );
      return c.json({ items: rows.map(outbreakSummary) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/safety/outbreaks",
      tags: ["safety"],
      summary: "Declare an outbreak",
      description:
        "safety.outbreak.manage at the location, in England (other nations wait for their nation pack; 409). One open outbreak per illness at a location (409 otherwise). Drafts the outbreak's own UKHSA report, due without delay, so its clock shows in the notification centre (HZ-013). Audited.",
      security,
      request: { body: { content: { "application/json": { schema: DeclareOutbreak } } } },
      responses: {
        201: jsonBody(OutbreakDetail, "Declared"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const body = c.req.valid("json");
      const now = new Date();
      const declared = await change(c, access, A.declared, null, async (tx) => {
        const [place] = await tx
          .select({ id: location.id, nation: location.nation })
          .from(location)
          .where(eq(location.id, body.locationId));
        if (!place) throw refused(problems.notFound(), A.declared, null, "location_not_found");
        if (place.nation !== "england") {
          throw refused(
            stateConflict(
              "Outbreak reports for this nation are not set up yet. Report it to your public health agency directly.",
            ),
            A.declared,
            null,
            "nation_not_supported",
          );
        }
        const [row] = await tx
          .insert(outbreak)
          .values({
            locationId: body.locationId,
            syndrome: body.syndrome,
            organism: body.organism ?? null,
            hptReference: body.hptReference ?? null,
            declaredBy: access.tenantUserId,
          })
          .returning();
        if (!row) throw new Error("outbreak not stored");
        const report = await draftReport(tx, access.tenantId, row, now);
        const [linked] = await tx
          .update(outbreak)
          .set({ notificationId: report.id })
          .where(eq(outbreak.id, row.id))
          .returning();
        if (!linked) throw new Error("outbreak report not linked");
        await audit(c, tx, access, {
          action: A.declared,
          resourceType: "outbreak",
          resourceId: row.id,
          scope: {
            locationId: row.locationId,
            syndrome: row.syndrome,
            notificationId: report.id,
            reportDrafted: report.drafted,
          },
        });
        return outbreakDetail(tx, linked, summarise(now));
      });
      return c.json(declared, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/safety/outbreaks/{id}",
      tags: ["safety"],
      summary: "An outbreak with its line list, report fields and report clock",
      description:
        "safety.outbreak.manage at the outbreak's location. Every line-list row (residents only where you can see the person), each marked current or superseded; the UKHSA report fields counted from every row, whoever is reading (people ever positive or in hospital counted once), with what is still missing, to copy into the report; the outbreak's own report with its clock; how many cases are still unwell; how many rows about residents you cannot see are counted but not listed. The view is audited.",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(OutbreakDetail, "The outbreak"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const now = new Date();
      const detail = await withTenant(c, async (tx) => {
        const row = await findOutbreak(tx, id, null);
        const out = await outbreakDetail(tx, row, summarise(now));
        await audit(c, tx, access, {
          action: A.viewed,
          resourceType: "outbreak",
          resourceId: id,
          scope: { cases: out.cases.length },
        });
        return out;
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/safety/outbreaks/{id}",
      tags: ["safety"],
      summary: "Record the organism or the health protection team's reference",
      description:
        "safety.outbreak.manage at the outbreak's location, against the version read; an open outbreak only. Audited.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: UpdateOutbreak } } },
      },
      responses: {
        200: jsonBody(OutbreakDetail, "Updated"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const updated = await change(c, access, A.updated, id, async (tx) => {
        const current = await findOutbreak(tx, id, A.updated, true);
        if (current.state === "closed") {
          throw refused(
            stateConflict("This outbreak is closed and does not change."),
            A.updated,
            id,
            "outbreak_closed",
          );
        }
        const [row] = await tx
          .update(outbreak)
          .set({ organism: body.organism, hptReference: body.hptReference })
          .where(and(eq(outbreak.id, id), eq(outbreak.version, body.version)))
          .returning();
        if (!row) throw refused(problems.conflict(), A.updated, id, "version_conflict");
        await audit(c, tx, access, {
          action: A.updated,
          resourceType: "outbreak",
          resourceId: id,
          scope: { version: row.version },
        });
        return outbreakDetail(tx, row, summarise(now));
      });
      return c.json(updated, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/safety/outbreaks/{id}/cases",
      tags: ["safety"],
      summary: "Add a case to the line list, or update one",
      description:
        "safety.outbreak.manage at the outbreak's location; an open outbreak only. A resident living at the location (one you can see) or an active member of staff working there (a current role at the location or across the organisation), once per outbreak: a later row names the current row it supersedes and follows it, wherever the person is now, with a reason when it corrects rather than updates. Checked by `checkOutbreakCase` (nothing dated in the future, a test with its date and type, an outcome with its date). Audited with ids only.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: RecordOutbreakCase } } },
      },
      responses: {
        201: jsonBody(OutbreakDetail, "Recorded"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const recorded = await change(c, access, A.caseRecorded, id, async (tx) => {
        const current = await findOutbreak(tx, id, A.caseRecorded, true);
        const found = checkOutbreakCase(
          {
            caseType: body.caseType,
            personId: body.personId,
            tenantUserId: body.tenantUserId,
            onsetOn: body.onsetOn,
            symptoms: body.symptoms,
            testType: body.testType,
            testedOn: body.testedOn,
            testResult: body.testResult,
            fluVaccinated: body.fluVaccinated,
            covidVaccinated: body.covidVaccinated,
            outcome: body.outcome,
            outcomeOn: body.outcomeOn,
          },
          { state: current.state as "declared" | "closed" },
          ukIsoDate(now),
        );
        if (found.includes("outbreak_closed")) {
          throw refused(
            stateConflict(OUTBREAK_CASE_MESSAGES.outbreak_closed),
            A.caseRecorded,
            id,
            "outbreak_closed",
          );
        }
        if (found.length > 0) {
          throw refused(
            problems.invalid(found.map((p) => OUTBREAK_CASE_MESSAGES[p]).join(" ")),
            A.caseRecorded,
            id,
            found.join(","),
          );
        }
        if (body.tenantUserId && !body.supersedesId) {
          const [member] = await tx
            .select({ id: tenantUser.id })
            .from(tenantUser)
            .where(
              and(
                eq(tenantUser.id, body.tenantUserId),
                eq(tenantUser.status, "active"),
                isNull(tenantUser.deletedAt),
              ),
            );
          if (!member) {
            throw refused(problems.notFound(), A.caseRecorded, id, "staff_member_not_found");
          }
          const [works] = await tx
            .select({ id: roleAssignment.id })
            .from(roleAssignment)
            .where(
              and(
                eq(roleAssignment.tenantUserId, body.tenantUserId),
                or(
                  eq(roleAssignment.locationId, current.locationId),
                  isNull(roleAssignment.locationId),
                ),
                lte(roleAssignment.validFrom, now),
                or(isNull(roleAssignment.validTo), gt(roleAssignment.validTo, now)),
              ),
            )
            .limit(1);
          if (!works) {
            throw refused(
              problems.invalid("Choose a member of staff who works at this location."),
              A.caseRecorded,
              id,
              "staff_member_not_at_location",
            );
          }
        }
        const existing = await allOutbreakCases(tx, id);
        // One current row per person (HZ-013): a second would count them twice in the UKHSA report
        // and keep an old "unwell" row open; a change is recorded by superseding the current row.
        if (!body.supersedesId) {
          const already = currentCases(existing.map(domainCase)).some(
            (r) =>
              (body.personId !== null && r.personId === body.personId) ||
              (body.tenantUserId !== null && r.tenantUserId === body.tenantUserId),
          );
          if (already) {
            throw refused(
              problems.invalid(
                "This person is already on the line list. Update their existing row instead.",
              ),
              A.caseRecorded,
              id,
              "person_already_listed",
            );
          }
        }
        if (body.supersedesId) {
          const latest = currentCases(existing.map(domainCase)).some(
            (r) => r.id === body.supersedesId,
          );
          if (!latest) {
            throw refused(
              stateConflict("This case was updated since you read it. Reload and try again."),
              A.caseRecorded,
              id,
              "superseded_row_not_current",
            );
          }
        }
        if (body.personId && !body.supersedesId) {
          // Read in the caller's scope: a person they cannot see reads as not found. An update
          // follows the row it supersedes, wherever the person is now (the database checks it).
          const visible = await tx
            .select({ id: person.id })
            .from(person)
            .where(and(eq(person.id, body.personId), eq(person.locationId, current.locationId)));
          if (visible.length === 0) {
            throw refused(problems.notFound(), A.caseRecorded, id, "person_not_found_at_location");
          }
        }
        const [row] = await tx
          .insert(outbreakCase)
          .values({ outbreakId: id, ...body })
          .returning();
        if (!row) throw new Error("outbreak case not stored");
        await audit(c, tx, access, {
          action: A.caseRecorded,
          resourceType: "outbreak_case",
          resourceId: row.id,
          scope: {
            outbreakId: id,
            caseType: row.caseType,
            supersedesId: row.supersedesId,
            ...(row.personId ? { personId: row.personId } : {}),
          },
        });
        return outbreakDetail(tx, current, summarise(now));
      });
      return c.json(recorded, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/safety/outbreaks/{id}/close",
      tags: ["safety"],
      summary: "Close an outbreak",
      description:
        "safety.outbreak.manage at the outbreak's location, against the version read, with the date and a reason (for example agreed with the health protection team). Only once the outbreak's own UKHSA report is submitted or recorded as not needed (HZ-013; 409 otherwise); not before the day it was declared or the last case's symptoms started (counted from every row), nor in the future. Cases still unwell are said in the response, never a blocker. Final. Audited.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: CloseOutbreak } } },
      },
      responses: {
        200: jsonBody(OutbreakDetail, "Closed"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const closed = await change(c, access, A.closed, id, async (tx) => {
        const current = await findOutbreak(tx, id, A.closed, true);
        if (current.version !== body.version && current.state !== "closed") {
          throw refused(problems.conflict(), A.closed, id, "version_conflict");
        }
        const [report] = current.notificationId
          ? await tx
              .select({ status: statutoryNotification.status })
              .from(statutoryNotification)
              .where(eq(statutoryNotification.id, current.notificationId))
          : [];
        if (current.notificationId && !report) {
          // A report the closer cannot see cannot be shown to be decided.
          throw refused(
            stateConflict(OUTBREAK_CLOSURE_MESSAGES.report_undecided),
            A.closed,
            id,
            "report_not_visible",
          );
        }
        const cases = (await allOutbreakCases(tx, id)).map(domainCase);
        const latest =
          currentCases(cases)
            .map((r) => r.onsetOn)
            .sort()
            .at(-1) ?? null;
        const found = checkOutbreakClosure(
          {
            state: current.state as "declared" | "closed",
            declaredOn: ukIsoDate(current.declaredAt),
          },
          report
            ? { status: report.status as "draft" | "ready" | "submitted" | "not_required" }
            : null,
          latest,
          body.closedOn,
          ukIsoDate(now),
        );
        const stateProblems = found.filter(
          (p) => p === "already_closed" || p === "report_undecided",
        );
        if (stateProblems.length > 0) {
          throw refused(
            stateConflict(stateProblems.map((p) => OUTBREAK_CLOSURE_MESSAGES[p]).join(" ")),
            A.closed,
            id,
            stateProblems.join(","),
          );
        }
        if (found.length > 0) {
          throw refused(
            problems.invalid(found.map((p) => OUTBREAK_CLOSURE_MESSAGES[p]).join(" ")),
            A.closed,
            id,
            found.join(","),
          );
        }
        const [row] = await tx
          .update(outbreak)
          .set({
            state: "closed",
            closedOn: body.closedOn,
            closedBy: access.tenantUserId,
            closureReason: body.reason,
          })
          .where(and(eq(outbreak.id, id), eq(outbreak.version, body.version)))
          .returning();
        if (!row) throw refused(problems.conflict(), A.closed, id, "version_conflict");
        const detail = await outbreakDetail(tx, row, summarise(now));
        await audit(c, tx, access, {
          action: A.closed,
          resourceType: "outbreak",
          resourceId: id,
          scope: { closedOn: row.closedOn, stillUnwell: detail.stillUnwell },
        });
        return detail;
      });
      return c.json(closed, 200);
    },
  );
