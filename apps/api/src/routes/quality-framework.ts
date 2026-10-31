import {
  CreateEvidenceLink,
  EvidenceCoverage,
  EvidenceLinkItem,
  EvidenceLinkList,
  FrameworkMappingView,
  FrameworkVersionDetail,
  FrameworkVersionList,
  RemoveEvidenceLink,
  SaveFrameworkMapping,
} from "@harbour/contracts";
import { evidenceLink, frameworkMapping, type Transaction } from "@harbour/db";
import {
  checkEvidenceTag,
  checkMappingChange,
  EVIDENCE_TAG_MESSAGES,
  evidenceCoverage,
  type FrameworkMapping,
  MAPPING_MESSAGES,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, arrayContains, desc, eq, isNull, sql } from "drizzle-orm";
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
  EVIDENCE_RECORD_TABLES,
  type FrameworkContent,
  frameworkContent,
  frameworkSummaries,
  linkItem,
} from "../services/quality-framework";
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
 * The compliance framework and the evidence library (quality.md section 18; QUAL-001, QUAL-002;
 * ADR-0096; migration 0076). Framework versions are global and read by anyone who works with
 * quality evidence; the organisation's mapping and its evidence links are the quality lead's
 * (`quality.evidence.manage`). The domain's rules run first (`checkMappingChange`,
 * `checkEvidenceTag`); the database holds the same line. Every change, and every refusal, is
 * audited.
 */

const MANAGE = "quality.evidence.manage";
/** Who may read the framework itself: anyone who works with quality evidence. */
const READERS = [
  MANAGE,
  "quality.audit.manage",
  "quality.policy.manage",
  "quality.evidence_pack.compose",
  "quality.evidence_pack.release",
] as const;
const A = {
  mapped: "quality.framework.mapping_changed",
  tagged: "quality.evidence.tagged",
  untagged: "quality.evidence.untagged",
} as const;
const SOURCE = "evidence_link";

const IdParam = z.object({ id: z.uuid() });

const refused = (problem: HttpProblem, action: string, id: string | null, reason: string) =>
  new AuditedRefusal(problem, {
    action,
    outcome: "denied",
    resourceType: action === A.mapped ? "framework_mapping" : SOURCE,
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
      resourceType: action === A.mapped ? "framework_mapping" : SOURCE,
      ...(id ? { resourceId: id } : {}),
      reason: code === "42501" ? "refused_by_database" : "invalid_state",
      requestId: c.get("requestId"),
    });
    throw code === "42501"
      ? problems.forbidden()
      : new HttpProblem(
          409,
          "invalid_state",
          "This changed since you read it. Reload and try again.",
        );
  }
}

/** A framework version's content, or 404 (audited by the caller's action). */
async function contentFor(
  tx: Transaction,
  id: string,
  action: string | null,
): Promise<FrameworkContent> {
  const found = await frameworkContent(tx, id);
  if (found) return found;
  if (action) throw refused(problems.notFound(), action, id, "framework_not_found");
  throw problems.notFound();
}

const mappingRow = (row: typeof frameworkMapping.$inferSelect): FrameworkMapping => ({
  frameworkVersionId: row.frameworkVersionId,
  version: row.mappingVersion,
  entries: row.entries as FrameworkMapping["entries"],
  madeBy: row.madeBy,
  madeAt: row.madeAt.toISOString(),
});

export const qualityFrameworkRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/quality/frameworks",
      tags: ["quality"],
      summary: "Compliance framework versions",
      description:
        "Global reference data: every framework version (CQC's single assessment framework now, KLOE-based and devolved-nation frameworks as later versions), each marked when it is the one in force today for its regulator. For anyone who works with quality evidence.",
      security,
      responses: { 200: jsonBody(FrameworkVersionList, "Framework versions"), ...errorResponses },
    }),
    async (c) => {
      await requireAnyPermission(c, READERS);
      const items = await withTenant(c, (tx) => frameworkSummaries(tx, new Date()));
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/quality/frameworks/{id}",
      tags: ["quality"],
      summary: "A framework version's key questions, statements and evidence categories",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(FrameworkVersionDetail, "The framework version"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      await requireAnyPermission(c, READERS);
      const { id } = c.req.valid("param");
      const detail = await withTenant(c, async (tx) => (await contentFor(tx, id, null)).detail);
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/quality/frameworks/{id}/mapping",
      tags: ["quality"],
      summary: "The organisation's mapping of a framework version",
      description:
        "quality.evidence.manage. The latest mapping version, or the one in force at `at` (rule 5), so a past audit is read with the mapping of its time; version 0 with no entries when the organisation has not mapped it.",
      security,
      request: {
        params: IdParam,
        query: z.object({ at: z.iso.datetime({ offset: true }).optional() }),
      },
      responses: {
        200: jsonBody(FrameworkMappingView, "The mapping"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const { at } = c.req.valid("query");
      const view = await withTenant(c, async (tx) => {
        await contentFor(tx, id, null);
        const rows = await tx
          .select()
          .from(frameworkMapping)
          .where(eq(frameworkMapping.frameworkVersionId, id))
          .orderBy(desc(frameworkMapping.mappingVersion));
        const mappings = rows.map(mappingRow);
        const current = at
          ? mappings.find((m) => Date.parse(m.madeAt) <= Date.parse(at))
          : mappings[0];
        return {
          frameworkVersionId: id,
          mappingVersion: current?.version ?? 0,
          entries: (current?.entries ?? []).map((e) => ({
            ...e,
            evidenceCategoryIds: [...e.evidenceCategoryIds],
          })),
          madeBy: current?.madeBy ?? null,
          madeAt: current?.madeAt ?? null,
        };
      });
      return c.json(view, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/quality/frameworks/{id}/mapping",
      tags: ["quality"],
      summary: "Save a new version of the organisation's mapping",
      description:
        "quality.evidence.manage. A new mapping version, the one read plus one (409 otherwise), naming only statements and evidence categories of a published framework version, each statement once (rule 5). Earlier versions stay. Audited.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: SaveFrameworkMapping } } },
      },
      responses: {
        201: jsonBody(FrameworkMappingView, "Saved"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const saved = await change(c, access, A.mapped, id, async (tx) => {
        const framework = await contentFor(tx, id, A.mapped);
        if (framework.domain.state !== "published") {
          throw refused(
            new HttpProblem(409, "invalid_state", "Map only the framework in use."),
            A.mapped,
            id,
            "framework_not_published",
          );
        }
        const previous = (
          await tx
            .select()
            .from(frameworkMapping)
            .where(eq(frameworkMapping.frameworkVersionId, id))
        ).map(mappingRow);
        const entries = body.entries.map((e) => ({
          statementId: e.statementId,
          localTitle: e.localTitle,
          ownerRole: e.ownerRole,
          evidenceCategoryIds: e.evidenceCategoryIds,
        }));
        const problemsFound = checkMappingChange(
          previous,
          {
            frameworkVersionId: id,
            version: body.mappingVersion,
            entries,
            madeBy: access.tenantUserId,
          },
          framework.domain,
          [...usablePermissions(access, new Date())],
        );
        if (problemsFound.includes("version_not_next")) {
          throw refused(problems.conflict(), A.mapped, id, "version_conflict");
        }
        if (problemsFound.length > 0) {
          throw refused(
            problems.invalid(problemsFound.map((p) => MAPPING_MESSAGES[p]).join(" ")),
            A.mapped,
            id,
            problemsFound.join(","),
          );
        }
        const [row] = await tx
          .insert(frameworkMapping)
          .values({
            frameworkVersionId: id,
            mappingVersion: body.mappingVersion,
            entries,
            madeBy: access.tenantUserId,
          })
          .returning();
        if (!row) throw new Error("mapping not stored");
        await audit(c, tx, access, {
          action: A.mapped,
          resourceType: "framework_mapping",
          resourceId: row.id,
          scope: {
            frameworkVersionId: id,
            mappingVersion: row.mappingVersion,
            entries: entries.length,
          },
        });
        const m = mappingRow(row);
        return {
          frameworkVersionId: id,
          mappingVersion: m.version,
          entries: m.entries.map((e) => ({
            ...e,
            evidenceCategoryIds: [...e.evidenceCategoryIds],
          })),
          madeBy: m.madeBy,
          madeAt: m.madeAt,
        };
      });
      return c.json(saved, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/quality/frameworks/{id}/coverage",
      tags: ["quality"],
      summary: "How many records evidence each statement, and the gaps",
      description:
        "quality.evidence.manage. Each statement of the version with the number of records tagged against it (each record once), and the statements with none (rule 7). Removed tags do not count.",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(EvidenceCoverage, "Coverage"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const coverage = await withTenant(c, async (tx) => {
        const framework = await contentFor(tx, id, null);
        const tags = await tx
          .select({
            recordType: evidenceLink.recordType,
            recordId: evidenceLink.recordId,
            frameworkVersionId: evidenceLink.frameworkVersionId,
            statementIds: evidenceLink.statementIds,
          })
          .from(evidenceLink)
          .where(and(eq(evidenceLink.frameworkVersionId, id), isNull(evidenceLink.removedAt)));
        return evidenceCoverage(tags, framework.domain);
      });
      return c.json({ frameworkVersionId: id, ...coverage }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/evidence-links",
      tags: ["quality"],
      summary: "Evidence links for a record, or for a statement",
      description:
        "quality.evidence.manage. By record (`recordType` and `recordId`) or by statement (`frameworkVersionId` and `statementId`); removed links are included, marked, so the history is visible. Newest first, at most 500.",
      security,
      request: {
        query: z.object({
          recordType: z
            .string()
            .regex(/^[a-z_]{1,40}$/)
            .optional(),
          recordId: z.uuid().optional(),
          frameworkVersionId: z.uuid().optional(),
          statementId: z
            .string()
            .regex(/^[A-Za-z0-9._-]{1,64}$/)
            .optional(),
        }),
      },
      responses: { 200: jsonBody(EvidenceLinkList, "Evidence links"), ...errorResponses },
    }),
    async (c) => {
      await requirePermission(c, MANAGE);
      const q = c.req.valid("query");
      const byRecord = q.recordType !== undefined && q.recordId !== undefined;
      const byStatement = q.frameworkVersionId !== undefined && q.statementId !== undefined;
      if (byRecord === byStatement) {
        throw problems.invalid(
          "Ask by record (type and id) or by statement (framework and statement).",
        );
      }
      const rows = await withTenant(c, (tx) =>
        tx
          .select()
          .from(evidenceLink)
          .where(
            byRecord
              ? and(
                  eq(evidenceLink.recordType, q.recordType as string),
                  eq(evidenceLink.recordId, q.recordId as string),
                )
              : and(
                  eq(evidenceLink.frameworkVersionId, q.frameworkVersionId as string),
                  arrayContains(evidenceLink.statementIds, [q.statementId as string]),
                ),
          )
          .orderBy(desc(evidenceLink.taggedAt))
          .limit(500),
      );
      return c.json({ items: rows.map(linkItem) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/evidence-links",
      tags: ["quality"],
      summary: "Tag a record as evidence",
      description:
        "quality.evidence.manage. The record is read in your own scope (one you cannot see reads as not found); its statements must be in the named framework version, which must be the published one (rule 6). Restricted records (speak-up, employee relations casework, legal advice) are never evidence. Record types whose tables later slices add (audits, compliments, policies, surveys) are accepted once those slices register them. Audited.",
      security,
      request: { body: { content: { "application/json": { schema: CreateEvidenceLink } } } },
      responses: {
        201: jsonBody(EvidenceLinkItem, "Tagged"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const body = c.req.valid("json");
      const created = await change(c, access, A.tagged, null, async (tx) => {
        const framework = await contentFor(tx, body.frameworkVersionId, A.tagged);
        const problemsFound = checkEvidenceTag({ ...body, restricted: false }, framework.domain, [
          ...usablePermissions(access, new Date()),
        ]);
        if (problemsFound.length > 0) {
          throw refused(
            problems.invalid(problemsFound.map((p) => EVIDENCE_TAG_MESSAGES[p]).join(" ")),
            A.tagged,
            null,
            problemsFound.join(","),
          );
        }
        const table = EVIDENCE_RECORD_TABLES[body.recordType];
        if (!table) {
          throw refused(
            new HttpProblem(
              422,
              "record_type_not_available",
              "This kind of record cannot be tagged yet. It can be once its records are in Harbour.",
            ),
            A.tagged,
            null,
            "record_type_not_available",
          );
        }
        // Read in the tagger's own scope: a record they cannot see reads as not found.
        const { rows } = await tx.execute<{ id: string }>(
          sql`SELECT id FROM ${sql.identifier(table)} WHERE id = ${body.recordId}`,
        );
        if (rows.length === 0) {
          throw refused(problems.notFound(), A.tagged, null, "record_not_found_or_out_of_scope");
        }
        const [row] = await tx
          .insert(evidenceLink)
          .values({
            recordType: body.recordType,
            recordId: body.recordId,
            frameworkVersionId: body.frameworkVersionId,
            statementIds: [...new Set(body.statementIds)],
            taggedBy: access.tenantUserId,
          })
          .returning();
        if (!row) throw new Error("evidence link not stored");
        await audit(c, tx, access, {
          action: A.tagged,
          resourceType: SOURCE,
          resourceId: row.id,
          scope: {
            recordType: row.recordType,
            recordId: row.recordId,
            frameworkVersionId: row.frameworkVersionId,
            statements: row.statementIds,
          },
        });
        return linkItem(row);
      });
      return c.json(created, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/evidence-links/{id}/remove",
      tags: ["quality"],
      summary: "Remove an evidence tag",
      description:
        "quality.evidence.manage, with a reason, against the version you read. The link stays, marked removed with who and why; it no longer counts as evidence. Audited.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: RemoveEvidenceLink } } },
      },
      responses: {
        200: jsonBody(EvidenceLinkItem, "Removed"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const removed = await change(c, access, A.untagged, id, async (tx) => {
        const [row] = await tx.select().from(evidenceLink).where(eq(evidenceLink.id, id));
        if (!row) throw refused(problems.notFound(), A.untagged, id, "not_found");
        if (row.version !== body.version) {
          throw refused(problems.conflict(), A.untagged, id, "version_conflict");
        }
        if (row.removedAt !== null) {
          throw refused(
            new HttpProblem(409, "invalid_state", "This tag has already been removed."),
            A.untagged,
            id,
            "already_removed",
          );
        }
        const [updated] = await tx
          .update(evidenceLink)
          .set({
            removedAt: new Date(),
            removedBy: access.tenantUserId,
            removalReason: body.reason,
          })
          .where(and(eq(evidenceLink.id, id), eq(evidenceLink.version, body.version)))
          .returning();
        if (!updated) throw refused(problems.conflict(), A.untagged, id, "version_conflict");
        await audit(c, tx, access, {
          action: A.untagged,
          resourceType: SOURCE,
          resourceId: id,
          scope: { recordType: row.recordType, recordId: row.recordId },
        });
        return linkItem(updated);
      });
      return c.json(removed, 200);
    },
  );
