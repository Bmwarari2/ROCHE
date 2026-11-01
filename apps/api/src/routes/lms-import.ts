import { createHash } from "node:crypto";
import {
  ChangeLmsCourseMap,
  CommitLmsImport,
  EndLmsSource,
  LmsCommitResult,
  LmsCourseMapItem,
  LmsCourseMapList,
  LmsImportDetail,
  LmsImportList,
  LmsImportVersion,
  LmsLearnerLinkItem,
  LmsLearnerLinkList,
  LmsSourceItem,
  LmsSourceList,
  NewLmsCourseMap,
  NewLmsImport,
  NewLmsLearnerLink,
  NewLmsSource,
  SkipLmsRow,
} from "@harbour/contracts";
import {
  lmsCourseMap,
  lmsImport,
  lmsImportRow,
  lmsLearnerLink,
  lmsSource,
  type Transaction,
  trainingRecord,
} from "@harbour/db";
import {
  checkCourseMapping,
  classifyLmsRows,
  countLmsClasses,
  type LmsClassified,
  type LmsClassifyContext,
  type LmsCompletionInput,
  type LmsParseResult,
  type LmsStagedRow,
  lmsDryRunFingerprint,
  type OliverMcGowanTier,
  parseLmsCsv,
  parseLmsJson,
  stageLmsRow,
  type TrainingTopic,
  trainingKey,
  ukIsoDate,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Context } from "hono";
import { AuditedRefusal, withAuditedRefusal, writeAudit } from "../http/audit";
import { type AppEnv, requirePermission, type TenantAccess, withTenant } from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import {
  LearningPlatformNotConnected,
  LearningPlatformUnavailable,
} from "../integrations/lms/learning-platform";
import { endDevelopmentReminders } from "../services/development";
import { destroyingOnFailure, imagePrintableOf, storeDocument } from "../services/documents";
import { fileBody } from "./documents";
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
 * Imports of external training records from a learning platform (workforce.md section 13;
 * WORK-006, slice 78; ADR-0102). Holders of workforce.training.manage set up a source, map its
 * course codes to training topics and link its learner ids to members of staff (never by name).
 * A file or a pull is staged and classified by a dry run; a commit names the dry run it follows
 * and imports only its ready rows, as new training records marked with their source. Nobody
 * imports their own record, and a record made in Harbour is never changed. The database holds the
 * same rules (migration 0132). Audit events carry ids and counts only.
 */

const TRAINING = "workforce.training.manage";
const A = {
  sourceCreated: "workforce.lms_source.created",
  sourceEnded: "workforce.lms_source.ended",
  courseMapped: "workforce.lms_course.mapped",
  courseChanged: "workforce.lms_course.changed",
  learnerLinked: "workforce.lms_learner.linked",
  learnerUnlinked: "workforce.lms_learner.unlinked",
  staged: "workforce.lms_import.staged",
  dryRun: "workforce.lms_import.dry_run",
  committed: "workforce.lms_import.committed",
  discarded: "workforce.lms_import.discarded",
  skipped: "workforce.lms_import.row_skipped",
  imported: "workforce.training.imported",
  certificate: "workforce.training_certificate.added",
} as const;
const RESOURCE = "lms_import";

/**
 * Most certificates one commit fetches and scans in its request (security review M3); the rest are
 * counted, and added from their training records (H-1256 moves fetching to the job queue).
 */
const CERTIFICATES_PER_COMMIT = 50;

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const refused = (problem: HttpProblem, action: string, id: string | null, reason: string) =>
  new AuditedRefusal(problem, {
    action,
    outcome: "denied",
    resourceType: RESOURCE,
    ...(id ? { resourceId: id } : {}),
    reason,
  });

/** The database's own words for a refusal (a RAISE): never a failed query's message. */
function raisedMessage(error: unknown): string | undefined {
  const e = error as { message?: string; cause?: { message?: string } };
  return e.cause?.message ?? e.message;
}

const RAISED: Readonly<Record<string, HttpProblem>> = {
  lms_source_ended: new HttpProblem(409, "source_ended", "This learning platform has been ended."),
  lms_import_closed: new HttpProblem(409, "import_closed", "This import is closed."),
  lms_import_row_resolved: new HttpProblem(409, "row_resolved", "That row is already done."),
  training_record_import_mismatch: new HttpProblem(
    409,
    "dry_run_stale",
    "Something changed since the dry run. Run it again.",
  ),
};

/** Runs a change; refusals and the database's own are audited and said plainly. */
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
    if (!["42501", "23505", "23503", "23514"].includes(code ?? "")) throw error;
    await writeAudit(c.get("services").appPool, access, {
      action,
      outcome: "denied",
      resourceType: RESOURCE,
      ...(id ? { resourceId: id } : {}),
      reason: code === "42501" ? "refused_by_database" : `invalid_${code}`,
      requestId: c.get("requestId"),
    });
    if (code === "42501") throw problems.forbidden();
    if (code === "23505") throw problems.conflict("That is already recorded.");
    if (code === "23503") throw problems.notFound();
    const raised = RAISED[raisedMessage(error) ?? ""];
    if (raised) throw raised;
    throw problems.invalid("Those details cannot be saved together.");
  }
}

type SourceRow = typeof lmsSource.$inferSelect;
type ImportRow = typeof lmsImport.$inferSelect;
type RowRow = typeof lmsImportRow.$inferSelect;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

const sourceItem = (r: SourceRow): z.infer<typeof LmsSourceItem> => ({
  id: r.id,
  version: r.version,
  name: r.name,
  kind: r.kind as "file" | "api",
  externalOrganisationId: r.externalOrganisationId,
  status: r.status as "active" | "ended",
  endedAt: iso(r.endedAt),
});

const courseItem = (r: typeof lmsCourseMap.$inferSelect): z.infer<typeof LmsCourseMapItem> => ({
  id: r.id,
  version: r.version,
  courseCode: r.courseCode,
  topic: r.topic as TrainingTopic,
  tier: r.tier,
  active: r.active,
});

const linkItem = (r: typeof lmsLearnerLink.$inferSelect): z.infer<typeof LmsLearnerLinkItem> => ({
  id: r.id,
  learnerId: r.learnerId,
  workerId: r.workerId,
  linkedBy: r.linkedBy,
});

const importItem = (r: ImportRow) => ({
  id: r.id,
  version: r.version,
  sourceId: r.sourceId,
  format: r.format as "csv" | "json" | "api",
  rowCount: r.rowCount,
  contentSha256: r.contentSha256,
  status: r.status as "open" | "closed" | "discarded",
  dryRunNumber: r.dryRunNumber,
  dryRunAt: iso(r.dryRunAt),
  dryRunCounts: (r.dryRunCounts ?? null) as Record<string, number> | null,
  uploadedBy: r.uploadedBy,
  uploadedAt: r.uploadedAt.toISOString(),
  closedAt: iso(r.closedAt),
});

const rowItem = (r: RowRow) => ({
  id: r.id,
  rowNumber: r.rowNumber,
  learnerId: r.learnerId,
  courseCode: r.courseCode,
  completedOn: r.completedOn,
  expiresOn: r.expiresOn,
  recordId: r.recordId,
  problems: r.problems,
  class: r.class as z.infer<typeof LmsImportDetail>["rows"][number]["class"],
  workerId: r.workerId,
  topic: r.topic as TrainingTopic | null,
  tier: r.tier,
  outcome: r.outcome as "pending" | "imported" | "skipped",
  trainingRecordId: r.trainingRecordId,
  skipReason: r.skipReason,
});

/**
 * A source, locked when `lock` is set: commits, links and mappings of one source take turns, so
 * a commit never imports by a link or mapping changed under it (security review M1).
 */
async function sourceOf(tx: Transaction, id: string, lock = false): Promise<SourceRow> {
  const query = tx
    .select()
    .from(lmsSource)
    .where(and(eq(lmsSource.id, id), isNull(lmsSource.deletedAt)));
  const [row] = lock ? await query.for("update") : await query;
  if (!row) throw problems.notFound();
  return row;
}

async function detailOf(tx: Transaction, id: string): Promise<z.infer<typeof LmsImportDetail>> {
  const [imp] = await tx.select().from(lmsImport).where(eq(lmsImport.id, id));
  if (!imp) throw problems.notFound();
  const rows = await tx
    .select()
    .from(lmsImportRow)
    .where(eq(lmsImportRow.importId, id))
    .orderBy(asc(lmsImportRow.rowNumber));
  return { import: importItem(imp), rows: rows.map(rowItem) } as z.infer<typeof LmsImportDetail>;
}

const stagedOf = (r: RowRow): LmsStagedRow => ({
  rowNumber: r.rowNumber,
  learnerId: r.learnerId,
  courseCode: r.courseCode,
  completedOn: r.completedOn,
  expiresOn: r.expiresOn,
  recordId: r.recordId,
  provider: r.provider,
  problems: r.problems as LmsStagedRow["problems"],
});

/** What the dry run reads (rule 4): this source's links and mappings, and what is recorded. */
async function classifyContext(
  tx: Transaction,
  sourceId: string,
  importerId: string,
): Promise<LmsClassifyContext> {
  const links = await tx
    .select({ learnerId: lmsLearnerLink.learnerId, workerId: lmsLearnerLink.workerId })
    .from(lmsLearnerLink)
    .where(and(eq(lmsLearnerLink.sourceId, sourceId), isNull(lmsLearnerLink.deletedAt)));
  const courses = await tx
    .select()
    .from(lmsCourseMap)
    .where(and(eq(lmsCourseMap.sourceId, sourceId), eq(lmsCourseMap.active, true)));
  const imported = await tx
    .select({ id: trainingRecord.externalRecordId })
    .from(trainingRecord)
    .where(
      and(eq(trainingRecord.lmsSourceId, sourceId), isNotNull(trainingRecord.externalRecordId)),
    );
  const workers = links.map((l) => l.workerId);
  const records = workers.length
    ? await tx
        .select({
          workerId: trainingRecord.workerId,
          topic: trainingRecord.topic,
          tier: trainingRecord.tier,
          completedOn: trainingRecord.completedOn,
        })
        .from(trainingRecord)
        .where(and(inArray(trainingRecord.workerId, workers), isNull(trainingRecord.deletedAt)))
    : [];
  const existing = new Map<string, Set<string>>();
  for (const r of records) {
    const keys = existing.get(r.workerId) ?? new Set<string>();
    keys.add(trainingKey(r.topic, r.tier, r.completedOn));
    existing.set(r.workerId, keys);
  }
  return {
    links: new Map(links.map((l) => [l.learnerId, l.workerId])),
    courses: new Map(
      courses.map((m) => [
        m.courseCode,
        { topic: m.topic as TrainingTopic, tier: (m.tier ?? null) as OliverMcGowanTier | null },
      ]),
    ),
    importedRecordIds: new Set(imported.flatMap((r) => (r.id ? [r.id] : []))),
    existing,
    importerId,
  };
}

/** Classifies an import's pending rows as things stand (rules 3 to 5). */
async function classifyPending(
  tx: Transaction,
  imp: ImportRow,
  importerId: string,
): Promise<{ rows: RowRow[]; classified: LmsClassified[] }> {
  const rows = await tx
    .select()
    .from(lmsImportRow)
    .where(and(eq(lmsImportRow.importId, imp.id), eq(lmsImportRow.outcome, "pending")))
    .orderBy(asc(lmsImportRow.rowNumber));
  const classified = classifyLmsRows(
    rows.map(stagedOf),
    await classifyContext(tx, imp.sourceId, importerId),
  );
  return { rows, classified };
}

/** Rule 4: a dry run. Each pending row's class is stored; the import counts one more dry run. */
async function dryRun(tx: Transaction, imp: ImportRow, importerId: string): Promise<ImportRow> {
  const { rows, classified } = await classifyPending(tx, imp, importerId);
  const byNumber = new Map(classified.map((c) => [c.rowNumber, c]));
  const changed = rows.flatMap((r) => {
    const c = byNumber.get(r.rowNumber);
    if (!c) return [];
    const same =
      r.class === c.class &&
      r.workerId === c.workerId &&
      r.topic === c.topic &&
      (r.tier ?? null) === c.tier;
    return same
      ? []
      : [{ id: r.id, class: c.class, worker_id: c.workerId, topic: c.topic, tier: c.tier }];
  });
  if (changed.length > 0) {
    await tx.execute(sql`
      UPDATE lms_import_row r
      SET class = v.class, worker_id = v.worker_id, topic = v.topic, tier = v.tier
      FROM jsonb_to_recordset(${JSON.stringify(changed)}::jsonb)
        AS v(id uuid, class text, worker_id uuid, topic text, tier integer)
      WHERE r.id = v.id`);
  }
  const [updated] = await tx
    .update(lmsImport)
    .set({
      dryRunNumber: imp.dryRunNumber + 1,
      dryRunCounts: countLmsClasses(classified),
      dryRunSha256: sha256(lmsDryRunFingerprint(classified)),
    })
    .where(eq(lmsImport.id, imp.id))
    .returning();
  if (!updated) throw new Error("dry run not recorded");
  return updated;
}

/** Closes an import once none of its rows is pending. */
async function closeIfDone(tx: Transaction, importId: string): Promise<void> {
  const [left] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(lmsImportRow)
    .where(and(eq(lmsImportRow.importId, importId), eq(lmsImportRow.outcome, "pending")));
  if ((left?.n ?? 0) === 0) {
    await tx.update(lmsImport).set({ status: "closed" }).where(eq(lmsImport.id, importId));
  }
}

/** Rule 2: stages an import's rows and runs its first dry run. */
async function stage(
  c: Context<AppEnv>,
  access: TenantAccess,
  tx: Transaction,
  source: SourceRow,
  format: "csv" | "json" | "api",
  contentSha256: string,
  rows: readonly LmsStagedRow[],
) {
  const [imp] = await tx
    .insert(lmsImport)
    .values({
      sourceId: source.id,
      format,
      rowCount: rows.length,
      contentSha256,
      uploadedBy: access.tenantUserId,
    })
    .returning();
  if (!imp) throw new Error("import not staged");
  for (let i = 0; i < rows.length; i += 500) {
    await tx.insert(lmsImportRow).values(
      rows.slice(i, i + 500).map((r) => ({
        importId: imp.id,
        rowNumber: r.rowNumber,
        learnerId: r.learnerId,
        courseCode: r.courseCode,
        completedOn: r.completedOn,
        expiresOn: r.expiresOn,
        recordId: r.recordId,
        provider: r.provider,
        problems: [...r.problems],
      })),
    );
  }
  const ran = await dryRun(tx, imp, access.tenantUserId);
  await audit(c, tx, access, {
    action: A.staged,
    resourceType: RESOURCE,
    resourceId: imp.id,
    scopeExtra: { sourceId: source.id, format, rowCount: rows.length, counts: ran.dryRunCounts },
  });
  return detailOf(tx, imp.id);
}

const SourceParam = z.object({ id: z.uuid() });
const CourseParam = z.object({ id: z.uuid(), mapId: z.uuid() });
const LinkParam = z.object({ id: z.uuid(), linkId: z.uuid() });
const ImportParam = z.object({ id: z.uuid() });
const RowParam = z.object({ id: z.uuid(), rowId: z.uuid() });
const CertificateParam = z.object({ memberId: z.uuid(), recordId: z.uuid() });
const CertificateQuery = z.object({
  title: z.string().trim().min(2).max(120).default("Certificate"),
});

const ok = <T extends z.ZodType>(schema: T, description: string) => ({
  200: jsonBody(schema, description),
  ...errorResponses,
  ...notFoundResponse,
  ...conflictResponse,
});
const created = <T extends z.ZodType>(schema: T, description: string) => ({
  201: jsonBody(schema, description),
  ...errorResponses,
  ...notFoundResponse,
  ...conflictResponse,
});

export const lmsImportRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/workforce/lms-sources",
      tags: ["workforce"],
      summary: "Learning platforms the organisation imports training from",
      description: "workforce.training.manage. Never a credential.",
      security,
      responses: ok(LmsSourceList, "Sources"),
    }),
    async (c) => {
      await requirePermission(c, TRAINING);
      const items = await withTenant(c, async (tx) =>
        (
          await tx
            .select()
            .from(lmsSource)
            .where(isNull(lmsSource.deletedAt))
            .orderBy(asc(lmsSource.name))
        ).map(sourceItem),
      );
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/lms-sources",
      tags: ["workforce"],
      summary: "Add a learning platform",
      description:
        "workforce.training.manage. A file source takes uploads; an API source is pulled through the learning platform port, and names the organisation's own secret, which the database makes and the caller never sends. Audited.",
      security,
      request: { body: { content: { "application/json": { schema: NewLmsSource } } } },
      responses: created(LmsSourceItem, "Added"),
    }),
    async (c) => {
      const access = await requirePermission(c, TRAINING);
      const body = c.req.valid("json");
      if ((body.kind === "api") !== (body.externalOrganisationId !== null)) {
        throw problems.invalid(
          "An API source needs the platform's id for your organisation; a file source has none.",
        );
      }
      const item = await change(c, access, A.sourceCreated, null, async (tx) => {
        const [row] = await tx
          .insert(lmsSource)
          .values({
            name: body.name,
            kind: body.kind,
            externalOrganisationId: body.externalOrganisationId,
          })
          .returning();
        if (!row) throw new Error("source not added");
        await audit(c, tx, access, {
          action: A.sourceCreated,
          resourceType: "lms_source",
          resourceId: row.id,
          scopeExtra: { kind: row.kind },
        });
        return sourceItem(row);
      });
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/lms-sources/{id}/end",
      tags: ["workforce"],
      summary: "End a learning platform",
      description:
        "workforce.training.manage, against version. Final: no more imports from it; its imported records stay. Audited.",
      security,
      request: {
        params: SourceParam,
        body: { content: { "application/json": { schema: EndLmsSource } } },
      },
      responses: ok(LmsSourceItem, "Ended"),
    }),
    async (c) => {
      const access = await requirePermission(c, TRAINING);
      const { id } = c.req.valid("param");
      const { version } = c.req.valid("json");
      const item = await change(c, access, A.sourceEnded, id, async (tx) => {
        await sourceOf(tx, id);
        const [row] = await tx
          .update(lmsSource)
          .set({ status: "ended" })
          .where(
            and(
              eq(lmsSource.id, id),
              eq(lmsSource.version, version),
              eq(lmsSource.status, "active"),
            ),
          )
          .returning();
        if (!row) throw refused(problems.conflict(), A.sourceEnded, id, "version_conflict");
        await audit(c, tx, access, {
          action: A.sourceEnded,
          resourceType: "lms_source",
          resourceId: id,
        });
        return sourceItem(row);
      });
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/workforce/lms-sources/{id}/courses",
      tags: ["workforce"],
      summary: "A learning platform's course mappings",
      description: "workforce.training.manage.",
      security,
      request: { params: SourceParam },
      responses: ok(LmsCourseMapList, "Mappings"),
    }),
    async (c) => {
      await requirePermission(c, TRAINING);
      const { id } = c.req.valid("param");
      const items = await withTenant(c, async (tx) => {
        await sourceOf(tx, id);
        return (
          await tx
            .select()
            .from(lmsCourseMap)
            .where(eq(lmsCourseMap.sourceId, id))
            .orderBy(asc(lmsCourseMap.courseCode))
        ).map(courseItem);
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/lms-sources/{id}/courses",
      tags: ["workforce"],
      summary: "Map a course code to a training topic",
      description:
        "workforce.training.manage. One mapping per course code; a tier only for Oliver McGowan. Audited.",
      security,
      request: {
        params: SourceParam,
        body: { content: { "application/json": { schema: NewLmsCourseMap } } },
      },
      responses: created(LmsCourseMapItem, "Mapped"),
    }),
    async (c) => {
      const access = await requirePermission(c, TRAINING);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      if (checkCourseMapping(body.topic, body.tier)) {
        throw problems.invalid(
          "Give a tier (1 or 2) for Oliver McGowan training, and only for it.",
        );
      }
      const item = await change(c, access, A.courseMapped, id, async (tx) => {
        await sourceOf(tx, id, true);
        const [row] = await tx
          .insert(lmsCourseMap)
          .values({ sourceId: id, courseCode: body.courseCode, topic: body.topic, tier: body.tier })
          .returning();
        if (!row) throw new Error("mapping not added");
        await audit(c, tx, access, {
          action: A.courseMapped,
          resourceType: "lms_course_map",
          resourceId: row.id,
          scopeExtra: { sourceId: id, topic: row.topic },
        });
        return courseItem(row);
      });
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/v1/workforce/lms-sources/{id}/courses/{mapId}",
      tags: ["workforce"],
      summary: "Change a course mapping",
      description:
        "workforce.training.manage, against version. Records already imported keep their topic. Audited.",
      security,
      request: {
        params: CourseParam,
        body: { content: { "application/json": { schema: ChangeLmsCourseMap } } },
      },
      responses: ok(LmsCourseMapItem, "Changed"),
    }),
    async (c) => {
      const access = await requirePermission(c, TRAINING);
      const { id, mapId } = c.req.valid("param");
      const { version, ...body } = c.req.valid("json");
      if (checkCourseMapping(body.topic, body.tier)) {
        throw problems.invalid(
          "Give a tier (1 or 2) for Oliver McGowan training, and only for it.",
        );
      }
      const item = await change(c, access, A.courseChanged, mapId, async (tx) => {
        await sourceOf(tx, id, true);
        const [row] = await tx
          .update(lmsCourseMap)
          .set(body)
          .where(
            and(
              eq(lmsCourseMap.id, mapId),
              eq(lmsCourseMap.sourceId, id),
              eq(lmsCourseMap.version, version),
            ),
          )
          .returning();
        if (!row) throw refused(problems.conflict(), A.courseChanged, mapId, "version_conflict");
        await audit(c, tx, access, {
          action: A.courseChanged,
          resourceType: "lms_course_map",
          resourceId: mapId,
          scopeExtra: { sourceId: id, topic: row.topic, active: row.active },
        });
        return courseItem(row);
      });
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/workforce/lms-sources/{id}/learners",
      tags: ["workforce"],
      summary: "A learning platform's learners linked to members of staff",
      description: "workforce.training.manage. Live links only.",
      security,
      request: { params: SourceParam },
      responses: ok(LmsLearnerLinkList, "Links"),
    }),
    async (c) => {
      await requirePermission(c, TRAINING);
      const { id } = c.req.valid("param");
      const items = await withTenant(c, async (tx) => {
        await sourceOf(tx, id);
        return (
          await tx
            .select()
            .from(lmsLearnerLink)
            .where(and(eq(lmsLearnerLink.sourceId, id), isNull(lmsLearnerLink.deletedAt)))
            .orderBy(asc(lmsLearnerLink.learnerId))
        ).map(linkItem);
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/lms-sources/{id}/learners",
      tags: ["workforce"],
      summary: "Link a learner to a member of staff",
      description:
        "workforce.training.manage, never for oneself, in the caller's own name. By the platform's stable learner id, never a name or an email; one live link each way. Audited.",
      security,
      request: {
        params: SourceParam,
        body: { content: { "application/json": { schema: NewLmsLearnerLink } } },
      },
      responses: created(LmsLearnerLinkItem, "Linked"),
    }),
    async (c) => {
      const access = await requirePermission(c, TRAINING);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const item = await change(c, access, A.learnerLinked, id, async (tx) => {
        await sourceOf(tx, id, true);
        if (body.workerId === access.tenantUserId) {
          throw refused(
            new HttpProblem(403, "own_development_record", "Someone else links you."),
            A.learnerLinked,
            id,
            "own_record",
          );
        }
        const [row] = await tx
          .insert(lmsLearnerLink)
          .values({
            sourceId: id,
            learnerId: body.learnerId,
            workerId: body.workerId,
            linkedBy: access.tenantUserId,
          })
          .returning();
        if (!row) throw new Error("link not added");
        await audit(c, tx, access, {
          action: A.learnerLinked,
          resourceType: "lms_learner_link",
          resourceId: row.id,
          scopeExtra: { sourceId: id, memberId: row.workerId },
        });
        return linkItem(row);
      });
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/lms-sources/{id}/learners/{linkId}/end",
      tags: ["workforce"],
      summary: "Unlink a learner",
      description:
        "workforce.training.manage. Records already imported stay; later rows for the learner wait for a new link. Audited.",
      security,
      request: { params: LinkParam },
      responses: ok(LmsLearnerLinkItem, "Unlinked"),
    }),
    async (c) => {
      const access = await requirePermission(c, TRAINING);
      const { id, linkId } = c.req.valid("param");
      const item = await change(c, access, A.learnerUnlinked, linkId, async (tx) => {
        await sourceOf(tx, id, true);
        const [row] = await tx
          .update(lmsLearnerLink)
          .set({ deletedAt: new Date() })
          .where(
            and(
              eq(lmsLearnerLink.id, linkId),
              eq(lmsLearnerLink.sourceId, id),
              isNull(lmsLearnerLink.deletedAt),
            ),
          )
          .returning();
        if (!row) throw problems.notFound();
        await audit(c, tx, access, {
          action: A.learnerUnlinked,
          resourceType: "lms_learner_link",
          resourceId: linkId,
          scopeExtra: { sourceId: id, memberId: row.workerId },
        });
        return linkItem(row);
      });
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/workforce/lms-sources/{id}/imports",
      tags: ["workforce"],
      summary: "A learning platform's imports",
      description: "workforce.training.manage. Newest first.",
      security,
      request: { params: SourceParam },
      responses: ok(LmsImportList, "Imports"),
    }),
    async (c) => {
      await requirePermission(c, TRAINING);
      const { id } = c.req.valid("param");
      const items = await withTenant(c, async (tx) => {
        await sourceOf(tx, id);
        return (
          await tx
            .select()
            .from(lmsImport)
            .where(eq(lmsImport.sourceId, id))
            .orderBy(desc(lmsImport.uploadedAt))
        ).map(importItem);
      });
      return c.json({ items } as z.infer<typeof LmsImportList>, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/lms-sources/{id}/imports",
      tags: ["workforce"],
      summary: "Upload a file of completions, and dry run it",
      description:
        "workforce.training.manage, for a file source. CSV (by heading) or JSON. Only the learner id, course code, dates, record id and provider are read; names, emails and scores are ignored. Every row is checked and classified; nothing is recorded until a commit. Audited with counts only.",
      security,
      request: {
        params: SourceParam,
        body: { content: { "application/json": { schema: NewLmsImport } } },
      },
      responses: created(LmsImportDetail, "Staged and dry run"),
    }),
    async (c) => {
      const access = await requirePermission(c, TRAINING);
      const { id } = c.req.valid("param");
      const { format, content } = c.req.valid("json");
      const today = ukIsoDate(new Date());
      const parsed: LmsParseResult =
        format === "csv" ? parseLmsCsv(content, today) : parseLmsJson(content, today);
      const detail = await change(c, access, A.staged, id, async (tx) => {
        const source = await sourceOf(tx, id);
        if (source.kind !== "file") {
          throw refused(
            problems.invalid("This learning platform is pulled, not uploaded."),
            A.staged,
            id,
            "not_a_file_source",
          );
        }
        if (!parsed.ok) {
          throw refused(problems.invalid(parsed.message), A.staged, id, "unreadable_file");
        }
        return stage(c, access, tx, source, format, sha256(content), parsed.rows);
      });
      return c.json(detail, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/lms-sources/{id}/pull",
      tags: ["workforce"],
      summary: "Pull completions from a learning platform, and dry run them",
      description:
        "workforce.training.manage, for an API source, through the learning platform port (a mock until H-1250). 409 integration_not_connected while it is off or has no credentials. Nothing is recorded until a commit. Audited with counts only.",
      security,
      request: { params: SourceParam },
      responses: created(LmsImportDetail, "Staged and dry run"),
    }),
    async (c) => {
      const access = await requirePermission(c, TRAINING);
      const { id } = c.req.valid("param");
      const adapter = c.get("services").learningPlatform;
      const source = await withTenant(c, (tx) => sourceOf(tx, id));
      const notConnected = (reason: string) =>
        refused(
          new HttpProblem(
            409,
            "integration_not_connected",
            "This learning platform is not connected. Import a file instead.",
          ),
          A.staged,
          id,
          reason,
        );
      // The call is made before any transaction opens, so no connection is held across it.
      const completions = await withAuditedRefusal(c, access, async () => {
        if (source.kind !== "api" || source.status !== "active")
          throw notConnected("not_an_api_source");
        if (!adapter) throw notConnected("integration_off");
        try {
          return await adapter.pull(source);
        } catch (error) {
          if (error instanceof LearningPlatformNotConnected) throw notConnected("no_credentials");
          if (error instanceof LearningPlatformUnavailable) {
            throw refused(
              new HttpProblem(
                502,
                "platform_unavailable",
                "The learning platform did not answer. Try again later.",
              ),
              A.staged,
              id,
              "platform_unavailable",
            );
          }
          throw error;
        }
      });
      if (completions.length === 0) {
        throw problems.invalid("The learning platform has no completions to import.");
      }
      const today = ukIsoDate(new Date());
      const rows = completions.map((x: LmsCompletionInput, i) => stageLmsRow(i + 1, x, today));
      const digest = sha256(JSON.stringify(completions));
      const detail = await change(c, access, A.staged, id, async (tx) =>
        stage(c, access, tx, await sourceOf(tx, id), "api", digest, rows),
      );
      return c.json(detail, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/workforce/lms-imports/{id}",
      tags: ["workforce"],
      summary: "An import, with its rows",
      description: "workforce.training.manage.",
      security,
      request: { params: ImportParam },
      responses: ok(LmsImportDetail, "The import"),
    }),
    async (c) => {
      await requirePermission(c, TRAINING);
      const { id } = c.req.valid("param");
      return c.json(await withTenant(c, (tx) => detailOf(tx, id)), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/lms-imports/{id}/dry-run",
      tags: ["workforce"],
      summary: "Dry run an import again",
      description:
        "workforce.training.manage. Classifies the pending rows as things now stand (after linking learners or mapping courses), and counts one more dry run. Records nothing. Audited.",
      security,
      request: { params: ImportParam },
      responses: ok(LmsImportDetail, "Dry run"),
    }),
    async (c) => {
      const access = await requirePermission(c, TRAINING);
      const { id } = c.req.valid("param");
      const detail = await change(c, access, A.dryRun, id, async (tx) => {
        const [imp] = await tx.select().from(lmsImport).where(eq(lmsImport.id, id)).for("update");
        if (!imp) throw problems.notFound();
        if (imp.status !== "open") throw RAISED.lms_import_closed as HttpProblem;
        const ran = await dryRun(tx, imp, access.tenantUserId);
        await audit(c, tx, access, {
          action: A.dryRun,
          resourceType: RESOURCE,
          resourceId: id,
          scopeExtra: { dryRunNumber: ran.dryRunNumber, counts: ran.dryRunCounts },
        });
        return detailOf(tx, id);
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/lms-imports/{id}/commit",
      tags: ["workforce"],
      summary: "Import the ready rows",
      description:
        "workforce.training.manage, naming the latest dry run (409 dry_run_stale if it is not, or if what it would import has changed). Each ready row becomes a new training record marked with its source; nothing made in Harbour is changed; other rows stay pending. For an API source, certificates are then fetched and stored with the malware scan. Audited.",
      security,
      request: {
        params: ImportParam,
        body: { content: { "application/json": { schema: CommitLmsImport } } },
      },
      responses: ok(LmsCommitResult, "Imported"),
    }),
    async (c) => {
      const access = await requirePermission(c, TRAINING);
      const { id } = c.req.valid("param");
      const { dryRunNumber } = c.req.valid("json");
      const stale = (reason: string) =>
        refused(
          new HttpProblem(
            409,
            "dry_run_stale",
            "Something changed since the dry run. Run it again, check it, then import.",
          ),
          A.committed,
          id,
          reason,
        );
      const made = await change(c, access, A.committed, id, async (tx) => {
        // One commit of an import at a time.
        const [imp] = await tx.select().from(lmsImport).where(eq(lmsImport.id, id)).for("update");
        if (!imp) throw problems.notFound();
        if (imp.status !== "open") throw RAISED.lms_import_closed as HttpProblem;
        if (dryRunNumber !== imp.dryRunNumber) throw stale("not_latest_dry_run");
        const source = await sourceOf(tx, imp.sourceId, true);
        const { rows, classified } = await classifyPending(tx, imp, access.tenantUserId);
        if (sha256(lmsDryRunFingerprint(classified)) !== imp.dryRunSha256) {
          throw stale("changed_since_dry_run");
        }
        const byNumber = new Map(rows.map((r) => [r.rowNumber, r]));
        const records: { id: string; recordId: string; memberId: string }[] = [];
        for (const k of classified) {
          const row = byNumber.get(k.rowNumber);
          if (k.class !== "ready" || !row || !k.workerId || !k.topic || !row.completedOn) continue;
          const [record] = await tx
            .insert(trainingRecord)
            .values({
              workerId: k.workerId,
              topic: k.topic,
              tier: k.tier,
              completedOn: row.completedOn,
              expiresOn: row.expiresOn,
              provider: row.provider ?? source.name,
              source: "lms",
              lmsSourceId: source.id,
              lmsImportRowId: row.id,
              externalRecordId: row.recordId,
            })
            .returning({ id: trainingRecord.id });
          if (!record) throw new Error("training record not made");
          await tx
            .update(lmsImportRow)
            .set({ outcome: "imported", trainingRecordId: record.id })
            .where(eq(lmsImportRow.id, row.id));
          await endDevelopmentReminders(tx, k.workerId, { trainingTopic: k.topic });
          await audit(c, tx, access, {
            action: A.imported,
            resourceType: "training_record",
            resourceId: record.id,
            scopeExtra: { memberId: k.workerId, topic: k.topic, importId: id },
          });
          records.push({ id: record.id, recordId: row.recordId, memberId: k.workerId });
        }
        await closeIfDone(tx, id);
        await audit(c, tx, access, {
          action: A.committed,
          resourceType: RESOURCE,
          resourceId: id,
          scopeExtra: { dryRunNumber, imported: records.length },
        });
        return { records, source };
      });

      // Rule 8: certificates, outside the commit's transaction, each scanned and stored on its own;
      // one refused or missing leaves its record standing.
      let certificates = 0;
      let certificatesRefused = 0;
      let certificatesNotFetched = 0;
      const adapter = c.get("services").learningPlatform;
      if (made.source.kind === "api" && adapter) {
        const { scanner } = c.get("services");
        certificatesNotFetched = Math.max(0, made.records.length - CERTIFICATES_PER_COMMIT);
        for (const r of made.records.slice(0, CERTIFICATES_PER_COMMIT)) {
          const bytes = await adapter.certificate(made.source, r.recordId).catch(() => null);
          if (!bytes) continue;
          try {
            await destroyingOnFailure(c.get("services").storage, (storage) =>
              withTenant(c, async (tx) => {
                const doc = await storeDocument(tx, { storage, scanner }, access.tenantId, {
                  bytes,
                  imagePrintable: imagePrintableOf(bytes),
                  declaredType: null,
                  category: "training_certificate",
                  title: "Certificate",
                  subjectType: "training_record",
                  subjectId: r.id,
                });
                await audit(c, tx, access, {
                  action: A.certificate,
                  resourceType: "document",
                  resourceId: doc.id,
                  scopeExtra: { trainingRecordId: r.id, memberId: r.memberId, source: "lms" },
                });
              }),
            );
            certificates += 1;
          } catch (error) {
            if (!(error instanceof HttpProblem)) throw error;
            certificatesRefused += 1;
            await writeAudit(c.get("services").appPool, access, {
              action: A.certificate,
              outcome: "denied",
              resourceType: "training_record",
              resourceId: r.id,
              reason: "certificate_refused",
              requestId: c.get("requestId"),
            });
          }
        }
      }
      const detail = await withTenant(c, (tx) => detailOf(tx, id));
      const pending = detail.rows.filter((r) => r.outcome === "pending").length;
      return c.json(
        {
          detail,
          imported: made.records.length,
          certificates,
          certificatesRefused,
          certificatesNotFetched,
          message:
            pending > 0
              ? `Imported ${made.records.length}. ${pending} still need a person: link the learner, map the course or skip the row.`
              : `Imported ${made.records.length}. The import is complete.`,
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/lms-imports/{id}/rows/{rowId}/skip",
      tags: ["workforce"],
      summary: "Skip a row, with a reason",
      description:
        "workforce.training.manage. A pending row is skipped once and never imported; the import closes when no row is pending. Audited.",
      security,
      request: {
        params: RowParam,
        body: { content: { "application/json": { schema: SkipLmsRow } } },
      },
      responses: ok(LmsImportDetail, "Skipped"),
    }),
    async (c) => {
      const access = await requirePermission(c, TRAINING);
      const { id, rowId } = c.req.valid("param");
      const { reason } = c.req.valid("json");
      const detail = await change(c, access, A.skipped, id, async (tx) => {
        const [row] = await tx
          .update(lmsImportRow)
          .set({ outcome: "skipped", skipReason: reason })
          .where(
            and(
              eq(lmsImportRow.id, rowId),
              eq(lmsImportRow.importId, id),
              eq(lmsImportRow.outcome, "pending"),
            ),
          )
          .returning({ id: lmsImportRow.id });
        if (!row) throw problems.notFound();
        await closeIfDone(tx, id);
        await audit(c, tx, access, {
          action: A.skipped,
          resourceType: "lms_import_row",
          resourceId: rowId,
          scopeExtra: { importId: id },
        });
        return detailOf(tx, id);
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/lms-imports/{id}/discard",
      tags: ["workforce"],
      summary: "Discard an import",
      description:
        "workforce.training.manage, against version. Its pending rows are never imported; records already imported stay. Audited.",
      security,
      request: {
        params: ImportParam,
        body: { content: { "application/json": { schema: LmsImportVersion } } },
      },
      responses: ok(LmsImportDetail, "Discarded"),
    }),
    async (c) => {
      const access = await requirePermission(c, TRAINING);
      const { id } = c.req.valid("param");
      const { version } = c.req.valid("json");
      const detail = await change(c, access, A.discarded, id, async (tx) => {
        const [row] = await tx
          .update(lmsImport)
          .set({ status: "discarded" })
          .where(
            and(eq(lmsImport.id, id), eq(lmsImport.version, version), eq(lmsImport.status, "open")),
          )
          .returning({ id: lmsImport.id });
        if (!row) throw refused(problems.conflict(), A.discarded, id, "version_conflict");
        await audit(c, tx, access, { action: A.discarded, resourceType: RESOURCE, resourceId: id });
        return detailOf(tx, id);
      });
      return c.json(detail, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/members/{memberId}/training-records/{recordId}/certificate",
      tags: ["workforce"],
      summary: "Add a training record's certificate",
      description:
        "workforce.training.manage, never for one's own record. JPEG, PNG, WebP or PDF, checked by its contents, size-limited and scanned for malware; a file that fails the scan is refused. Read as the training record is. Audited.",
      security,
      request: { params: CertificateParam, query: CertificateQuery, body: fileBody },
      responses: {
        201: jsonBody(z.object({ id: z.uuid() }), "Stored"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, TRAINING);
      const { memberId, recordId } = c.req.valid("param");
      const { title } = c.req.valid("query");
      if (memberId === access.tenantUserId) {
        await writeAudit(c.get("services").appPool, access, {
          action: A.certificate,
          outcome: "denied",
          resourceType: "training_record",
          resourceId: recordId,
          reason: "own_record",
          requestId: c.get("requestId"),
        });
        throw new HttpProblem(403, "own_development_record", "Someone else records this for you.");
      }
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      const imagePrintable = imagePrintableOf(bytes);
      const { scanner } = c.get("services");
      const id = await destroyingOnFailure(c.get("services").storage, (storage) =>
        change(c, access, A.certificate, recordId, async (tx) => {
          const [record] = await tx
            .select({ id: trainingRecord.id })
            .from(trainingRecord)
            .where(
              and(
                eq(trainingRecord.id, recordId),
                eq(trainingRecord.workerId, memberId),
                isNull(trainingRecord.deletedAt),
              ),
            );
          if (!record) throw problems.notFound();
          const doc = await storeDocument(tx, { storage, scanner }, access.tenantId, {
            bytes,
            imagePrintable,
            declaredType: c.req.header("content-type") ?? null,
            category: "training_certificate",
            title,
            subjectType: "training_record",
            subjectId: recordId,
          });
          await audit(c, tx, access, {
            action: A.certificate,
            resourceType: "document",
            resourceId: doc.id,
            scopeExtra: { trainingRecordId: recordId, memberId },
          });
          return doc.id;
        }),
      );
      return c.json({ id }, 201);
    },
  );
