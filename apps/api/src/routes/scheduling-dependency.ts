import {
  ApproveDependencyScaleVersion,
  CreateDependencyScale,
  DependencyRecordItem,
  DependencyScaleItem,
  DependencyScaleList,
  DependencyScaleVersionItem,
  DependencyScaleVersionList,
  EditDependencyScaleVersion,
  EndDependencyScale,
  PersonDependency,
  RecordDependency,
  RenameDependencyScale,
  StaffingRequirementList,
} from "@harbour/contracts";
import {
  admissionDecision,
  dependencyAssessment,
  dependencyScale,
  dependencyScaleVersion,
  location,
  person,
  placement,
  type Transaction,
} from "@harbour/db";
import {
  checkDependencyRecord,
  checkScaleApproval,
  checkScaleDefinition,
  correctedDependencyIds,
  currentDependency,
  DEPENDENCY_PROBLEM_MESSAGES,
  DEPENDENCY_TOOL_NOTICE,
  type DependencyAssessmentKind,
  type DependencyProblem,
  type DependencyRecord,
  type DependencyScaleDefinition,
  type DependencyScaleState,
  dependencyInForce,
  LIVE_PERSON_STATUSES,
  type PeriodMinutes,
  type PresenceFacts,
  presenceOn,
  SCALE_APPROVAL_MESSAGES,
  type ScaleVersionRecord,
  type StaffingRequirement,
  scaleForLocation,
  staffingRequirement,
  ukIsoDate,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, desc, eq, inArray, isNotNull, isNull, max } from "drizzle-orm";
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
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import { audit, dbCode } from "./people-shared";

/**
 * The dependency tool (scheduling.md section 12; CARE-004, SCHED-001; hazard HZ-123): the
 * organisation's own scale with its versions, each person's category, and the required care hours
 * for a location and shift. Harbour adds up the organisation's figures and shows the method; it
 * never assesses a person or judges staffing (medical-device-boundary.md section 6). The database
 * holds the same rules again (migration 0074). Audit events carry opaque ids only, never a
 * category or a reason.
 */

const MANAGE = "scheduling.dependency.manage";
const ASSESS = "care.dependency.assess";
const SCALE_READERS = [MANAGE, ASSESS, "scheduling.rota.manage", "scheduling.rota.read"] as const;
const RECORD_READERS = [ASSESS, "care.plan.read"] as const;
const A = {
  created: "scheduling.dependency_scale.created",
  renamed: "scheduling.dependency_scale.renamed",
  archived: "scheduling.dependency_scale.archived",
  drafted: "scheduling.dependency_scale.drafted",
  edited: "scheduling.dependency_scale.edited",
  approved: "scheduling.dependency_scale.approved",
  discarded: "scheduling.dependency_scale.discarded",
  recorded: "care.dependency.recorded",
  viewed: "care.dependency.viewed",
  requirement: "scheduling.staffing_requirement.viewed",
} as const;

type ScaleRow = typeof dependencyScale.$inferSelect;
type VersionRow = typeof dependencyScaleVersion.$inferSelect;
type RecordRow = typeof dependencyAssessment.$inferSelect;

const stateConflict = (detail: string) => new HttpProblem(409, "invalid_state", detail);

const refused = (
  problem: HttpProblem,
  action: string,
  resourceType: string,
  id: string | null,
  reason: string,
) =>
  new AuditedRefusal(problem, {
    action,
    outcome: "denied",
    resourceType,
    ...(id ? { resourceId: id } : {}),
    reason,
  });

/** Runs a change; refusals, the database's own included (403, 409, 422), are audited. */
async function change<T>(
  c: Context<AppEnv>,
  access: TenantAccess,
  what: { action: string; resourceType: string; id: string | null; duplicate: string },
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  try {
    return await withAuditedRefusal(c, access, () => withTenant(c, fn));
  } catch (error) {
    const code = dbCode(error);
    if (!code || !["42501", "23000", "23503", "23505", "23514"].includes(code)) throw error;
    await writeAudit(c.get("services").appPool, access, {
      action: what.action,
      outcome: "denied",
      resourceType: what.resourceType,
      ...(what.id ? { resourceId: what.id } : {}),
      reason: code === "42501" ? "refused_by_database" : "invalid_state",
      requestId: c.get("requestId"),
    });
    if (code === "42501") throw problems.forbidden();
    if (code === "23505") throw stateConflict(what.duplicate);
    if (code === "23503") {
      throw problems.invalid("A location, member, person or scale version named was not found.");
    }
    if (code === "23514") throw problems.invalid("That does not fit the scale or its rules.");
    throw stateConflict("This cannot be changed like that now. Reload it and try again.");
  }
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

const domainVersion = (row: VersionRow): ScaleVersionRecord => ({
  id: row.id,
  scaleId: row.scaleId,
  versionNumber: row.versionNumber,
  state: row.state as DependencyScaleState,
  definition: row.definition as DependencyScaleDefinition,
  authorId: row.authorId,
  contributorIds: row.contributorIds,
  approvedBy: row.approvedBy,
  approvedAt: row.approvedAt,
});

const domainRecord = (row: RecordRow): DependencyRecord => ({
  id: row.id,
  personId: row.personId,
  scaleId: row.scaleId,
  scaleVersionId: row.scaleVersionId,
  categoryKey: row.categoryKey,
  oneToOne: row.oneToOne as PeriodMinutes[],
  kind: row.kind as DependencyAssessmentKind,
  effectiveFrom: row.effectiveFrom,
  supersedesId: row.supersedesId,
  decidedBy: row.decidedBy,
  reason: row.reason,
  recordedAt: row.recordedAt,
});

function versionItem(row: VersionRow): z.infer<typeof DependencyScaleVersionItem> {
  const definition = row.definition as DependencyScaleDefinition;
  return {
    id: row.id,
    scaleId: row.scaleId,
    versionNumber: row.versionNumber,
    state: row.state as DependencyScaleState,
    definition: row.definition as z.infer<typeof DependencyScaleVersionItem>["definition"],
    authorId: row.authorId,
    contributorIds: row.contributorIds,
    approvedBy: row.approvedBy,
    approvedAt: iso(row.approvedAt),
    supersededAt: iso(row.supersededAt),
    discardReason: row.discardReason,
    issues: checkScaleDefinition(definition).map((i) => ({
      problem: i.problem,
      path: i.path,
      message: i.message,
    })),
    version: row.version,
  };
}

async function scaleItem(
  tx: Transaction,
  scale: ScaleRow,
): Promise<z.infer<typeof DependencyScaleItem>> {
  const versions = await tx
    .select()
    .from(dependencyScaleVersion)
    .where(
      and(
        eq(dependencyScaleVersion.scaleId, scale.id),
        inArray(dependencyScaleVersion.state, ["approved", "draft"]),
      ),
    );
  const current = versions.find((v) => v.state === "approved");
  const draft = versions.find((v) => v.state === "draft");
  return {
    id: scale.id,
    locationId: scale.locationId,
    name: scale.name,
    archivedAt: iso(scale.deletedAt),
    archiveReason: scale.archiveReason,
    current: current ? versionItem(current) : null,
    draft: draft ? versionItem(draft) : null,
    version: scale.version,
  };
}

/** A scale that is still in use, or a refusal (not found reads the same either way). */
async function liveScale(
  tx: Transaction,
  action: string,
  id: string,
  expectVersion?: number,
): Promise<ScaleRow> {
  const [scale] = await tx.select().from(dependencyScale).where(eq(dependencyScale.id, id));
  if (!scale) throw refused(problems.notFound(), action, "dependency_scale", id, "not_found");
  if (scale.deletedAt) {
    throw refused(
      stateConflict("This scale has been archived."),
      action,
      "dependency_scale",
      id,
      "archived",
    );
  }
  if (expectVersion !== undefined && scale.version !== expectVersion) {
    throw refused(problems.conflict(), action, "dependency_scale", id, "version_conflict");
  }
  return scale;
}

/** A draft of a live scale exactly as the caller loaded it. */
async function draftFor(
  tx: Transaction,
  action: string,
  scaleId: string,
  versionId: string,
  expectVersion: number,
): Promise<{ scale: ScaleRow; row: VersionRow }> {
  const scale = await liveScale(tx, action, scaleId);
  const [row] = await tx
    .select()
    .from(dependencyScaleVersion)
    .where(
      and(eq(dependencyScaleVersion.id, versionId), eq(dependencyScaleVersion.scaleId, scaleId)),
    );
  if (!row) throw refused(problems.notFound(), action, "dependency_scale", scaleId, "not_found");
  if (row.version !== expectVersion) {
    throw refused(problems.conflict(), action, "dependency_scale", scaleId, "version_conflict");
  }
  if (row.state !== "draft") {
    throw refused(
      stateConflict("Only a draft can be changed. Start a new draft from the version in use."),
      action,
      "dependency_scale",
      scaleId,
      "not_draft",
    );
  }
  return { scale, row };
}

/** The version row as the caller loaded it: a change in between makes the write match nothing. */
const sameVersion = (versionId: string, expectVersion: number) =>
  and(eq(dependencyScaleVersion.id, versionId), eq(dependencyScaleVersion.version, expectVersion));

/** The organisation's scales still in use, with each one's versions. */
async function liveScales(tx: Transaction): Promise<ScaleRow[]> {
  return tx.select().from(dependencyScale).where(isNull(dependencyScale.deletedAt));
}

async function recordsOf(tx: Transaction, personIds: readonly string[]): Promise<RecordRow[]> {
  if (personIds.length === 0) return [];
  return tx
    .select()
    .from(dependencyAssessment)
    .where(inArray(dependencyAssessment.personId, [...personIds]));
}

/** A person's records as the API returns them, newest first, with the one in force at `now`. */
async function personRecords(
  tx: Transaction,
  personId: string,
  now: Date,
): Promise<{ items: z.infer<typeof DependencyRecordItem>[]; currentId: string | null }> {
  const rows = await recordsOf(tx, [personId]);
  const versionIds = [...new Set(rows.map((r) => r.scaleVersionId))];
  const versions =
    versionIds.length === 0
      ? []
      : await tx
          .select()
          .from(dependencyScaleVersion)
          .where(inArray(dependencyScaleVersion.id, versionIds));
  const records = rows.map(domainRecord);
  const inForce = dependencyInForce(records, now);
  const corrected = correctedDependencyIds(records);
  const items = rows
    .map((row): z.infer<typeof DependencyRecordItem> => {
      const v = versions.find((x) => x.id === row.scaleVersionId);
      const definition = v?.definition as DependencyScaleDefinition | undefined;
      return {
        id: row.id,
        personId: row.personId,
        scaleId: row.scaleId,
        scaleVersionId: row.scaleVersionId,
        versionNumber: v?.versionNumber ?? null,
        categoryKey: row.categoryKey,
        categoryLabel:
          definition?.categories.find((cat) => cat.key === row.categoryKey)?.label ?? null,
        oneToOne: row.oneToOne as PeriodMinutes[],
        kind: row.kind as DependencyAssessmentKind,
        effectiveFrom: row.effectiveFrom,
        reason: row.reason,
        decidedBy: row.decidedBy,
        recordedBy: row.createdBy,
        recordedAt: row.recordedAt.toISOString(),
        supersedesId: row.supersedesId,
        inForce: row.id === inForce?.id,
        corrected: corrected.has(row.id),
      };
    })
    .sort((x, y) => (x.recordedAt < y.recordedAt ? 1 : x.recordedAt > y.recordedAt ? -1 : 0));
  return { items, currentId: currentDependency(records)?.id ?? null };
}

/**
 * The planned admission date of each person being admitted, from the admission decision in force
 * (the one no later decision supersedes) when it says needs can be met; absent when none.
 */
async function plannedAdmissions(
  tx: Transaction,
  personIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (personIds.length === 0) return out;
  const decisions = await tx
    .select({
      id: admissionDecision.id,
      personId: admissionDecision.personId,
      canMeetNeeds: admissionDecision.canMeetNeeds,
      plannedAdmissionOn: admissionDecision.plannedAdmissionOn,
      supersedesId: admissionDecision.supersedesId,
    })
    .from(admissionDecision)
    .where(inArray(admissionDecision.personId, [...personIds]));
  const superseded = new Set(decisions.map((d) => d.supersedesId).filter(Boolean));
  for (const d of decisions) {
    if (superseded.has(d.id) || d.canMeetNeeds === "no" || !d.plannedAdmissionOn) continue;
    out.set(d.personId, d.plannedAdmissionOn);
  }
  return out;
}

const DEPENDENCY_CONFLICTS: readonly DependencyProblem[] = ["not_current", "initial_exists"];

/** Field by field: jsonb gives keys back in its own order. */
const samePeriodMinutes = (a: readonly PeriodMinutes[], b: readonly PeriodMinutes[]) =>
  a.length === b.length &&
  a.every((x, i) => x.periodKey === b[i]?.periodKey && x.minutes === b[i]?.minutes);

const IdParam = z.object({ id: z.uuid() });
const VersionParam = z.object({ id: z.uuid(), versionId: z.uuid() });
const RequirementQuery = z.object({
  date: z.iso.date(),
  period: z.string().trim().min(1).max(40).optional(),
});

function requirementItem(
  r: StaffingRequirement,
): z.infer<typeof StaffingRequirementList>["items"][number] {
  const period = r.period
    ? {
        key: r.period.key,
        label: r.period.label,
        start: r.period.start.toISOString(),
        end: r.period.end.toISOString(),
        minutes: r.period.minutes,
      }
    : null;
  if (r.status === "no_scale") {
    return {
      status: "no_scale",
      locationId: r.locationId,
      date: r.date,
      period,
      source: null,
      notice: r.notice,
      figure: "none",
      careMinutes: null,
      oneToOneMinutes: null,
      requiredMinutes: null,
      awayMinutes: null,
      categories: [],
      oneToOne: [],
      people: [],
      skillMix: [],
      complete: false,
      warnings: r.warnings.map((w) => ({ ...w, personIds: [...w.personIds] })),
      method: [],
    };
  }
  return {
    status: "computed",
    locationId: r.locationId,
    date: r.date,
    period,
    source: { ...r.source, approvedAt: iso(r.source.approvedAt) },
    notice: r.notice,
    figure: r.figure,
    careMinutes: r.careMinutes,
    oneToOneMinutes: r.oneToOneMinutes,
    requiredMinutes: r.requiredMinutes,
    awayMinutes: r.awayMinutes,
    categories: r.categories.map((c) => ({ ...c })),
    oneToOne: r.oneToOne.map((o) => ({ ...o })),
    people: r.people.map((p) => ({ ...p, flags: [...p.flags] })),
    skillMix: r.skillMix.map((s) => ({ ...s })),
    complete: r.complete,
    warnings: r.warnings.map((w) => ({ ...w, personIds: [...w.personIds] })),
    method: [...r.method],
  };
}

export const schedulingDependencyRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/dependency-scales",
      tags: ["scheduling"],
      summary: "The organisation's dependency scales",
      description:
        "Each scale with the version in use and its open draft, each draft with its problems. The scale is the organisation's own tool. Holders of scheduling.dependency.manage, care.dependency.assess, scheduling.rota.manage or scheduling.rota.read.",
      security,
      responses: { 200: jsonBody(DependencyScaleList, "Scales"), ...errorResponses },
    }),
    async (c) => {
      await requireAnyPermission(c, SCALE_READERS);
      const items = await withTenant(c, async (tx) => {
        const rows = await tx
          .select()
          .from(dependencyScale)
          .orderBy(asc(dependencyScale.createdAt));
        const out = [];
        for (const row of rows) out.push(await scaleItem(tx, row));
        return out;
      });
      return c.json({ items, notice: DEPENDENCY_TOOL_NOTICE }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/dependency-scales",
      tags: ["scheduling"],
      summary: "Make a dependency scale with its first draft",
      description:
        "scheduling.dependency.manage at the location, or across the organisation for the organisation-wide scale (locationId null). One live scale per location. The draft is saved with its problems listed; it needs none to be approved. Audited.",
      security,
      request: { body: { content: { "application/json": { schema: CreateDependencyScale } } } },
      responses: {
        201: jsonBody(DependencyScaleItem, "Made"),
        ...errorResponses,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const body = c.req.valid("json");
      const what = {
        action: A.created,
        resourceType: "dependency_scale",
        id: null,
        duplicate:
          body.locationId === null
            ? "The organisation already has an organisation-wide scale."
            : "This location already has a dependency scale.",
      };
      const item = await change(c, access, what, async (tx) => {
        const [scale] = await tx
          .insert(dependencyScale)
          .values({ locationId: body.locationId, name: body.name })
          .returning();
        if (!scale) throw new Error("scale not stored");
        const [draft] = await tx
          .insert(dependencyScaleVersion)
          .values({
            scaleId: scale.id,
            versionNumber: 1,
            definition: body.definition,
            authorId: access.tenantUserId,
          })
          .returning();
        await audit(c, tx, access, {
          action: A.created,
          resourceType: "dependency_scale",
          resourceId: scale.id,
          scopeExtra: { locationId: scale.locationId, versionId: draft?.id },
        });
        return scaleItem(tx, scale);
      });
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/v1/dependency-scales/{id}",
      tags: ["scheduling"],
      summary: "Rename a dependency scale",
      description:
        "scheduling.dependency.manage where the scale applies, against `version`. Audited.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: RenameDependencyScale } } },
      },
      responses: {
        200: jsonBody(DependencyScaleItem, "Renamed"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const what = { action: A.renamed, resourceType: "dependency_scale", id, duplicate: "" };
      const item = await change(c, access, what, async (tx) => {
        await liveScale(tx, A.renamed, id, body.version);
        const [scale] = await tx
          .update(dependencyScale)
          .set({ name: body.name })
          .where(and(eq(dependencyScale.id, id), eq(dependencyScale.version, body.version)))
          .returning();
        if (!scale) {
          throw refused(problems.forbidden(), A.renamed, "dependency_scale", id, "not_permitted");
        }
        await audit(c, tx, access, {
          action: A.renamed,
          resourceType: "dependency_scale",
          resourceId: id,
        });
        return scaleItem(tx, scale);
      });
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/dependency-scales/{id}/archive",
      tags: ["scheduling"],
      summary: "Archive a dependency scale",
      description:
        "scheduling.dependency.manage where the scale applies, with a reason, against `version`. An archived scale applies nowhere: its location's required hours show no scale until another is approved. Final. Audited.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: EndDependencyScale } } },
      },
      responses: {
        200: jsonBody(DependencyScaleItem, "Archived"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const what = { action: A.archived, resourceType: "dependency_scale", id, duplicate: "" };
      const item = await change(c, access, what, async (tx) => {
        await liveScale(tx, A.archived, id, body.version);
        const [scale] = await tx
          .update(dependencyScale)
          .set({ deletedAt: new Date(), archiveReason: body.reason })
          .where(and(eq(dependencyScale.id, id), eq(dependencyScale.version, body.version)))
          .returning();
        if (!scale) {
          throw refused(problems.forbidden(), A.archived, "dependency_scale", id, "not_permitted");
        }
        await audit(c, tx, access, {
          action: A.archived,
          resourceType: "dependency_scale",
          resourceId: id,
          reason: "archived",
        });
        return scaleItem(tx, scale);
      });
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/dependency-scales/{id}/versions",
      tags: ["scheduling"],
      summary: "A dependency scale's versions, newest first",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(DependencyScaleVersionList, "Versions"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      await requireAnyPermission(c, SCALE_READERS);
      const { id } = c.req.valid("param");
      const items = await withTenant(c, async (tx) => {
        const [scale] = await tx.select().from(dependencyScale).where(eq(dependencyScale.id, id));
        if (!scale) return null;
        const rows = await tx
          .select()
          .from(dependencyScaleVersion)
          .where(eq(dependencyScaleVersion.scaleId, id))
          .orderBy(desc(dependencyScaleVersion.versionNumber));
        return rows.map(versionItem);
      });
      if (!items) throw problems.notFound();
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/dependency-scales/{id}/versions",
      tags: ["scheduling"],
      summary: "Start a new draft from the version in use",
      description:
        "scheduling.dependency.manage where the scale applies. The approved version stays in use until the new draft is approved. One draft at a time. Audited.",
      security,
      request: { params: IdParam },
      responses: {
        201: jsonBody(DependencyScaleVersionItem, "Drafted"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const what = {
        action: A.drafted,
        resourceType: "dependency_scale",
        id,
        duplicate: "This scale already has a draft. Change that draft or discard it first.",
      };
      const item = await change(c, access, what, async (tx) => {
        await liveScale(tx, A.drafted, id);
        const [from] = await tx
          .select()
          .from(dependencyScaleVersion)
          .where(eq(dependencyScaleVersion.scaleId, id))
          .orderBy(
            desc(eq(dependencyScaleVersion.state, "approved")),
            desc(dependencyScaleVersion.versionNumber),
          )
          .limit(1);
        const [last] = await tx
          .select({ n: max(dependencyScaleVersion.versionNumber) })
          .from(dependencyScaleVersion)
          .where(eq(dependencyScaleVersion.scaleId, id));
        if (!from)
          throw refused(problems.notFound(), A.drafted, "dependency_scale", id, "no_version");
        const [row] = await tx
          .insert(dependencyScaleVersion)
          .values({
            scaleId: id,
            versionNumber: (last?.n ?? 0) + 1,
            definition: from.definition,
            authorId: access.tenantUserId,
          })
          .returning();
        if (!row) throw new Error("version not stored");
        await audit(c, tx, access, {
          action: A.drafted,
          resourceType: "dependency_scale",
          resourceId: id,
          scopeExtra: { versionId: row.id, from: from.id },
        });
        return versionItem(row);
      });
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/dependency-scales/{id}/versions/{versionId}",
      tags: ["scheduling"],
      summary: "Change a draft",
      description:
        "scheduling.dependency.manage where the scale applies, drafts only, against the version you loaded. You join its contributors, so you cannot approve it. Audited.",
      security,
      request: {
        params: VersionParam,
        body: { content: { "application/json": { schema: EditDependencyScaleVersion } } },
      },
      responses: {
        200: jsonBody(DependencyScaleVersionItem, "Saved"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id, versionId } = c.req.valid("param");
      const body = c.req.valid("json");
      const what = { action: A.edited, resourceType: "dependency_scale", id, duplicate: "" };
      const item = await change(c, access, what, async (tx) => {
        await draftFor(tx, A.edited, id, versionId, body.version);
        const [row] = await tx
          .update(dependencyScaleVersion)
          .set({ definition: body.definition })
          .where(sameVersion(versionId, body.version))
          .returning();
        if (!row) {
          throw refused(problems.forbidden(), A.edited, "dependency_scale", id, "not_permitted");
        }
        await audit(c, tx, access, {
          action: A.edited,
          resourceType: "dependency_scale",
          resourceId: id,
          scopeExtra: { versionId },
        });
        return versionItem(row);
      });
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/dependency-scales/{id}/versions/{versionId}/approve",
      tags: ["scheduling"],
      summary: "Approve a draft",
      description:
        "scheduling.dependency.manage where the scale applies, never by its author or anyone who changed it; only a draft with no problems that differs from the version in use. It supersedes that version and applies from now. Audited.",
      security,
      request: {
        params: VersionParam,
        body: { content: { "application/json": { schema: ApproveDependencyScaleVersion } } },
      },
      responses: {
        200: jsonBody(DependencyScaleVersionItem, "Approved"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id, versionId } = c.req.valid("param");
      const body = c.req.valid("json");
      const what = {
        action: A.approved,
        resourceType: "dependency_scale",
        id,
        duplicate: "Another version was approved meanwhile. Reload the scale and try again.",
      };
      const item = await change(c, access, what, async (tx) => {
        const { scale, row } = await draftFor(tx, A.approved, id, versionId, body.version);
        const [current] = await tx
          .select()
          .from(dependencyScaleVersion)
          .where(
            and(
              eq(dependencyScaleVersion.scaleId, id),
              eq(dependencyScaleVersion.state, "approved"),
            ),
          );
        const found = checkScaleApproval(
          domainVersion(row),
          current ? domainVersion(current) : null,
          access.tenantUserId,
        );
        if (found.length > 0) {
          const detail = found.map((p) => SCALE_APPROVAL_MESSAGES[p]).join(" ");
          const problem = found.includes("author_cannot_approve")
            ? new HttpProblem(
                403,
                "separation_of_duties",
                "You cannot approve this version.",
                detail,
              )
            : found.includes("invalid_scale")
              ? problems.invalid(detail)
              : stateConflict(detail);
          throw refused(problem, A.approved, "dependency_scale", id, found.join(","));
        }
        const now = new Date();
        if (current) {
          await tx
            .update(dependencyScaleVersion)
            .set({ state: "superseded", supersededAt: now })
            .where(eq(dependencyScaleVersion.id, current.id));
        }
        const [approved] = await tx
          .update(dependencyScaleVersion)
          .set({ state: "approved", approvedBy: access.tenantUserId, approvedAt: now })
          .where(sameVersion(versionId, body.version))
          .returning();
        if (!approved) {
          throw refused(
            problems.conflict(),
            A.approved,
            "dependency_scale",
            id,
            "version_conflict",
          );
        }
        await audit(c, tx, access, {
          action: A.approved,
          resourceType: "dependency_scale",
          resourceId: id,
          scopeExtra: { versionId, supersedes: current?.id ?? null },
        });
        await publish(tx, {
          context: "scheduling",
          aggregateType: "dependency_scale",
          aggregateId: id,
          type: "scheduling.dependency_scale_approved",
          payload: { scaleId: id, versionId, locationId: scale.locationId },
        });
        return versionItem(approved);
      });
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/dependency-scales/{id}/versions/{versionId}/discard",
      tags: ["scheduling"],
      summary: "Discard a draft",
      description: "scheduling.dependency.manage where the scale applies, with a reason. Audited.",
      security,
      request: {
        params: VersionParam,
        body: { content: { "application/json": { schema: EndDependencyScale } } },
      },
      responses: {
        200: jsonBody(DependencyScaleVersionItem, "Discarded"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id, versionId } = c.req.valid("param");
      const body = c.req.valid("json");
      const what = { action: A.discarded, resourceType: "dependency_scale", id, duplicate: "" };
      const item = await change(c, access, what, async (tx) => {
        await draftFor(tx, A.discarded, id, versionId, body.version);
        const [row] = await tx
          .update(dependencyScaleVersion)
          .set({ state: "discarded", discardReason: body.reason })
          .where(sameVersion(versionId, body.version))
          .returning();
        if (!row) {
          throw refused(problems.forbidden(), A.discarded, "dependency_scale", id, "not_permitted");
        }
        await audit(c, tx, access, {
          action: A.discarded,
          resourceType: "dependency_scale",
          resourceId: id,
          scopeExtra: { versionId },
          reason: "discarded",
        });
        return versionItem(row);
      });
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/dependency",
      tags: ["care"],
      summary: "A person's dependency categories",
      description:
        "Every record, newest first, with the one in force now and the corrected ones marked. Before the first record, the retired free-text category from the admission form, if any, is shown read-only (`admissionFormCategory`; never prefilled, H-716). A care record: care.dependency.assess or care.plan.read in the person's scope. The view is audited.",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(PersonDependency, "The person's categories"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, RECORD_READERS);
      const { id } = c.req.valid("param");
      const result = await withTenant(c, async (tx) => {
        const [found] = await tx.select({ id: person.id }).from(person).where(eq(person.id, id));
        if (!found) return null;
        const { items, currentId } = await personRecords(tx, id, new Date());
        // The retired admission-form text (H-716), for whoever records the first category only.
        const [legacy] =
          currentId === null
            ? await tx
                .select({ category: placement.dependencyCategory })
                .from(placement)
                .where(
                  and(
                    eq(placement.personId, id),
                    isNotNull(placement.dependencyCategory),
                    isNull(placement.deletedAt),
                  ),
                )
                .orderBy(desc(placement.startDate), desc(placement.createdAt))
                .limit(1)
            : [];
        await audit(c, tx, access, {
          action: A.viewed,
          resourceType: "person",
          resourceId: id,
          scopeExtra: { records: items.length },
        });
        return {
          inForce: items.find((i) => i.inForce) ?? null,
          currentId,
          items,
          notice: DEPENDENCY_TOOL_NOTICE,
          admissionFormCategory: legacy?.category ?? null,
        };
      });
      if (!result) throw problems.notFound();
      return c.json(result, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/dependency",
      tags: ["care"],
      summary: "Record a person's dependency category",
      description:
        "care.dependency.assess in the person's scope. From the approved version of the scale at the person's location, with the reason and who decided. The first record is `initial`; a later one supersedes the current record (`supersedesId`, as loaded): a review from its own date, a correction from the corrected record's date. Sending the same id again returns what was stored. Audited.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: RecordDependency } } },
      },
      responses: {
        200: jsonBody(DependencyRecordItem, "Already stored with these details"),
        201: jsonBody(DependencyRecordItem, "Recorded"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, ASSESS);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const what = {
        action: A.recorded,
        resourceType: "person",
        id,
        duplicate:
          "Someone has recorded this person's category since you loaded it. Reload it and try again.",
      };
      const now = new Date();
      const result = await change(c, access, what, async (tx) => {
        const [subject] = await tx
          .select({ id: person.id, locationId: person.locationId })
          .from(person)
          .where(eq(person.id, id));
        if (!subject) throw refused(problems.notFound(), A.recorded, "person", id, "not_found");
        const [stored] = await tx
          .select()
          .from(dependencyAssessment)
          .where(eq(dependencyAssessment.id, body.id));
        if (stored) {
          const same =
            stored.personId === id &&
            stored.kind === body.kind &&
            stored.categoryKey === body.categoryKey &&
            stored.effectiveFrom === body.effectiveFrom &&
            stored.reason === body.reason &&
            stored.decidedBy === body.decidedBy &&
            stored.supersedesId === body.supersedesId &&
            samePeriodMinutes(stored.oneToOne as PeriodMinutes[], body.oneToOne);
          if (!same) {
            throw refused(
              problems.alreadySavedDifferently(),
              A.recorded,
              "person",
              id,
              "already_saved_differently",
            );
          }
          const { items } = await personRecords(tx, id, now);
          return { replay: true, item: items.find((i) => i.id === stored.id) };
        }
        const scale = scaleForLocation(await liveScales(tx), subject.locationId);
        const [current] = scale
          ? await tx
              .select()
              .from(dependencyScaleVersion)
              .where(
                and(
                  eq(dependencyScaleVersion.scaleId, scale.id),
                  eq(dependencyScaleVersion.state, "approved"),
                ),
              )
          : [];
        const records = (await recordsOf(tx, [id])).map(domainRecord);
        const found = checkDependencyRecord(
          {
            kind: body.kind,
            categoryKey: body.categoryKey,
            oneToOne: body.oneToOne,
            effectiveFrom: body.effectiveFrom,
            reason: body.reason,
            decidedBy: body.decidedBy,
            supersedesId: body.supersedesId,
          },
          {
            version: current ? domainVersion(current) : null,
            records,
            today: ukIsoDate(now),
          },
        );
        if (found.length > 0) {
          const detail = found.map((p) => DEPENDENCY_PROBLEM_MESSAGES[p]).join(" ");
          const conflict = found.some((p) => DEPENDENCY_CONFLICTS.includes(p));
          throw refused(
            conflict ? stateConflict(detail) : problems.invalid(detail),
            A.recorded,
            "person",
            id,
            found.join(","),
          );
        }
        if (!scale || !current) throw new Error("checked above");
        const [row] = await tx
          .insert(dependencyAssessment)
          .values({
            id: body.id,
            personId: id,
            scaleId: scale.id,
            scaleVersionId: current.id,
            categoryKey: body.categoryKey,
            oneToOne: body.oneToOne,
            kind: body.kind,
            effectiveFrom: body.effectiveFrom,
            reason: body.reason,
            decidedBy: body.decidedBy,
            supersedesId: body.supersedesId,
          })
          .returning();
        if (!row) throw new Error("record not stored");
        await audit(c, tx, access, {
          action: A.recorded,
          resourceType: "person",
          resourceId: id,
          scopeExtra: { recordId: row.id, scaleId: scale.id, versionId: current.id },
        });
        await publish(tx, {
          context: "care",
          aggregateType: "person",
          aggregateId: id,
          type: "care.dependency_recorded",
          payload: { personId: id, recordId: row.id, locationId: subject.locationId },
        });
        const { items } = await personRecords(tx, id, now);
        return { replay: false, item: items.find((i) => i.id === row.id) };
      });
      if (!result.item) throw new Error("record not read back");
      return c.json(result.item, result.replay ? 200 : 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/locations/{id}/staffing-requirement",
      tags: ["scheduling"],
      summary: "Required care hours for a location and shift",
      description:
        "The organisation's own dependency scale added up for the people living at the location, per shift period of the UK date (or one period), with the method, the source and the notice; never a judgement of safe staffing. No scale in force gives no figure, never 0; people not counted are named. Needs scheduling.rota.manage and care.plan.read across the whole location (a narrower scope would leave people out). A care-record view, audited.",
      security,
      request: { params: IdParam, query: RequirementQuery },
      responses: {
        200: jsonBody(StaffingRequirementList, "Required care hours"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      await requirePermission(c, "scheduling.rota.manage");
      const access = await requirePermission(c, "care.plan.read");
      const { id } = c.req.valid("param");
      const query = c.req.valid("query");
      const scope = access.context;
      const coversLocation =
        scope.scope === "tenant" || (scope.scope === "locations" && scope.locationIds.includes(id));
      if (!coversLocation) {
        await writeAudit(c.get("services").appPool, access, {
          action: A.requirement,
          outcome: "denied",
          resourceType: "location",
          resourceId: id,
          reason: "scope_not_whole_location",
          requestId: c.get("requestId"),
        });
        throw problems.forbidden();
      }
      const asAt = new Date();
      const items = await withTenant(c, async (tx) => {
        const [place] = await tx
          .select({ id: location.id })
          .from(location)
          .where(eq(location.id, id));
        if (!place) return null;
        const scale = scaleForLocation(await liveScales(tx), id);
        const versions = scale
          ? await tx
              .select()
              .from(dependencyScaleVersion)
              .where(eq(dependencyScaleVersion.scaleId, scale.id))
          : [];
        // Everyone living at the location or being admitted to it; where each is on the date
        // asked comes from their status, when it began, and a planned admission (rule 9).
        const people = await tx
          .select({
            id: person.id,
            status: person.status,
            statusChangedAt: person.statusChangedAt,
          })
          .from(person)
          .where(
            and(
              eq(person.locationId, id),
              inArray(person.status, [...LIVE_PERSON_STATUSES, "pre_admission"]),
              isNull(person.deletedAt),
            ),
          );
        const planned = await plannedAdmissions(
          tx,
          people.filter((p) => p.status === "pre_admission").map((p) => p.id),
        );
        const records = (
          await recordsOf(
            tx,
            people.map((p) => p.id),
          )
        ).map(domainRecord);
        const today = ukIsoDate(asAt);
        const results = staffingRequirement({
          locationId: id,
          date: query.date,
          periodKey: query.period ?? null,
          scale: scale
            ? { scaleId: scale.id, name: scale.name, versions: versions.map(domainVersion) }
            : null,
          people: people.map((p) => ({
            personId: p.id,
            presence: presenceOn(
              {
                status: p.status as PresenceFacts["status"],
                statusSince: p.status === "pre_admission" ? null : ukIsoDate(p.statusChangedAt),
                plannedAdmissionOn: planned.get(p.id) ?? null,
              },
              query.date,
              today,
            ),
            records: records.filter((r) => r.personId === p.id),
          })),
        });
        if (results.length === 0) return "unknown_period" as const;
        await audit(c, tx, access, {
          action: A.requirement,
          resourceType: "location",
          resourceId: id,
          scopeExtra: { date: query.date, people: people.length, scaleId: scale?.id ?? null },
        });
        return results.map(requirementItem);
      });
      if (!items) throw problems.notFound();
      if (items === "unknown_period") {
        throw problems.invalid(
          `The scale in force on ${query.date} has no shift period called "${query.period}".`,
        );
      }
      return c.json({ items, asAt: asAt.toISOString() }, 200);
    },
  );
