import {
  ApproveTemplateVersion,
  CreateLetterTemplate,
  EditTemplateVersion,
  EndTemplateVersion,
  LetterTemplateItem,
  LetterTemplateList,
  LetterTemplateVersionItem,
  LetterTemplateVersionList,
  MergeFieldList,
} from "@harbour/contracts";
import { letterTemplate, letterTemplateVersion, type Transaction } from "@harbour/db";
import {
  checkTemplateApproval,
  checkTemplateDefinition,
  LETTER_ONLY_KINDS,
  MERGE_FIELDS,
  TEMPLATE_APPROVAL_MESSAGES,
  type TemplateChannel,
  type TemplateKind,
  type TemplateVersion,
  type TemplateVersionState,
  templateStyleWarnings,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
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
 * Letter and email templates (comms.md rules 18 to 23 and section 5; COMMS-007; ADR-0051; hazard
 * HZ-051): the merge field catalogue, templates with their versions, drafts written and changed by
 * holders of `comms.template.write`, approved, retired or superseded by holders of
 * `comms.template.approve` who did not write or edit them. Every draft is checked as it is saved
 * (`checkTemplateDefinition`) and its problems returned; approval needs none. The database holds
 * the same workflow (migration 0059). Making and sending letters is part 2b.
 */

const WRITE = "comms.template.write";
const APPROVE = "comms.template.approve";
const LETTERS = "comms.letter.manage";
const READERS = [WRITE, APPROVE, LETTERS] as const;
const A = {
  drafted: "comms.template.drafted",
  edited: "comms.template.edited",
  approved: "comms.template.approved",
  retired: "comms.template.retired",
  discarded: "comms.template.discarded",
} as const;

type TemplateRow = typeof letterTemplate.$inferSelect;
type VersionRow = typeof letterTemplateVersion.$inferSelect;

const stateConflict = (detail: string) => new HttpProblem(409, "invalid_state", detail);

const refused = (problem: HttpProblem, action: string, id: string | null, reason: string) =>
  new AuditedRefusal(problem, {
    action,
    outcome: "denied",
    resourceType: "letter_template",
    ...(id ? { resourceId: id } : {}),
    reason,
  });

/** Runs a change; refusals, the database's own included (403, 409, 422), are audited. */
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
    if (!code || !["42501", "23000", "23514", "23505"].includes(code)) throw error;
    await writeAudit(c.get("services").appPool, access, {
      action,
      outcome: "denied",
      resourceType: "letter_template",
      ...(id ? { resourceId: id } : {}),
      reason: code === "42501" ? "refused_by_database" : "invalid_state",
      requestId: c.get("requestId"),
    });
    if (code === "42501") throw problems.forbidden();
    if (code === "23505") throw stateConflict("A draft of this template is already open.");
    if (code === "23514")
      throw problems.invalid("The template does not fit its channel or limits.");
    throw stateConflict("The template cannot be changed like that now. Reload it and try again.");
  }
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** The domain's view of a stored version. */
export const domainVersion = (template: TemplateRow, row: VersionRow): TemplateVersion => ({
  id: row.id,
  templateId: row.templateId,
  version: row.versionNumber,
  name: row.name,
  state: row.state as TemplateVersionState,
  kind: template.kind as TemplateKind,
  channel: template.channel as TemplateChannel,
  subject: row.subject,
  body: row.body,
  authorId: row.authorId,
  contributorIds: row.contributorIds,
  approvedBy: row.approvedBy,
  approvedAt: row.approvedAt,
});

function versionItem(template: TemplateRow, row: VersionRow) {
  const check = checkTemplateDefinition(domainVersion(template, row));
  return {
    id: row.id,
    templateId: row.templateId,
    versionNumber: row.versionNumber,
    state: row.state as TemplateVersionState,
    name: row.name,
    subject: row.subject,
    body: row.body,
    authorId: row.authorId,
    contributorIds: row.contributorIds,
    approvedBy: row.approvedBy,
    approvedAt: iso(row.approvedAt),
    retiredAt: iso(row.retiredAt),
    retirementReason: row.retirementReason,
    discardReason: row.discardReason,
    issues: check.issues.map((i) => ({
      problem: i.problem,
      field: i.subjectText,
      message: i.message,
    })),
    personalDataFields: [...check.personalDataFields],
    styleWarnings: templateStyleWarnings({ name: row.name, body: row.body }).map((w) => w.message),
    version: row.version,
  };
}

async function templateItem(tx: Transaction, template: TemplateRow) {
  const versions = await tx
    .select()
    .from(letterTemplateVersion)
    .where(
      and(
        eq(letterTemplateVersion.templateId, template.id),
        inArray(letterTemplateVersion.state, ["approved", "draft"]),
      ),
    );
  const current = versions.find((v) => v.state === "approved");
  const draft = versions.find((v) => v.state === "draft");
  return {
    id: template.id,
    kind: template.kind as TemplateKind,
    channel: template.channel as TemplateChannel,
    currentVersionId: template.currentVersionId,
    current: current ? versionItem(template, current) : null,
    draft: draft ? versionItem(template, draft) : null,
    version: template.version,
  };
}

/** The template and one of its versions, or a refusal (not found reads the same either way). */
async function versionFor(
  tx: Transaction,
  action: string,
  templateId: string,
  versionId: string,
  expect: { version?: number; state?: TemplateVersionState },
): Promise<{ template: TemplateRow; row: VersionRow }> {
  const [template] = await tx
    .select()
    .from(letterTemplate)
    .where(eq(letterTemplate.id, templateId));
  const [row] = await tx
    .select()
    .from(letterTemplateVersion)
    .where(
      and(
        eq(letterTemplateVersion.id, versionId),
        eq(letterTemplateVersion.templateId, templateId),
      ),
    );
  if (!template || !row) throw refused(problems.notFound(), action, templateId, "not_found");
  if (expect.version !== undefined && row.version !== expect.version) {
    throw refused(problems.conflict(), action, templateId, "version_conflict");
  }
  if (expect.state !== undefined && row.state !== expect.state) {
    throw refused(
      stateConflict(
        expect.state === "draft"
          ? "Only a draft can be changed. Start a new draft from the version in use."
          : "Only the version in use can be retired.",
      ),
      action,
      templateId,
      `not_${expect.state}`,
    );
  }
  return { template, row };
}

/**
 * The version row exactly as the caller loaded it: an edit that lands between the read and this
 * write changes `version`, so the write matches nothing (#70 review, HZ-051).
 */
const sameVersion = (versionId: string, version: number) =>
  and(eq(letterTemplateVersion.id, versionId), eq(letterTemplateVersion.version, version));

/** Someone changed the version after it was read: refused and audited, nothing written. */
const staleVersion = (action: string, id: string) =>
  refused(problems.conflict(), action, id, "version_conflict");

const IdParam = z.object({ id: z.uuid() });
const VersionParam = z.object({ id: z.uuid(), versionId: z.uuid() });

export const letterTemplatesRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/merge-fields",
      tags: ["comms"],
      summary: "The merge fields a template may use",
      description:
        "The catalogue (MERGE_FIELDS): each field's type, data class and where it may go. Nothing else can be merged. Holders of comms.template.write, .approve or comms.letter.manage.",
      security,
      responses: { 200: jsonBody(MergeFieldList, "Merge fields"), ...errorResponses },
    }),
    async (c) => {
      await requireAnyPermission(c, READERS);
      const items = Object.entries(MERGE_FIELDS).map(([key, f]) => ({
        key,
        label: f.label,
        type: f.type,
        dataClass: f.dataClass,
        personBound: f.personBound,
        multiLine: f.multiLine,
        notInEmail: f.notInEmail,
      }));
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/letter-templates",
      tags: ["comms"],
      summary: "Letter and email templates",
      description:
        "Each template with the version in use and its open draft, each with its problems, personal-data fields and plain-English suggestions. Holders of comms.template.write, .approve or comms.letter.manage anywhere in the organisation.",
      security,
      responses: { 200: jsonBody(LetterTemplateList, "Templates"), ...errorResponses },
    }),
    async (c) => {
      await requireAnyPermission(c, READERS);
      const items = await withTenant(c, async (tx) => {
        const rows = await tx.select().from(letterTemplate).orderBy(asc(letterTemplate.createdAt));
        const out = [];
        for (const row of rows) out.push(await templateItem(tx, row));
        return out;
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/letter-templates",
      tags: ["comms"],
      summary: "Make a template with its first draft",
      description:
        "comms.template.write. Kind and channel are fixed once made; incident follow-up and duty of candour templates are letters only. The draft is saved with its problems listed; it needs none to be approved. Audited.",
      security,
      request: { body: { content: { "application/json": { schema: CreateLetterTemplate } } } },
      responses: {
        201: jsonBody(LetterTemplateItem, "Made"),
        ...errorResponses,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, WRITE);
      const body = c.req.valid("json");
      const item = await change(c, access, A.drafted, null, async (tx) => {
        if (body.channel === "email" && LETTER_ONLY_KINDS.includes(body.kind)) {
          throw refused(
            problems.invalid(
              "Incident follow-up and duty of candour letters carry health details, so they are letters only.",
            ),
            A.drafted,
            null,
            "letter_only_kind",
          );
        }
        const [template] = await tx
          .insert(letterTemplate)
          .values({ kind: body.kind, channel: body.channel })
          .returning();
        if (!template) throw new Error("template not stored");
        const [row] = await tx
          .insert(letterTemplateVersion)
          .values({
            templateId: template.id,
            versionNumber: 0,
            name: body.name,
            subject: body.channel === "email" ? body.subject : null,
            body: body.body,
            authorId: access.tenantUserId,
          })
          .returning();
        await audit(c, tx, access, {
          action: A.drafted,
          resourceType: "letter_template",
          resourceId: template.id,
          scope: { versionId: row?.id, kind: body.kind, channel: body.channel },
        });
        return templateItem(tx, template);
      });
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/letter-templates/{id}/versions",
      tags: ["comms"],
      summary: "A template's versions, newest first",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(LetterTemplateVersionList, "Versions"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      await requireAnyPermission(c, READERS);
      const { id } = c.req.valid("param");
      const items = await withTenant(c, async (tx) => {
        const [template] = await tx.select().from(letterTemplate).where(eq(letterTemplate.id, id));
        if (!template) return null;
        const rows = await tx
          .select()
          .from(letterTemplateVersion)
          .where(eq(letterTemplateVersion.templateId, id))
          .orderBy(desc(letterTemplateVersion.versionNumber));
        return rows.map((r) => versionItem(template, r));
      });
      if (!items) throw problems.notFound();
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/letter-templates/{id}/versions",
      tags: ["comms"],
      summary: "Start a new draft from the version in use",
      description:
        "comms.template.write. The approved version stays in use until the new draft is approved (rule 23). One draft at a time. Audited.",
      security,
      request: { params: IdParam },
      responses: {
        201: jsonBody(LetterTemplateVersionItem, "Drafted"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, WRITE);
      const { id } = c.req.valid("param");
      const item = await change(c, access, A.drafted, id, async (tx) => {
        const [template] = await tx.select().from(letterTemplate).where(eq(letterTemplate.id, id));
        if (!template) throw refused(problems.notFound(), A.drafted, id, "not_found");
        const [from] = await tx
          .select()
          .from(letterTemplateVersion)
          .where(eq(letterTemplateVersion.templateId, id))
          .orderBy(
            desc(eq(letterTemplateVersion.state, "approved")),
            desc(letterTemplateVersion.versionNumber),
          )
          .limit(1);
        if (!from) throw refused(problems.notFound(), A.drafted, id, "no_version");
        const [row] = await tx
          .insert(letterTemplateVersion)
          .values({
            templateId: id,
            versionNumber: 0,
            name: from.name,
            subject: from.subject,
            body: from.body,
            authorId: access.tenantUserId,
          })
          .returning();
        if (!row) throw new Error("version not stored");
        await audit(c, tx, access, {
          action: A.drafted,
          resourceType: "letter_template",
          resourceId: id,
          scope: { versionId: row.id, from: from.id },
        });
        return versionItem(template, row);
      });
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/letter-templates/{id}/versions/{versionId}",
      tags: ["comms"],
      summary: "Change a draft",
      description:
        "comms.template.write, drafts only, against the version you loaded. You join its contributors, so you cannot approve it. Audited.",
      security,
      request: {
        params: VersionParam,
        body: { content: { "application/json": { schema: EditTemplateVersion } } },
      },
      responses: {
        200: jsonBody(LetterTemplateVersionItem, "Saved"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, WRITE);
      const { id, versionId } = c.req.valid("param");
      const body = c.req.valid("json");
      const item = await change(c, access, A.edited, id, async (tx) => {
        const { template } = await versionFor(tx, A.edited, id, versionId, {
          version: body.version,
          state: "draft",
        });
        const [row] = await tx
          .update(letterTemplateVersion)
          .set({
            name: body.name,
            subject: template.channel === "email" ? body.subject : null,
            body: body.body,
          })
          .where(sameVersion(versionId, body.version))
          .returning();
        if (!row) throw staleVersion(A.edited, id);
        await audit(c, tx, access, {
          action: A.edited,
          resourceType: "letter_template",
          resourceId: id,
          scope: { versionId },
        });
        return versionItem(template, row);
      });
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/letter-templates/{id}/versions/{versionId}/approve",
      tags: ["comms"],
      summary: "Approve a draft",
      description:
        "comms.template.approve, never by its author or anyone who edited it (rule 22); only a draft with no problems that differs from the version in use. It supersedes that version and is used from now on. Audited.",
      security,
      request: {
        params: VersionParam,
        body: { content: { "application/json": { schema: ApproveTemplateVersion } } },
      },
      responses: {
        200: jsonBody(LetterTemplateVersionItem, "Approved"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, APPROVE);
      const { id, versionId } = c.req.valid("param");
      const body = c.req.valid("json");
      const item = await change(c, access, A.approved, id, async (tx) => {
        const { template, row } = await versionFor(tx, A.approved, id, versionId, {
          version: body.version,
        });
        const [current] = await tx
          .select()
          .from(letterTemplateVersion)
          .where(
            and(
              eq(letterTemplateVersion.templateId, id),
              eq(letterTemplateVersion.state, "approved"),
            ),
          );
        const found = checkTemplateApproval(
          domainVersion(template, row),
          current ? domainVersion(template, current) : null,
          { id: access.tenantUserId, permissions: usablePermissions(access) },
        );
        if (found.length > 0) {
          const detail = found.map((p) => TEMPLATE_APPROVAL_MESSAGES[p]).join(" ");
          const problem = found.includes("author_cannot_approve")
            ? new HttpProblem(
                403,
                "separation_of_duties",
                "You cannot approve this version.",
                detail,
              )
            : found.includes("invalid_template")
              ? problems.invalid(detail)
              : stateConflict(detail);
          throw refused(problem, A.approved, id, found.join(","));
        }
        const [approved] = await tx
          .update(letterTemplateVersion)
          .set({ state: "approved", approvedBy: access.tenantUserId, approvedAt: new Date() })
          .where(sameVersion(versionId, body.version))
          .returning();
        if (!approved) throw staleVersion(A.approved, id);
        await audit(c, tx, access, {
          action: A.approved,
          resourceType: "letter_template",
          resourceId: id,
          scope: { versionId, supersedes: current?.id ?? null },
        });
        return versionItem(template, approved);
      });
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/letter-templates/{id}/versions/{versionId}/retire",
      tags: ["comms"],
      summary: "Retire the version in use",
      description:
        "comms.template.approve, with a reason. The template is not used until another version is approved. Audited.",
      security,
      request: {
        params: VersionParam,
        body: { content: { "application/json": { schema: EndTemplateVersion } } },
      },
      responses: {
        200: jsonBody(LetterTemplateVersionItem, "Retired"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, APPROVE);
      const { id, versionId } = c.req.valid("param");
      const body = c.req.valid("json");
      const item = await change(c, access, A.retired, id, async (tx) => {
        const { template } = await versionFor(tx, A.retired, id, versionId, {
          version: body.version,
          state: "approved",
        });
        const [row] = await tx
          .update(letterTemplateVersion)
          .set({
            state: "retired",
            retiredBy: access.tenantUserId,
            retiredAt: new Date(),
            retirementReason: body.reason,
          })
          .where(sameVersion(versionId, body.version))
          .returning();
        if (!row) throw staleVersion(A.retired, id);
        await audit(c, tx, access, {
          action: A.retired,
          resourceType: "letter_template",
          resourceId: id,
          scope: { versionId },
          reason: "retired",
        });
        return versionItem(template, row);
      });
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/letter-templates/{id}/versions/{versionId}/discard",
      tags: ["comms"],
      summary: "Discard a draft",
      description: "comms.template.write, with a reason. Audited.",
      security,
      request: {
        params: VersionParam,
        body: { content: { "application/json": { schema: EndTemplateVersion } } },
      },
      responses: {
        200: jsonBody(LetterTemplateVersionItem, "Discarded"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, WRITE);
      const { id, versionId } = c.req.valid("param");
      const body = c.req.valid("json");
      const item = await change(c, access, A.discarded, id, async (tx) => {
        const { template } = await versionFor(tx, A.discarded, id, versionId, {
          version: body.version,
          state: "draft",
        });
        const [row] = await tx
          .update(letterTemplateVersion)
          .set({ state: "discarded", discardReason: body.reason })
          .where(sameVersion(versionId, body.version))
          .returning();
        if (!row) throw staleVersion(A.discarded, id);
        await audit(c, tx, access, {
          action: A.discarded,
          resourceType: "letter_template",
          resourceId: id,
          scope: { versionId },
          reason: "discarded",
        });
        return versionItem(template, row);
      });
      return c.json(item, 200);
    },
  );
