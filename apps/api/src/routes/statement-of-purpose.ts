import {
  ApproveStatementOfPurpose,
  DiscardStatementOfPurpose,
  DraftStatementOfPurpose,
  EditStatementOfPurpose,
  RecordStatementOfPurposeNotification,
  StatementOfPurposeChanges,
  StatementOfPurposeVersionItem,
  StatementOfPurposeVersionList,
} from "@harbour/contracts";
import { statementOfPurposeVersion, type Transaction } from "@harbour/db";
import {
  checkStatementOfPurposeApproval,
  checkStatementOfPurposeNotificationRecord,
  resolveStatementOfPurposeRates,
  STATEMENT_OF_PURPOSE_APPROVAL_MESSAGES,
  STATEMENT_OF_PURPOSE_NOTIFICATION_MESSAGES,
  STATEMENT_OF_PURPOSE_RATE_KEYS,
  type StatementOfPurposeContent,
  type StatementOfPurposeVersion,
  statementOfPurposeChanges,
  statementOfPurposeRegistrationPrompts,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Context } from "hono";
import { AuditedRefusal, withAuditedRefusal, writeAudit } from "../http/audit";
import {
  type AppEnv,
  requireAnyPermission,
  requirePermission,
  type TenantAccess,
  usablePermissions,
  withTenant,
} from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { publish } from "../outbox";
import { rateRows } from "../services/rates";
import {
  acknowledgeStatementAlerts,
  STATEMENT_SOURCE,
  type StatementRow,
  statementItem,
} from "../services/statement-of-purpose";
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
 * The statement of purpose (quality.md rules 11 to 15 and section 5; QUAL-009): drafts by holders
 * of `quality.statement_of_purpose.write`, approval by a holder of `.approve` who did not write
 * or edit it, and the CQC notification of a revision recorded by a holder of
 * `safety.notification.submit` with step-up. The database enforces the same (migration 0057).
 */

const WRITE = "quality.statement_of_purpose.write";
const APPROVE = "quality.statement_of_purpose.approve";
const SUBMIT = "safety.notification.submit";
const A = {
  drafted: "quality.statement_of_purpose.drafted",
  edited: "quality.statement_of_purpose.edited",
  discarded: "quality.statement_of_purpose.discarded",
  approved: "quality.statement_of_purpose.approved",
  notified: "quality.statement_of_purpose.notified",
} as const;

const IdParam = z.object({ id: z.uuid() });
const stateConflict = (detail: string) => new HttpProblem(409, "invalid_state", detail);

const refused = (problem: HttpProblem, action: string, id: string | null, reason: string) =>
  new AuditedRefusal(problem, {
    action,
    outcome: "denied",
    resourceType: STATEMENT_SOURCE,
    ...(id ? { resourceId: id } : {}),
    reason,
  });

/** Runs a change; refusals and the database's own (403, 409) are audited. */
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
    if (code !== "42501" && code !== "23000" && code !== "23514" && code !== "23505") throw error;
    await writeAudit(c.get("services").appPool, access, {
      action,
      outcome: "denied",
      resourceType: STATEMENT_SOURCE,
      ...(id ? { resourceId: id } : {}),
      reason: code === "42501" ? "refused_by_database" : "invalid_state",
      requestId: c.get("requestId"),
    });
    throw code === "42501"
      ? problems.forbidden()
      : code === "23505"
        ? stateConflict("A draft is already open. Finish or discard it first.")
        : stateConflict("The statement cannot be changed like that now. Reload it and try again.");
  }
}

async function findVersion(tx: Transaction, id: string): Promise<StatementRow | null> {
  const [row] = await tx
    .select()
    .from(statementOfPurposeVersion)
    .where(eq(statementOfPurposeVersion.id, id));
  return row ?? null;
}

async function versionFor(
  tx: Transaction,
  action: string,
  id: string,
  expect: { version?: number; draft?: boolean },
): Promise<StatementRow> {
  const row = await findVersion(tx, id);
  if (!row) throw refused(problems.notFound(), action, id, "not_found");
  if (expect.version !== undefined && row.version !== expect.version) {
    throw refused(problems.conflict(), action, id, "version_conflict");
  }
  if (expect.draft && row.state !== "draft") {
    throw refused(stateConflict("Only a draft can be changed."), action, id, "not_draft");
  }
  return row;
}

async function currentApproved(tx: Transaction): Promise<StatementRow | null> {
  const [row] = await tx
    .select()
    .from(statementOfPurposeVersion)
    .where(eq(statementOfPurposeVersion.state, "approved"));
  return row ?? null;
}

/** The domain's view of a stored version. */
const domainVersion = (row: StatementRow): StatementOfPurposeVersion => ({
  id: row.id,
  version: row.versionNumber,
  state: row.state as StatementOfPurposeVersion["state"],
  kind: row.kind as StatementOfPurposeVersion["kind"],
  content: row.content as StatementOfPurposeContent,
  authorId: row.authorId,
  contributorIds: row.contributorIds,
  approvedBy: row.approvedBy,
  approvedAt: row.approvedAt,
  notifiedAt: row.notifiedAt,
});

export const statementOfPurposeRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/statement-of-purpose/versions",
      tags: ["quality"],
      summary: "Statement of purpose versions",
      description:
        "Holders of quality.statement_of_purpose.write or .approve or safety.notification.submit anywhere in the organisation. Newest first, with the Schedule 3 checklist and where each revision stands against the regulation 12(3) clock.",
      security,
      responses: { 200: jsonBody(StatementOfPurposeVersionList, "Versions"), ...errorResponses },
    }),
    async (c) => {
      await requireAnyPermission(c, [WRITE, APPROVE, SUBMIT]);
      const rows = await withTenant(c, (tx) =>
        tx
          .select()
          .from(statementOfPurposeVersion)
          .orderBy(desc(statementOfPurposeVersion.versionNumber)),
      );
      const now = new Date();
      return c.json({ items: rows.map((r) => statementItem(r, now)) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/statement-of-purpose/versions",
      tags: ["quality"],
      summary: "Start a draft",
      description:
        "quality.statement_of_purpose.write. The first version is the baseline (the statement CQC already holds) and needs its content; later drafts are revisions, starting from the current version unless content is given. One draft at a time. Audited.",
      security,
      request: { body: { content: { "application/json": { schema: DraftStatementOfPurpose } } } },
      responses: {
        201: jsonBody(StatementOfPurposeVersionItem, "Drafted"),
        ...errorResponses,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, WRITE);
      const body = c.req.valid("json");
      const row = await change(c, access, A.drafted, null, async (tx) => {
        const [settled] = await tx
          .select({ id: statementOfPurposeVersion.id })
          .from(statementOfPurposeVersion)
          .where(inArray(statementOfPurposeVersion.state, ["approved", "superseded"]))
          .limit(1);
        const current = await currentApproved(tx);
        const content = body.content ?? current?.content;
        if (content === undefined) {
          throw refused(
            problems.invalid("Give the statement CQC already holds as the first version."),
            A.drafted,
            null,
            "baseline_content_missing",
          );
        }
        const [inserted] = await tx
          .insert(statementOfPurposeVersion)
          .values({
            versionNumber: 0,
            kind: settled ? "revision" : "baseline",
            content,
            authorId: access.tenantUserId,
          })
          .returning();
        if (!inserted) throw new Error("statement version not stored");
        await audit(c, tx, access, {
          action: A.drafted,
          resourceType: STATEMENT_SOURCE,
          resourceId: inserted.id,
          scope: { kind: inserted.kind, versionNumber: inserted.versionNumber },
        });
        return inserted;
      });
      return c.json(statementItem(row), 201);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/statement-of-purpose/versions/{id}",
      tags: ["quality"],
      summary: "Edit a draft",
      description:
        "quality.statement_of_purpose.write, drafts only, against the version you loaded. An editor joins the contributors, so cannot approve it. Audited.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: EditStatementOfPurpose } } },
      },
      responses: {
        200: jsonBody(StatementOfPurposeVersionItem, "Saved"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, WRITE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const row = await change(c, access, A.edited, id, async (tx) => {
        await versionFor(tx, A.edited, id, { version: body.version, draft: true });
        const [updated] = await tx
          .update(statementOfPurposeVersion)
          .set({ content: body.content })
          .where(
            and(
              eq(statementOfPurposeVersion.id, id),
              eq(statementOfPurposeVersion.version, body.version),
            ),
          )
          .returning();
        if (!updated) throw refused(problems.conflict(), A.edited, id, "version_conflict");
        await audit(c, tx, access, {
          action: A.edited,
          resourceType: STATEMENT_SOURCE,
          resourceId: id,
        });
        return updated;
      });
      return c.json(statementItem(row), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/statement-of-purpose/versions/{id}/discard",
      tags: ["quality"],
      summary: "Discard a draft",
      description: "quality.statement_of_purpose.write, with a reason. Audited.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: DiscardStatementOfPurpose } } },
      },
      responses: {
        200: jsonBody(StatementOfPurposeVersionItem, "Discarded"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, WRITE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const row = await change(c, access, A.discarded, id, async (tx) => {
        await versionFor(tx, A.discarded, id, { version: body.version, draft: true });
        const [updated] = await tx
          .update(statementOfPurposeVersion)
          .set({ state: "discarded", discardReason: body.reason })
          .where(eq(statementOfPurposeVersion.id, id))
          .returning();
        if (!updated) throw new Error("statement version not updated");
        await audit(c, tx, access, {
          action: A.discarded,
          resourceType: STATEMENT_SOURCE,
          resourceId: id,
          reason: body.reason,
        });
        return updated;
      });
      return c.json(statementItem(row), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/statement-of-purpose/versions/{id}/approve",
      tags: ["quality"],
      summary: "Approve a draft",
      description:
        "quality.statement_of_purpose.approve (the registered provider or a registered manager), never by its author or an editor; complete against Schedule 3 and different from the current version (rule 14). Supersedes the current version and, for a revision, starts the regulation 12(3) clock (cqc.statement_of_purpose.revision_notice_days). Audited; quality.statement_of_purpose.approved.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: ApproveStatementOfPurpose } } },
      },
      responses: {
        200: jsonBody(StatementOfPurposeVersionItem, "Approved"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, APPROVE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const row = await change(c, access, A.approved, id, async (tx) => {
        const draft = await versionFor(tx, A.approved, id, { version: body.version });
        const current = await currentApproved(tx);
        const now = new Date();
        const check = checkStatementOfPurposeApproval(
          domainVersion(draft),
          current ? domainVersion(current) : null,
          { id: access.tenantUserId, permissions: usablePermissions(access, now), at: now },
          resolveStatementOfPurposeRates(
            await rateRows(tx, Object.values(STATEMENT_OF_PURPOSE_RATE_KEYS)),
            "england",
            now.toISOString().slice(0, 10),
            access.tenantId,
          ),
        );
        if (!check.ok) {
          const detail = check.problems
            .map((p) => STATEMENT_OF_PURPOSE_APPROVAL_MESSAGES[p])
            .join(" ");
          const problem =
            check.problems.includes("author_cannot_approve") ||
            check.problems.includes("missing_permission")
              ? new HttpProblem(
                  403,
                  "separation_of_duties",
                  "You cannot approve this version.",
                  detail,
                )
              : check.problems.includes("incomplete")
                ? problems.invalid(detail)
                : stateConflict(detail);
          throw refused(problem, A.approved, id, check.problems.join(","));
        }
        const [updated] = await tx
          .update(statementOfPurposeVersion)
          .set({
            state: "approved",
            approvedBy: access.tenantUserId,
            approvedAt: now,
            changeSummary: check.changes,
            registrationPrompts: check.registrationPrompts.map((p) => ({
              kind: p.kind,
              message: p.message,
            })),
          })
          .where(eq(statementOfPurposeVersion.id, id))
          .returning();
        if (!updated) throw new Error("statement version not updated");
        await audit(c, tx, access, {
          action: A.approved,
          resourceType: STATEMENT_SOURCE,
          resourceId: id,
          scope: {
            kind: updated.kind,
            supersedes: updated.supersedesId,
            notificationDueAt: updated.notificationDueAt?.toISOString() ?? null,
          },
        });
        await publish(tx, {
          context: "quality",
          aggregateType: STATEMENT_SOURCE,
          aggregateId: id,
          type: "quality.statement_of_purpose.approved",
          payload: {
            versionId: id,
            kind: updated.kind,
            notificationDueAt: updated.notificationDueAt?.toISOString() ?? null,
          },
        });
        return updated;
      });
      return c.json(statementItem(row), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/statement-of-purpose/versions/{id}/notification",
      tags: ["quality"],
      summary: "Record that a revision was sent to CQC (step-up)",
      description:
        "safety.notification.submit with a fresh sign-in (rule 15): once, for an approved revision, at a time not before its approval and not in the future, with the CQC reference or how it was sent. A submission after the due date is recorded as late. Stops the overdue alerts. Audited.",
      security,
      request: {
        params: IdParam,
        body: {
          content: { "application/json": { schema: RecordStatementOfPurposeNotification } },
        },
      },
      responses: {
        200: jsonBody(StatementOfPurposeVersionItem, "Recorded"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, SUBMIT);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const sentAt = new Date(body.sentAt);
      const row = await change(c, access, A.notified, id, async (tx) => {
        const version = await versionFor(tx, A.notified, id, {});
        const now = new Date();
        const found = checkStatementOfPurposeNotificationRecord(domainVersion(version), {
          permissions: usablePermissions(access, now),
          stepUpFresh: true,
          sentAt,
          evidence: body.evidence,
        });
        if (found.length > 0 || sentAt > now) {
          const detail =
            found.length > 0
              ? found.map((p) => STATEMENT_OF_PURPOSE_NOTIFICATION_MESSAGES[p]).join(" ")
              : "The submission time cannot be in the future.";
          throw refused(
            found.includes("not_required") ? stateConflict(detail) : problems.invalid(detail),
            A.notified,
            id,
            found.length > 0 ? found.join(",") : "sent_in_future",
          );
        }
        const [updated] = await tx
          .update(statementOfPurposeVersion)
          .set({
            notifiedAt: sentAt,
            notifiedBy: access.tenantUserId,
            notificationEvidence: body.evidence,
          })
          .where(eq(statementOfPurposeVersion.id, id))
          .returning();
        if (!updated) throw new Error("statement version not updated");
        const late = updated.notificationDueAt !== null && sentAt > updated.notificationDueAt;
        await audit(c, tx, access, {
          action: A.notified,
          resourceType: STATEMENT_SOURCE,
          resourceId: id,
          scope: { sentAt: sentAt.toISOString(), late },
        });
        await acknowledgeStatementAlerts(tx, id, now);
        return updated;
      });
      return c.json(statementItem(row), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/statement-of-purpose/versions/{id}/changes",
      tags: ["quality"],
      summary: "What a version changes",
      description:
        "Section by section in plain English (rule 12), with the registration prompts (rule 13): a draft against the current version, an approved one against the version it superseded.",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(StatementOfPurposeChanges, "Changes"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      await requireAnyPermission(c, [WRITE, APPROVE, SUBMIT]);
      const { id } = c.req.valid("param");
      const result = await withTenant(c, async (tx) => {
        const row = await findVersion(tx, id);
        if (!row) return null;
        const previous =
          row.state === "approved" || row.state === "superseded"
            ? row.supersedesId
              ? await findVersion(tx, row.supersedesId)
              : null
            : await currentApproved(tx);
        const before = (previous?.content ?? null) as StatementOfPurposeContent | null;
        const after = row.content as StatementOfPurposeContent;
        return {
          comparedWithId: previous?.id ?? null,
          sections: statementOfPurposeChanges(before, after).map((s) => ({
            key: s.key,
            title: s.title,
            change: s.change,
            lines: [...s.lines],
          })),
          registrationPrompts: statementOfPurposeRegistrationPrompts(before, after).map((p) => ({
            kind: p.kind,
            message: p.message,
          })),
        };
      });
      if (!result) throw problems.notFound();
      return c.json(result, 200);
    },
  );
