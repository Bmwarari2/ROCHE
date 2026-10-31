import {
  AddShift,
  ApplyPattern,
  ArchiveRotaItem,
  AssignmentResult,
  AssignShift,
  CancelShift,
  CreateRota,
  CreateShiftPattern,
  CreateShiftTemplate,
  EligibilityItem,
  MyShiftList,
  PublishRota,
  RemoveAssignment,
  ROTA_MAX_DAYS,
  RotaCheck,
  RotaItem,
  RotaList,
  ShiftPatternItem,
  ShiftPatternList,
  ShiftTemplateItem,
  ShiftTemplateList,
} from "@harbour/contracts";
import {
  rosterOverride,
  rota,
  rotaPublication,
  shift,
  shiftAssignment,
  shiftPattern,
  shiftTemplate,
  type Transaction,
} from "@harbour/db";
import {
  blockerKey,
  COMPETENCES,
  checkPattern,
  checkShiftShape,
  noticeMinutes,
  PATTERN_MESSAGES,
  type PatternEntry,
  patternShifts,
  SHIFT_SHAPE_MESSAGES,
  type ShiftShape,
  type StaffingSkill,
  shiftTimes,
  ukEndOfDay,
  ukIsoDate,
  ukStartOfDay,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import type { Context } from "hono";
import { withAuditedRefusal, writeAudit } from "../http/audit";
import {
  type AppEnv,
  requireAnyPermission,
  requirePermission,
  type TenantAccess,
  withTenant,
} from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { publish } from "../outbox";
import { memberAwayFor, resolveCoverNeeds } from "../services/absence";
import {
  type AssignmentRow,
  blockerItems,
  type RotaRow,
  rotaCheck,
  rotaShifts,
  type ShiftRow,
  shiftEligibility,
  workingTimeFor,
} from "../services/rota";
import { staffNames } from "../services/staff";
import { withSystemRights } from "../services/system-rights";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import { audit, dbCode, requireLocationInScope } from "./people-shared";

/**
 * The rota builder (scheduling.md section 14; SCHED-001, SCHED-002; hazards HZ-123 and HZ-124).
 * Templates and patterns make shifts; a shift is one position; assigning applies the rostering
 * rule (workforce.md rule 10) with the staff file's checks and the competence port, and a manager
 * holding scheduling.rota.approve may override it with a justification, never for a right to
 * work. Before publishing, the check compares the rota with the organisation's own dependency
 * scale, runs the working time rules and re-applies the rostering rule; the comparison and working
 * time advise and never block, but publishing must send back the digest of the check it was shown
 * and acknowledge any warning. Audit events carry opaque ids only, never a blocker's detail, a
 * justification or a finding.
 */

const READERS = ["scheduling.rota.manage", "scheduling.rota.read"] as const;
const A = {
  templateCreated: "scheduling.shift_template.created",
  templateArchived: "scheduling.shift_template.archived",
  patternCreated: "scheduling.shift_pattern.created",
  patternArchived: "scheduling.shift_pattern.archived",
  rotaCreated: "scheduling.rota.created",
  patternApplied: "scheduling.rota.pattern_applied",
  shiftAdded: "scheduling.shift.added",
  shiftCancelled: "scheduling.shift.cancelled",
  eligibility: "scheduling.eligibility.checked",
  assigned: "scheduling.shift.assigned",
  overridden: "scheduling.roster_override.given",
  removed: "scheduling.shift_assignment.removed",
  checked: "scheduling.rota.checked",
  published: "scheduling.rota.published",
} as const;

const IdParam = z.object({ id: z.uuid() });
export const stale = () =>
  new HttpProblem(
    409,
    "version_conflict",
    "This was changed by someone else since you loaded it. Reload it and try again.",
  );
export const stateConflict = (detail: string) => new HttpProblem(409, "invalid_state", detail);

/** Runs a change; refusals, the database's own included (403, 409, 422), are audited. */
export async function change<T>(
  c: Context<AppEnv>,
  access: TenantAccess,
  what: { action: string; resourceType: string; id: string | null },
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
    if (code === "23505") {
      throw stateConflict("That overlaps another rota at this location, or the shift is taken.");
    }
    if (code === "23514") {
      throw problems.invalid(
        "That does not fit the rota: a shift starts on one of its dates, and nobody works two shifts at once.",
      );
    }
    throw problems.invalid("A location, member, template or shift named was not found.");
  }
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function templateItem(t: typeof shiftTemplate.$inferSelect): z.infer<typeof ShiftTemplateItem> {
  return {
    id: t.id,
    version: t.version,
    locationId: t.locationId,
    name: t.name,
    kind: t.kind as z.infer<typeof ShiftTemplateItem>["kind"],
    startMinute: t.startMinute,
    endMinute: t.endMinute,
    breakMinutes: t.breakMinutes,
    requiredCompetences: t.requiredCompetences,
    requiredSkills: t.requiredSkills as StaffingSkill[],
    supervised: t.supervised,
    countsAsCare: t.countsAsCare,
  };
}

function patternItem(p: typeof shiftPattern.$inferSelect): z.infer<typeof ShiftPatternItem> {
  return {
    id: p.id,
    version: p.version,
    locationId: p.locationId,
    name: p.name,
    cycleDays: p.cycleDays,
    entries: p.entries as PatternEntry[],
  };
}

function rotaSummary(r: RotaRow, changedSincePublished = false) {
  return {
    id: r.id,
    version: r.version,
    locationId: r.locationId,
    startsOn: r.startsOn,
    endsOn: r.endsOn,
    state: r.state as "draft" | "published",
    publishedAt: iso(r.publishedAt),
    changedSincePublished,
  };
}

async function rotaItem(tx: Transaction, r: RotaRow): Promise<z.infer<typeof RotaItem>> {
  const { shifts, assignmentOf, overriddenOf, coverNeededOf } = await rotaShifts(tx, r.id);
  const names = await staffNames(
    tx,
    shifts.map((s) => assignmentOf(s.id)?.workerId),
  );
  const publications = await tx
    .select()
    .from(rotaPublication)
    .where(eq(rotaPublication.rotaId, r.id))
    .orderBy(desc(rotaPublication.publishedAt));
  return {
    ...rotaSummary(r, (await rotasChangedSince(tx, [r])).has(r.id)),
    shifts: shifts.map((s) => shiftItem(s, assignmentOf(s.id), overriddenOf, names, coverNeededOf)),
    publications: publications.map((p) => ({
      id: p.id,
      publishedAt: p.publishedAt.toISOString(),
      publishedBy: p.publishedBy,
      noticeMinutes: p.noticeMinutes,
      shiftCount: p.shiftCount,
      openShiftCount: p.openShiftCount,
    })),
  };
}

export function shiftItem(
  s: ShiftRow,
  a: AssignmentRow | null,
  overriddenOf: (assignmentId: string) => string[],
  names: Awaited<ReturnType<typeof staffNames>>,
  coverNeededOf: (assignmentId: string) => boolean = () => false,
) {
  return {
    id: s.id,
    version: s.version,
    rotaId: s.rotaId,
    templateId: s.templateId,
    label: s.label,
    kind: s.kind as z.infer<typeof ShiftTemplateItem>["kind"],
    date: ukIsoDate(s.startsAt),
    startsAt: s.startsAt.toISOString(),
    endsAt: s.endsAt.toISOString(),
    breakMinutes: s.breakMinutes,
    requiredCompetences: s.requiredCompetences,
    requiredSkills: s.requiredSkills as StaffingSkill[],
    supervised: s.supervised,
    countsAsCare: s.countsAsCare,
    publishedAt: iso(s.publishedAt),
    changedAfterPublishAt: iso(s.changedAfterPublishAt),
    assignment: a
      ? {
          id: a.id,
          version: a.version,
          worker: names(a.workerId) ?? {
            id: a.workerId,
            displayName: "Member of staff",
            jobTitle: null,
          },
          publishedAt: iso(a.publishedAt),
          overridden: overriddenOf(a.id),
          coverNeeded: coverNeededOf(a.id),
        }
      : null,
  };
}

function shapeProblems(shape: ShiftShape): string | null {
  const found = checkShiftShape(shape, COMPETENCES);
  return found.length === 0 ? null : found.map((p) => SHIFT_SHAPE_MESSAGES[p]).join(" ");
}

/**
 * A published rota has changed since its last publication when a shift was added, cancelled or
 * changed hands after it (clinical safety review round 1, H3): the rota then shows that it needs
 * checking and publishing again. Cancelled shifts count too.
 */
async function rotasChangedSince(tx: Transaction, rows: readonly RotaRow[]): Promise<Set<string>> {
  const published = rows.filter((r) => r.publishedAt);
  if (published.length === 0) return new Set();
  const changed = await tx
    .select({ rotaId: shift.rotaId, at: shift.changedAfterPublishAt })
    .from(shift)
    .where(
      and(
        inArray(
          shift.rotaId,
          published.map((r) => r.id),
        ),
        isNotNull(shift.changedAfterPublishAt),
      ),
    );
  return new Set(
    changed
      .filter((x) => {
        const r = published.find((p) => p.id === x.rotaId);
        return r?.publishedAt && x.at && x.at > r.publishedAt;
      })
      .map((x) => x.rotaId),
  );
}

/**
 * Locks a rota for the rest of the transaction: every change to its shifts and assignments, and
 * publishing, take it first, so a publication publishes exactly what its check saw (security
 * review round 1, M2).
 */
export async function lockRota(tx: Transaction, id: string): Promise<RotaRow | null> {
  const [row] = await tx
    .select()
    .from(rota)
    .where(and(eq(rota.id, id), isNull(rota.deletedAt)))
    .for("update");
  return row ?? null;
}

/**
 * Whether the member works where the shift is: a live role at the location, or across the
 * organisation (security review round 1, M3). Anyone else reads as not found, so the rota cannot be
 * used to look up another location's staff files. Read with the system's rights.
 */
export async function worksAt(
  tx: Transaction,
  workerId: string,
  locationId: string,
): Promise<boolean> {
  const rows = await withSystemRights(tx, () =>
    tx.execute<{ ok: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM public.role_assignment ra
        WHERE ra.tenant_user_id = ${workerId} AND ra.deleted_at IS NULL
          AND ra.valid_from <= now() AND (ra.valid_to IS NULL OR ra.valid_to > now())
          AND (ra.location_id = ${locationId} OR ra.location_id IS NULL)) AS ok`),
  );
  return rows.rows[0]?.ok === true;
}

/** Whether the member is a bank or agency worker (read with the system's rights). */
async function isAgencyMember(tx: Transaction, memberId: string): Promise<boolean> {
  const rows = await withSystemRights(tx, () =>
    tx.execute<{ yes: boolean }>(sql`SELECT app.member_is_agency(${memberId}) AS yes`),
  );
  return rows.rows[0]?.yes === true;
}

/** Takes one member's assignment lock (the database guard takes the same one; M1). */
export async function lockWorker(tx: Transaction, tenantId: string, workerId: string) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`worker:${tenantId}${workerId}`}, 0))`,
  );
}

/** Whether this member read this check (by its digest) within the last hour. */
async function checkSeen(
  tx: Transaction,
  memberId: string,
  rotaId: string,
  digest: string,
): Promise<boolean> {
  const rows = await withSystemRights(tx, () =>
    tx.execute<{ ok: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM public.audit_event e
        WHERE e.action = ${A.checked} AND e.actor_tenant_user_id = ${memberId}
          AND e.resource_id = ${rotaId} AND e.scope->>'digest' = ${digest}
          AND e.occurred_at > now() - interval '1 hour') AS ok`),
  );
  return rows.rows[0]?.ok === true;
}

async function loadRota(tx: Transaction, id: string): Promise<RotaRow | null> {
  const [row] = await tx
    .select()
    .from(rota)
    .where(and(eq(rota.id, id), isNull(rota.deletedAt)));
  return row ?? null;
}

export async function loadShift(
  tx: Transaction,
  id: string,
  lock = false,
): Promise<ShiftRow | null> {
  const query = tx
    .select()
    .from(shift)
    .where(and(eq(shift.id, id), isNull(shift.deletedAt)));
  const [row] = lock ? await query.for("update") : await query;
  return row ?? null;
}

/** A change on a published rota is recorded for notice tracking, and the rota needs publishing again. */
export async function markChanged(tx: Transaction, s: ShiftRow, r: RotaRow, at: Date) {
  if (!s.publishedAt && !r.publishedAt) return;
  await tx.update(shift).set({ changedAfterPublishAt: at }).where(eq(shift.id, s.id));
}

/**
 * The check reads care plans across the whole location: anyone left out would lower the figure
 * (HZ-123). Requires scheduling.rota.manage where the rota is, then care.plan.read in a scope that
 * covers the whole location; a rota the caller cannot see reads as not found.
 */
async function requireWholeLocation(
  c: Context<AppEnv>,
  id: string,
  action: string,
): Promise<TenantAccess> {
  const manage = await requirePermission(c, "scheduling.rota.manage");
  const row = await withTenant(c, (tx) => loadRota(tx, id));
  if (!row) throw problems.notFound();
  requireLocationInScope(manage, row.locationId);
  const access = await requirePermission(c, "care.plan.read");
  const scope = access.context;
  const covers =
    scope.scope === "tenant" ||
    (scope.scope === "locations" && scope.locationIds.includes(row.locationId));
  if (!covers) {
    await writeAudit(c.get("services").appPool, access, {
      action,
      outcome: "denied",
      resourceType: "rota",
      resourceId: id,
      reason: "scope_not_whole_location",
      requestId: c.get("requestId"),
    });
    throw problems.forbidden();
  }
  return access;
}

/** Whether the member is on another live shift that overlaps, at any location (system rights). */
export async function doubleBooked(
  tx: Transaction,
  workerId: string,
  s: ShiftRow,
): Promise<boolean> {
  const rows = await withSystemRights(tx, () =>
    tx
      .select({ id: shift.id, startsAt: shift.startsAt, endsAt: shift.endsAt })
      .from(shiftAssignment)
      .innerJoin(shift, eq(shift.id, shiftAssignment.shiftId))
      .where(
        and(
          eq(shiftAssignment.workerId, workerId),
          isNull(shiftAssignment.deletedAt),
          isNull(shift.deletedAt),
          ne(shift.id, s.id),
        ),
      ),
  );
  return rows.some((r) => r.startsAt < s.endsAt && s.startsAt < r.endsAt);
}

export const rotaRouter = createRouter()
  // ----------------------------------------------------------------------------------------
  // Templates and patterns
  // ----------------------------------------------------------------------------------------
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/locations/{id}/shift-templates",
      tags: ["scheduling"],
      summary: "Shift templates at a location",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(ShiftTemplateList, "Live templates"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, READERS);
      const { id } = c.req.valid("param");
      requireLocationInScope(access, id);
      const rows = await withTenant(c, (tx) =>
        tx
          .select()
          .from(shiftTemplate)
          .where(and(eq(shiftTemplate.locationId, id), isNull(shiftTemplate.deletedAt)))
          .orderBy(asc(shiftTemplate.startMinute), asc(shiftTemplate.name)),
      );
      return c.json({ items: rows.map(templateItem) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/locations/{id}/shift-templates",
      tags: ["scheduling"],
      summary: "Make a shift template",
      description:
        "Times are UK wall-clock minutes after midnight (24-hour); an end at or before the start is the next day. Needs scheduling.rota.manage at the location.",
      security,
      request: { params: IdParam, body: jsonBody(CreateShiftTemplate, "The template") },
      responses: {
        201: jsonBody(ShiftTemplateItem, "Made"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "scheduling.rota.manage");
      const { id } = c.req.valid("param");
      requireLocationInScope(access, id);
      const body = c.req.valid("json");
      const problem = shapeProblems(body);
      if (problem) throw problems.invalid(problem);
      const row = await change(
        c,
        access,
        { action: A.templateCreated, resourceType: "location", id },
        async (tx) => {
          const [made] = await tx
            .insert(shiftTemplate)
            .values({ locationId: id, ...body })
            .returning();
          if (!made) throw new Error("template not stored");
          await audit(c, tx, access, {
            action: A.templateCreated,
            resourceType: "shift_template",
            resourceId: made.id,
            scopeExtra: { locationId: id },
          });
          return made;
        },
      );
      return c.json(templateItem(row), 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/shift-templates/{id}/archive",
      tags: ["scheduling"],
      summary: "Archive a shift template",
      description: "Shifts already made from it stay as they are.",
      security,
      request: { params: IdParam, body: jsonBody(ArchiveRotaItem, "Against version") },
      responses: {
        200: jsonBody(ShiftTemplateItem, "Archived"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "scheduling.rota.manage");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const row = await change(
        c,
        access,
        { action: A.templateArchived, resourceType: "shift_template", id },
        async (tx) => {
          const [current] = await tx
            .select()
            .from(shiftTemplate)
            .where(and(eq(shiftTemplate.id, id), isNull(shiftTemplate.deletedAt)));
          if (!current) return null;
          requireLocationInScope(access, current.locationId);
          const [done] = await tx
            .update(shiftTemplate)
            .set({ deletedAt: new Date() })
            .where(and(eq(shiftTemplate.id, id), eq(shiftTemplate.version, body.version)))
            .returning();
          if (!done) throw stale();
          await audit(c, tx, access, {
            action: A.templateArchived,
            resourceType: "shift_template",
            resourceId: id,
          });
          return done;
        },
      );
      if (!row) throw problems.notFound();
      return c.json(templateItem(row), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/locations/{id}/shift-patterns",
      tags: ["scheduling"],
      summary: "Shift patterns at a location",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(ShiftPatternList, "Live patterns"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, READERS);
      const { id } = c.req.valid("param");
      requireLocationInScope(access, id);
      const rows = await withTenant(c, (tx) =>
        tx
          .select()
          .from(shiftPattern)
          .where(and(eq(shiftPattern.locationId, id), isNull(shiftPattern.deletedAt)))
          .orderBy(asc(shiftPattern.name)),
      );
      return c.json({ items: rows.map(patternItem) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/locations/{id}/shift-patterns",
      tags: ["scheduling"],
      summary: "Make a shift pattern",
      description:
        "A cycle of the location's live templates by day (day 0 is the first day the pattern is applied from).",
      security,
      request: { params: IdParam, body: jsonBody(CreateShiftPattern, "The pattern") },
      responses: {
        201: jsonBody(ShiftPatternItem, "Made"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "scheduling.rota.manage");
      const { id } = c.req.valid("param");
      requireLocationInScope(access, id);
      const body = c.req.valid("json");
      const row = await change(
        c,
        access,
        { action: A.patternCreated, resourceType: "location", id },
        async (tx) => {
          const live = await tx
            .select({ id: shiftTemplate.id })
            .from(shiftTemplate)
            .where(and(eq(shiftTemplate.locationId, id), isNull(shiftTemplate.deletedAt)));
          const found = checkPattern(
            body.cycleDays,
            body.entries,
            live.map((t) => t.id),
          );
          if (found.length > 0) {
            throw problems.invalid(found.map((p) => PATTERN_MESSAGES[p]).join(" "));
          }
          const [made] = await tx
            .insert(shiftPattern)
            .values({ locationId: id, ...body })
            .returning();
          if (!made) throw new Error("pattern not stored");
          await audit(c, tx, access, {
            action: A.patternCreated,
            resourceType: "shift_pattern",
            resourceId: made.id,
            scopeExtra: { locationId: id },
          });
          return made;
        },
      );
      return c.json(patternItem(row), 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/shift-patterns/{id}/archive",
      tags: ["scheduling"],
      summary: "Archive a shift pattern",
      security,
      request: { params: IdParam, body: jsonBody(ArchiveRotaItem, "Against version") },
      responses: {
        200: jsonBody(ShiftPatternItem, "Archived"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "scheduling.rota.manage");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const row = await change(
        c,
        access,
        { action: A.patternArchived, resourceType: "shift_pattern", id },
        async (tx) => {
          const [current] = await tx
            .select()
            .from(shiftPattern)
            .where(and(eq(shiftPattern.id, id), isNull(shiftPattern.deletedAt)));
          if (!current) return null;
          requireLocationInScope(access, current.locationId);
          const [done] = await tx
            .update(shiftPattern)
            .set({ deletedAt: new Date() })
            .where(and(eq(shiftPattern.id, id), eq(shiftPattern.version, body.version)))
            .returning();
          if (!done) throw stale();
          await audit(c, tx, access, {
            action: A.patternArchived,
            resourceType: "shift_pattern",
            resourceId: id,
          });
          return done;
        },
      );
      if (!row) throw problems.notFound();
      return c.json(patternItem(row), 200);
    },
  )
  // ----------------------------------------------------------------------------------------
  // Rotas and shifts
  // ----------------------------------------------------------------------------------------
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/locations/{id}/rotas",
      tags: ["scheduling"],
      summary: "Rotas at a location, newest first",
      security,
      request: { params: IdParam },
      responses: { 200: jsonBody(RotaList, "Rotas"), ...errorResponses, ...notFoundResponse },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, READERS);
      const { id } = c.req.valid("param");
      requireLocationInScope(access, id);
      const { rows, changed } = await withTenant(c, async (tx) => {
        const found = await tx
          .select()
          .from(rota)
          .where(and(eq(rota.locationId, id), isNull(rota.deletedAt)))
          .orderBy(desc(rota.startsOn));
        return { rows: found, changed: await rotasChangedSince(tx, found) };
      });
      return c.json({ items: rows.map((r) => rotaSummary(r, changed.has(r.id))) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/locations/{id}/rotas",
      tags: ["scheduling"],
      summary: "Start a rota",
      description: `A draft rota for a run of UK dates (at most ${ROTA_MAX_DAYS}); rotas at a location never overlap.`,
      security,
      request: { params: IdParam, body: jsonBody(CreateRota, "The dates") },
      responses: {
        201: jsonBody(RotaItem, "Started"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "scheduling.rota.manage");
      const { id } = c.req.valid("param");
      requireLocationInScope(access, id);
      const body = c.req.valid("json");
      if (body.endsOn < body.startsOn) {
        throw problems.invalid("The last date must not be before the first.");
      }
      const days = (Date.parse(body.endsOn) - Date.parse(body.startsOn)) / 86_400_000 + 1;
      if (days > ROTA_MAX_DAYS) {
        throw problems.invalid(`A rota covers at most ${ROTA_MAX_DAYS} days.`);
      }
      const item = await change(
        c,
        access,
        { action: A.rotaCreated, resourceType: "location", id },
        async (tx) => {
          const [made] = await tx
            .insert(rota)
            .values({ locationId: id, startsOn: body.startsOn, endsOn: body.endsOn })
            .returning();
          if (!made) throw new Error("rota not stored");
          await audit(c, tx, access, {
            action: A.rotaCreated,
            resourceType: "rota",
            resourceId: made.id,
            scopeExtra: { locationId: id },
          });
          return rotaItem(tx, made);
        },
      );
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/rotas/{id}",
      tags: ["scheduling"],
      summary: "A rota with its shifts and who is on them",
      security,
      request: { params: IdParam },
      responses: { 200: jsonBody(RotaItem, "The rota"), ...errorResponses, ...notFoundResponse },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, READERS);
      const { id } = c.req.valid("param");
      const item = await withTenant(c, async (tx) => {
        const row = await loadRota(tx, id);
        if (!row) return null;
        requireLocationInScope(access, row.locationId);
        return rotaItem(tx, row);
      });
      if (!item) throw problems.notFound();
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/rotas/{id}/apply-pattern",
      tags: ["scheduling"],
      summary: "Add a pattern's shifts to a rota",
      description:
        "Makes open shifts from the pattern's live templates on every date of the rota; the cycle runs from the pattern's first use at the location so the next rota carries on.",
      security,
      request: {
        params: IdParam,
        body: jsonBody(ApplyPattern, "The pattern and the rota's version"),
      },
      responses: {
        200: jsonBody(RotaItem, "The rota"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "scheduling.rota.manage");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const item = await change(
        c,
        access,
        { action: A.patternApplied, resourceType: "rota", id },
        async (tx) => {
          const row = await lockRota(tx, id);
          if (!row) return null;
          requireLocationInScope(access, row.locationId);
          if (row.version !== body.version) throw stale();
          const [pattern] = await tx
            .select()
            .from(shiftPattern)
            .where(
              and(
                eq(shiftPattern.id, body.patternId),
                eq(shiftPattern.locationId, row.locationId),
                isNull(shiftPattern.deletedAt),
              ),
            );
          if (!pattern)
            throw problems.invalid("That pattern is not a live pattern at this location.");
          const entries = pattern.entries as PatternEntry[];
          const templates = await tx
            .select()
            .from(shiftTemplate)
            .where(
              and(
                inArray(
                  shiftTemplate.id,
                  entries.map((e) => e.templateId),
                ),
                isNull(shiftTemplate.deletedAt),
              ),
            );
          // The cycle's day 0 is the pattern's own creation date at the location (UK).
          const anchor = ukIsoDate(pattern.createdAt);
          const made = patternShifts(pattern.cycleDays, entries, anchor, row.startsOn, row.endsOn)
            .map(({ date, templateId }) => {
              const t = templates.find((x) => x.id === templateId);
              if (!t) return null;
              const times = shiftTimes(date, t.startMinute, t.endMinute);
              return {
                rotaId: row.id,
                locationId: row.locationId,
                templateId: t.id,
                label: t.name,
                kind: t.kind,
                startsAt: times.start,
                endsAt: times.end,
                breakMinutes: t.breakMinutes,
                requiredCompetences: t.requiredCompetences,
                requiredSkills: t.requiredSkills,
                supervised: t.supervised,
              };
            })
            .filter((v): v is NonNullable<typeof v> => v !== null);
          if (made.length > 0) await tx.insert(shift).values(made);
          const [bumped] = await tx
            .update(rota)
            .set({ updatedAt: new Date() })
            .where(and(eq(rota.id, row.id), eq(rota.version, body.version)))
            .returning();
          if (!bumped) throw stale();
          await audit(c, tx, access, {
            action: A.patternApplied,
            resourceType: "rota",
            resourceId: row.id,
            scopeExtra: { patternId: pattern.id, shifts: made.length },
          });
          return rotaItem(tx, bumped);
        },
      );
      if (!item) throw problems.notFound();
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/rotas/{id}/shifts",
      tags: ["scheduling"],
      summary: "Add a shift to a rota",
      description:
        "From a live template at the location, or with its own times and needs. It starts open; a change after publishing is recorded for notice.",
      security,
      request: { params: IdParam, body: jsonBody(AddShift, "The shift") },
      responses: {
        201: jsonBody(RotaItem, "The rota"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "scheduling.rota.manage");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const item = await change(
        c,
        access,
        { action: A.shiftAdded, resourceType: "rota", id },
        async (tx) => {
          const row = await lockRota(tx, id);
          if (!row) return null;
          requireLocationInScope(access, row.locationId);
          if (body.date < row.startsOn || body.date > row.endsOn) {
            throw problems.invalid("The shift must start on one of the rota's dates.");
          }
          let shape: ShiftShape & { supervised: boolean; label: string; templateId: string | null };
          if ("templateId" in body) {
            const [t] = await tx
              .select()
              .from(shiftTemplate)
              .where(
                and(
                  eq(shiftTemplate.id, body.templateId),
                  eq(shiftTemplate.locationId, row.locationId),
                  isNull(shiftTemplate.deletedAt),
                ),
              );
            if (!t)
              throw problems.invalid("That template is not a live template at this location.");
            shape = {
              ...templateItem(t),
              templateId: t.id,
              label: body.label ?? t.name,
            } as typeof shape;
          } else {
            const problem = shapeProblems(body);
            if (problem) throw problems.invalid(problem);
            shape = { ...body, templateId: null };
          }
          const times = shiftTimes(body.date, shape.startMinute, shape.endMinute);
          const now = new Date();
          const [made] = await tx
            .insert(shift)
            .values({
              rotaId: row.id,
              locationId: row.locationId,
              templateId: shape.templateId,
              label: shape.label,
              kind: shape.kind,
              startsAt: times.start,
              endsAt: times.end,
              breakMinutes: shape.breakMinutes,
              requiredCompetences: [...shape.requiredCompetences],
              requiredSkills: [...shape.requiredSkills],
              supervised: shape.supervised,
              changedAfterPublishAt: row.publishedAt ? now : null,
            })
            .returning();
          if (!made) throw new Error("shift not stored");
          await audit(c, tx, access, {
            action: A.shiftAdded,
            resourceType: "shift",
            resourceId: made.id,
            scopeExtra: { rotaId: row.id },
          });
          return rotaItem(tx, row);
        },
      );
      if (!item) throw problems.notFound();
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/shifts/{id}/cancel",
      tags: ["scheduling"],
      summary: "Cancel a shift",
      description:
        "With a reason; whoever was on it comes off it. Recorded for notice once published.",
      security,
      request: { params: IdParam, body: jsonBody(CancelShift, "Against version, with a reason") },
      responses: {
        200: jsonBody(RotaItem, "The rota"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "scheduling.rota.manage");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const item = await change(
        c,
        access,
        { action: A.shiftCancelled, resourceType: "shift", id },
        async (tx) => {
          const found = await loadShift(tx, id);
          if (!found) return null;
          requireLocationInScope(access, found.locationId);
          const locked = await lockRota(tx, found.rotaId);
          const s = await loadShift(tx, id, true);
          if (!s || !locked) return null;
          const now = new Date();
          await tx
            .update(shiftAssignment)
            .set({ deletedAt: now, removeReason: body.reason })
            .where(and(eq(shiftAssignment.shiftId, id), isNull(shiftAssignment.deletedAt)));
          const [done] = await tx
            .update(shift)
            .set({
              deletedAt: now,
              cancelReason: body.reason,
              changedAfterPublishAt: s.publishedAt || locked.publishedAt ? now : null,
            })
            .where(and(eq(shift.id, id), eq(shift.version, body.version)))
            .returning();
          if (!done) throw stale();
          await audit(c, tx, access, {
            action: A.shiftCancelled,
            resourceType: "shift",
            resourceId: id,
            scopeExtra: { rotaId: s.rotaId },
          });
          const row = await loadRota(tx, s.rotaId);
          if (!row) throw new Error("rota not found");
          return rotaItem(tx, row);
        },
      );
      if (!item) throw problems.notFound();
      return c.json(item, 200);
    },
  )
  // ----------------------------------------------------------------------------------------
  // Assigning (HZ-124)
  // ----------------------------------------------------------------------------------------
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/shifts/{id}/eligibility",
      tags: ["scheduling"],
      summary: "Whether a member may work a shift",
      description:
        "The rostering rule on the shift's UK date: DBS, right to work, a current registration where the role needs one and each competence the shift needs (from the competence port). Gives the blockers in words, never a DBS detail; audited with ids only.",
      security,
      request: { params: IdParam, query: z.object({ workerId: z.uuid() }) },
      responses: {
        200: jsonBody(EligibilityItem, "The answer"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "scheduling.rota.manage");
      const { id } = c.req.valid("param");
      const { workerId } = c.req.valid("query");
      const item = await withTenant(c, async (tx) => {
        const s = await loadShift(tx, id);
        if (!s) return null;
        requireLocationInScope(access, s.locationId);
        if (!(await worksAt(tx, workerId, s.locationId))) return null;
        const decision = await shiftEligibility(tx, access.tenantId, s, workerId);
        await audit(c, tx, access, {
          action: A.eligibility,
          resourceType: "shift",
          resourceId: id,
          scopeExtra: { workerId, allowed: decision.allowed },
        });
        return {
          workerId,
          shiftId: id,
          date: ukIsoDate(s.startsAt),
          allowed: decision.allowed,
          blockers: blockerItems(decision.allowed ? [] : decision.blockers),
          overridable: decision.allowed || decision.overridable,
        };
      });
      if (!item) throw problems.notFound();
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/shifts/{id}/assignment",
      tags: ["scheduling"],
      summary: "Put a member on a shift",
      description:
        "Applies the rostering rule (HZ-124). A blocked member is refused (422 not_eligible) unless an override with a justification is sent by a holder of scheduling.rota.approve at the location, never for themselves and never for a missing right to work. Returns the member's working time with the shift, as advice.",
      security,
      request: { params: IdParam, body: jsonBody(AssignShift, "Who, against the shift's version") },
      responses: {
        201: jsonBody(AssignmentResult, "Assigned"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      let access = await requirePermission(c, "scheduling.rota.manage");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      if (body.override) {
        // A manager's override needs the approve permission there (and the database checks it).
        access = await requirePermission(c, "scheduling.rota.approve");
        if (body.workerId === access.tenantUserId) {
          await writeAudit(c.get("services").appPool, access, {
            action: A.overridden,
            outcome: "denied",
            resourceType: "shift",
            resourceId: id,
            reason: "own_override",
            requestId: c.get("requestId"),
          });
          throw new HttpProblem(
            403,
            "separation_of_duties",
            "Someone else must override the rostering rule for your own shift.",
          );
        }
      }
      const result = await change(
        c,
        access,
        { action: A.assigned, resourceType: "shift", id },
        async (tx) => {
          const found = await loadShift(tx, id);
          if (!found) return null;
          requireLocationInScope(access, found.locationId);
          const locked = await lockRota(tx, found.rotaId);
          const s = await loadShift(tx, id, true);
          if (!s || !locked) return null;
          if (s.version !== body.version) throw stale();
          if (!(await worksAt(tx, body.workerId, s.locationId))) return null;
          // Bank and agency workers go on a shift by booking (scheduling.md section 15 rule 2; the
          // database refuses it otherwise): the booking records the cost and opens their access.
          if (await isAgencyMember(tx, body.workerId)) {
            return {
              refused: new HttpProblem(
                409,
                "book_instead",
                "This is a bank or agency worker: book them onto the shift instead.",
              ),
            };
          }
          // HZ-124: never onto a shift on a day the member is away (section 17 rule 8).
          if (await memberAwayFor(tx, body.workerId, s)) {
            await audit(c, tx, access, {
              action: A.assigned,
              outcome: "denied",
              resourceType: "shift",
              resourceId: id,
              reason: "member_absent",
              scopeExtra: { workerId: body.workerId },
            });
            return {
              refused: new HttpProblem(
                409,
                "member_absent",
                "This member is away on the day of this shift (approved leave or a recorded absence). Choose someone else.",
              ),
            };
          }
          const now = new Date();
          const decision = await shiftEligibility(
            tx,
            access.tenantId,
            s,
            body.workerId,
            body.override ?? null,
            now,
          );
          if (!decision.allowed) {
            const words = decision.blockers
              .map((b) => blockerItems([b])[0]?.message)
              .filter(Boolean)
              .join(" ");
            if (decision.overrideRefused === "blockers_changed") {
              await audit(c, tx, access, {
                action: A.overridden,
                outcome: "denied",
                resourceType: "shift",
                resourceId: id,
                reason: "blockers_changed",
                scopeExtra: { workerId: body.workerId },
              });
              return {
                refused: new HttpProblem(
                  409,
                  "blockers_changed",
                  "What stops this member working the shift has changed since you looked. Check it again before overriding.",
                  words,
                ),
              };
            }
            const code = decision.blockers.some((b) => b.kind === "right_to_work")
              ? "right_to_work"
              : decision.blockers.some((b) => b.kind === "not_active")
                ? "not_active"
                : "not_eligible";
            await audit(c, tx, access, {
              action: A.assigned,
              outcome: "denied",
              resourceType: "shift",
              resourceId: id,
              reason: code,
              scopeExtra: { workerId: body.workerId },
            });
            return {
              refused: new HttpProblem(
                422,
                code,
                code === "right_to_work"
                  ? "This member cannot be put on this shift: there is no right to work on record for the day. This cannot be overridden."
                  : code === "not_active"
                    ? "This member is not working for your organisation on the day. This cannot be overridden."
                    : "This member cannot be put on this shift without a manager's override.",
                words,
              ),
            };
          }
          await lockWorker(tx, access.tenantId, body.workerId);
          if (await doubleBooked(tx, body.workerId, s)) {
            throw stateConflict("This member is already on a shift at that time.");
          }
          const [made] = await tx
            .insert(shiftAssignment)
            .values({ shiftId: s.id, locationId: s.locationId, workerId: body.workerId })
            .returning();
          if (!made) throw new Error("assignment not stored");
          await markChanged(tx, s, locked, now);
          if (decision.overridden.length > 0 && body.override) {
            await tx.insert(rosterOverride).values({
              assignmentId: made.id,
              locationId: s.locationId,
              workerId: body.workerId,
              blockerKeys: decision.overridden.map(blockerKey),
              justification: body.override.justification,
            });
            await audit(c, tx, access, {
              action: A.overridden,
              resourceType: "shift_assignment",
              resourceId: made.id,
              scopeExtra: { workerId: body.workerId, blockers: decision.overridden.length },
            });
          }
          await audit(c, tx, access, {
            action: A.assigned,
            resourceType: "shift_assignment",
            resourceId: made.id,
            scopeExtra: { shiftId: s.id, workerId: body.workerId },
          });
          const row = locked;
          const { shifts, assignmentOf, overriddenOf, coverNeededOf } = await rotaShifts(
            tx,
            row.id,
          );
          const names = await staffNames(tx, [body.workerId]);
          const current = shifts.find((x) => x.id === s.id) ?? s;
          return {
            item: {
              shift: shiftItem(current, assignmentOf(s.id), overriddenOf, names, coverNeededOf),
              eligibility: {
                workerId: body.workerId,
                shiftId: s.id,
                date: ukIsoDate(s.startsAt),
                allowed: true,
                blockers: blockerItems(decision.overridden),
                overridable: true,
              },
              workingTime: await workingTimeFor(
                tx,
                body.workerId,
                row,
                new Set(shifts.map((x) => x.id)),
              ),
            },
          };
        },
      );
      if (!result) throw problems.notFound();
      if ("refused" in result) throw result.refused;
      return c.json(result.item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/shift-assignments/{id}/remove",
      tags: ["scheduling"],
      summary: "Take a member off a shift",
      description: "With a reason; the shift becomes open. Recorded for notice once published.",
      security,
      request: {
        params: IdParam,
        body: jsonBody(RemoveAssignment, "Against version, with a reason"),
      },
      responses: {
        200: jsonBody(RotaItem, "The rota"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "scheduling.rota.manage");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const item = await change(
        c,
        access,
        { action: A.removed, resourceType: "shift_assignment", id },
        async (tx) => {
          const [a] = await tx
            .select()
            .from(shiftAssignment)
            .where(and(eq(shiftAssignment.id, id), isNull(shiftAssignment.deletedAt)));
          if (!a) return null;
          requireLocationInScope(access, a.locationId);
          const parent = await loadShift(tx, a.shiftId);
          const locked = parent ? await lockRota(tx, parent.rotaId) : null;
          const now = new Date();
          const [done] = await tx
            .update(shiftAssignment)
            .set({ deletedAt: now, removeReason: body.reason })
            .where(and(eq(shiftAssignment.id, id), eq(shiftAssignment.version, body.version)))
            .returning();
          if (!done) throw stale();
          // A cover need on it is met by taking the member off: someone else can be put on.
          await resolveCoverNeeds(tx, { assignmentId: id }, "assignment_removed");
          const s = await loadShift(tx, a.shiftId);
          if (s && locked) await markChanged(tx, s, locked, now);
          await audit(c, tx, access, {
            action: A.removed,
            resourceType: "shift_assignment",
            resourceId: id,
            scopeExtra: { shiftId: a.shiftId },
          });
          if (!locked) throw new Error("rota not found");
          return rotaItem(tx, locked);
        },
      );
      if (!item) throw problems.notFound();
      return c.json(item, 200);
    },
  )
  // ----------------------------------------------------------------------------------------
  // The check and publishing (HZ-123, HZ-124)
  // ----------------------------------------------------------------------------------------
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/rotas/{id}/check",
      tags: ["scheduling"],
      summary: "The check before publishing",
      description:
        "For each date and shift period: the rota against your organisation's own dependency scale, with the method, the source, the notice and every warning ('met, but' whenever a warning stands); each member's working time as advice; and each assignment's eligibility again. Needs scheduling.rota.manage and care.plan.read across the whole location. A care-record view, audited.",
      security,
      request: { params: IdParam },
      responses: { 200: jsonBody(RotaCheck, "The check"), ...errorResponses, ...notFoundResponse },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const access = await requireWholeLocation(c, id, A.checked);
      const check = await withTenant(c, async (tx) => {
        const row = await loadRota(tx, id);
        if (!row) return null;
        const result = await rotaCheck(tx, access.tenantId, row);
        await audit(c, tx, access, {
          action: A.checked,
          resourceType: "rota",
          resourceId: id,
          scopeExtra: {
            digest: result.digest,
            staffing: result.staffing.length,
            blocked: result.blockedAssignmentIds.length,
          },
        });
        return result;
      });
      if (!check) throw problems.notFound();
      return c.json(check, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/rotas/{id}/publish",
      tags: ["scheduling"],
      summary: "Publish a rota",
      description:
        "Sends back the digest of the check the publisher was shown: a check that has changed since is refused (409 check_changed) so the new one is seen first. A warning on the check needs acknowledgeWarnings; the comparison and working time never block. An assignment the rostering rule blocks with no override covering it is refused (422 ineligible_assignments). Records the notice given.",
      security,
      request: { params: IdParam, body: jsonBody(PublishRota, "Against version and digest") },
      responses: {
        200: jsonBody(RotaItem, "Published"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const access = await requireWholeLocation(c, id, A.published);
      const result = await change(
        c,
        access,
        { action: A.published, resourceType: "rota", id },
        async (tx) => {
          const row = await lockRota(tx, id);
          if (!row) return null;
          if (row.version !== body.version) throw stale();
          const now = new Date();
          const check = await rotaCheck(tx, access.tenantId, row, now);
          const refuse = async (problem: HttpProblem) => {
            await audit(c, tx, access, {
              action: A.published,
              outcome: "denied",
              resourceType: "rota",
              resourceId: id,
              reason: problem.code,
            });
            return { refused: problem };
          };
          if (check.digest !== body.digest) {
            return refuse(
              new HttpProblem(
                409,
                "check_changed",
                "The check has changed since you read it. Read it again before publishing.",
              ),
            );
          }
          // The publisher must have read this very check themselves, recently (clinical safety
          // review round 1, H4): its digest is on their own `scheduling.rota.checked` audit event.
          if (!(await checkSeen(tx, access.tenantUserId, id, check.digest))) {
            return refuse(
              new HttpProblem(
                409,
                "check_not_seen",
                "Read the check yourself before publishing: it was read by someone else, or too long ago.",
              ),
            );
          }
          if (check.blockedAssignmentIds.length > 0) {
            return refuse(
              new HttpProblem(
                422,
                "ineligible_assignments",
                "Some members on this rota may not work their shifts now. Take them off, or a manager may override where the rule allows.",
                `${check.blockedAssignmentIds.length} assignment(s) blocked.`,
              ),
            );
          }
          const missing = check.periodsToAcknowledge.filter(
            (p) => !body.acknowledgedPeriods.includes(p),
          );
          if (missing.length > 0) {
            return refuse(
              new HttpProblem(
                422,
                "periods_not_acknowledged",
                "Confirm each period that falls short of your scale, or has no figure, by name before publishing.",
                missing.join(", "),
              ),
            );
          }
          if (check.hasWarnings && !body.acknowledgeWarnings) {
            return refuse(
              new HttpProblem(
                422,
                "warnings_not_acknowledged",
                "Read the warnings on the check and confirm you have read them before publishing.",
              ),
            );
          }
          const { shifts } = await rotaShifts(tx, row.id);
          const shiftIds = shifts.map((s) => s.id);
          if (shiftIds.length > 0) {
            await tx
              .update(shift)
              .set({ publishedAt: now })
              .where(and(inArray(shift.id, shiftIds), isNull(shift.publishedAt)));
            await tx
              .update(shiftAssignment)
              .set({ publishedAt: now })
              .where(
                and(
                  inArray(shiftAssignment.shiftId, shiftIds),
                  isNull(shiftAssignment.deletedAt),
                  isNull(shiftAssignment.publishedAt),
                ),
              );
          }
          const [done] = await tx
            .update(rota)
            .set({ state: "published", publishedAt: now })
            .where(and(eq(rota.id, row.id), eq(rota.version, body.version)))
            .returning();
          if (!done) throw stale();
          const first = shifts[0]?.startsAt ?? null;
          const [publication] = await tx
            .insert(rotaPublication)
            .values({
              rotaId: row.id,
              locationId: row.locationId,
              publishedBy: access.tenantUserId,
              publishedAt: now,
              firstShiftStart: first,
              noticeMinutes: noticeMinutes(now, first),
              shiftCount: shifts.length,
              openShiftCount: check.openShiftIds.length,
              overrideCount: check.eligibility.filter((e) => !e.allowed && e.covered).length,
              workingTimeBreaches: check.workingTime.reduce(
                (n, w) => n + w.findings.filter((f) => f.outcome === "breach").length,
                0,
              ),
              workingTimeConditionals: check.workingTime.reduce(
                (n, w) => n + w.findings.filter((f) => f.outcome === "conditional").length,
                0,
              ),
              staffing: check.staffing.map((s) => ({
                date: s.date,
                periodKey: s.periodKey,
                status: s.status,
              })),
              checkDigest: check.digest,
            })
            .returning();
          if (!publication) throw new Error("publication not stored");
          await audit(c, tx, access, {
            action: A.published,
            resourceType: "rota",
            resourceId: row.id,
            scopeExtra: { publicationId: publication.id, acknowledged: body.acknowledgeWarnings },
          });
          await publish(tx, {
            context: "scheduling",
            aggregateType: "rota",
            aggregateId: row.id,
            type: "scheduling.rota_published",
            payload: {
              rotaId: row.id,
              locationId: row.locationId,
              publicationId: publication.id,
            },
          });
          return { item: await rotaItem(tx, done) };
        },
      );
      if (!result) throw problems.notFound();
      if ("refused" in result) throw result.refused;
      return c.json(result.item, 200);
    },
  )
  // ----------------------------------------------------------------------------------------
  // A member's own shifts
  // ----------------------------------------------------------------------------------------
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/me/shifts",
      tags: ["scheduling"],
      summary: "My published shifts",
      description: "The member's own shifts on published rotas, between two UK dates.",
      security,
      request: { query: z.object({ from: z.iso.date(), to: z.iso.date() }) },
      responses: { 200: jsonBody(MyShiftList, "Shifts"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, "scheduling.timesheet.self");
      const { from, to } = c.req.valid("query");
      if (to < from) throw problems.invalid("The last date must not be before the first.");
      const rows = await withTenant(c, (tx) =>
        tx
          .select({
            shiftId: shift.id,
            locationId: shift.locationId,
            label: shift.label,
            kind: shift.kind,
            startsAt: shift.startsAt,
            endsAt: shift.endsAt,
            breakMinutes: shift.breakMinutes,
            changedAfterPublishAt: shift.changedAfterPublishAt,
          })
          .from(shiftAssignment)
          .innerJoin(shift, eq(shift.id, shiftAssignment.shiftId))
          .where(
            and(
              eq(shiftAssignment.workerId, access.tenantUserId),
              isNull(shiftAssignment.deletedAt),
              isNotNull(shiftAssignment.publishedAt),
              isNull(shift.deletedAt),
              isNotNull(shift.publishedAt),
              gte(shift.startsAt, ukStartOfDay(from)),
              lt(shift.startsAt, ukEndOfDay(to)),
            ),
          )
          .orderBy(asc(shift.startsAt)),
      );
      return c.json(
        {
          items: rows.map((r) => ({
            ...r,
            kind: r.kind as z.infer<typeof ShiftTemplateItem>["kind"],
            startsAt: r.startsAt.toISOString(),
            endsAt: r.endsAt.toISOString(),
            changedAfterPublishAt: iso(r.changedAfterPublishAt),
          })),
        },
        200,
      );
    },
  );
