import { createHash } from "node:crypto";
import {
  AbsenceDetail,
  AbsenceItem,
  AbsenceList,
  AbsenceListQuery,
  BradfordResult,
  CancelAbsence,
  DecideAbsence,
  EndAbsence,
  ExcludeFromBradford,
  FitNoteItem,
  FitNoteQuery,
  NewAbsence,
  NewReturnToWork,
  ReturnToWorkItem,
  SspQuery,
  SspResultItem,
} from "@harbour/contracts";
import {
  absence,
  document,
  fitNote,
  returnToWork,
  shift,
  shiftAssignment,
  shiftCoverNeed,
  type Transaction,
  tenant,
} from "@harbour/db";
import {
  ABSENCE_RATE_KEYS,
  type AbsenceKind,
  type AbsenceState,
  absenceDays,
  bradfordDays,
  bradfordFactor,
  can,
  checkAbsenceMove,
  checkNewAbsence,
  fitNoteNeeded,
  PAY_RATE_KEYS,
  type Permission,
  periodsOfIncapacity,
  qualifyingDaysIn,
  type RateNation,
  resolveAbsenceRates,
  resolvePayRates,
  sickPay,
  ukIsoDate,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Context } from "hono";
import { withAuditedRefusal } from "../http/audit";
import {
  type AppEnv,
  requireAnyPermission,
  requirePermission,
  type TenantAccess,
  withTenant,
} from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { raiseCoverNeeds, resolveCoverNeeds } from "../services/absence";
import {
  contentHeaders,
  destroyingOnFailure,
  imagePrintableOf,
  readDocumentContent,
  storeDocument,
} from "../services/documents";
import { rateRows } from "../services/rates";
import { staffNames } from "../services/staff";
import { withSystemRights } from "../services/system-rights";
import { fileBody, fileResponse } from "./documents";
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
 * Absence and leave (scheduling.md section 15; SCHED-010; hazards HZ-123, HZ-124). A member asks
 * for their own leave; a rota manager records a sickness or leave; an approver (never the member)
 * decides; approving or recording raises a cover need on each of the member's rostered shifts it
 * touches, and the rota counts those shifts as open. Fit notes, return to work, the Bradford factor
 * and SSP working are for holders of workforce.hr_document.read (health data). Audit events carry
 * ids, kinds, dates and counts only, never a reason, a note or anything from a fit note.
 */

type Tx = Transaction;
type AbsenceRow = typeof absence.$inferSelect;

const SELF = "scheduling.timesheet.self";
const MANAGE = "scheduling.rota.manage";
const APPROVE = "scheduling.rota.approve";
const HR = "workforce.hr_document.read";
const LIST_LIMIT = 500;
const tags = ["scheduling"];
const IdParam = z.object({ id: z.uuid() });
const FitNoteParam = z.object({ id: z.uuid(), fitNoteId: z.uuid() });

const A = {
  requested: "scheduling.absence.requested",
  recorded: "scheduling.absence.recorded",
  approved: "scheduling.absence.approved",
  declined: "scheduling.absence.declined",
  cancelled: "scheduling.absence.cancelled",
  ended: "scheduling.absence.ended",
  excluded: "scheduling.absence.bradford_excluded",
  viewed: "scheduling.absence.viewed",
  fitNoteAdded: "workforce.fit_note.added",
  fitNoteViewed: "workforce.fit_note.viewed",
  returnToWork: "workforce.return_to_work.recorded",
  bradford: "workforce.bradford.viewed",
  ssp: "scheduling.ssp.calculated",
} as const;

const BRADFORD_NOTICE =
  "The Bradford factor is shown with its working only. Harbour never compares it with a trigger, raises a task or changes anything because of it; leave out absences that must not count against someone (pregnancy-related, disability-related) before reading it.";
const SSP_NOTICE =
  "Advice for payroll from the statutory rules and your figures: Harbour pays nothing and keeps no pay figure. Check it against your payroll before paying.";

const stale = () =>
  new HttpProblem(
    409,
    "version_conflict",
    "This was changed since you loaded it. Reload it and try again.",
  );
const PROBLEM_WORDS: Record<string, string> = {
  decider_is_member: "Someone other than the person away must decide this.",
  wrong_state: "This absence can no longer be changed that way.",
  reason_required: "Give a reason.",
  ends_before_start: "The last day cannot be before the first day.",
  sickness_not_requested: "A sickness is recorded by a manager, not asked for.",
  leave_needs_end: "Leave needs a last day.",
};
const refusal = (code: string) =>
  new HttpProblem(422, `absence_${code}`, PROBLEM_WORDS[code] ?? "That is not allowed.");

/** Database refusals said plainly; the database's own message never passes on. */
async function inTx<T>(c: Context<AppEnv>, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await withTenant(c, fn);
  } catch (error) {
    if (error instanceof HttpProblem) throw error;
    const code = dbCode(error);
    if (code === "23514" || code === "23505") {
      throw new HttpProblem(
        422,
        "absence_not_allowed",
        "That change is not allowed for this absence.",
      );
    }
    if (code === "42501") throw problems.forbidden();
    throw error;
  }
}

async function loadAbsence(tx: Tx, id: string): Promise<AbsenceRow> {
  const [row] = await tx.select().from(absence).where(eq(absence.id, id));
  if (!row) throw problems.notFound();
  return row;
}

/** Whether a member holds a role in force at a home (or across the organisation). */
async function worksAt(tx: Tx, memberId: string, locationId: string): Promise<boolean> {
  const rows = await withSystemRights(tx, () =>
    tx.execute<{ ok: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM public.role_assignment ra
        WHERE ra.tenant_user_id = ${memberId} AND ra.deleted_at IS NULL
          AND ra.valid_from <= now() AND (ra.valid_to IS NULL OR ra.valid_to > now())
          AND (ra.location_id = ${locationId} OR ra.location_id IS NULL)) AS ok`),
  );
  return rows.rows[0]?.ok === true;
}

async function nationOf(tx: Tx): Promise<Exclude<RateNation, "uk" | "all">> {
  const [t] = await tx.select({ nation: tenant.nation }).from(tenant);
  return (t?.nation ?? "england") as Exclude<RateNation, "uk" | "all">;
}

const holdsAt = (access: TenantAccess, permission: string) =>
  can(access.effective, permission as Permission);

async function openCoverCount(tx: Tx, ids: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const rows = await tx
    .select({ absenceId: shiftCoverNeed.absenceId, n: sql<number>`count(*)::int` })
    .from(shiftCoverNeed)
    .where(and(inArray(shiftCoverNeed.absenceId, [...ids]), isNull(shiftCoverNeed.resolvedAt)))
    .groupBy(shiftCoverNeed.absenceId);
  for (const r of rows) out.set(r.absenceId, Number(r.n));
  return out;
}

async function itemsOf(tx: Tx, access: TenantAccess, rows: readonly AbsenceRow[]) {
  const names = await staffNames(
    tx,
    rows.map((r) => r.memberId),
  );
  const cover = await openCoverCount(
    tx,
    rows.map((r) => r.id),
  );
  const hr = holdsAt(access, HR);
  const today = ukIsoDate(new Date());
  const nation = await nationOf(tx);
  const rates = hr
    ? resolveAbsenceRates(
        await rateRows(tx, Object.values(ABSENCE_RATE_KEYS)),
        nation,
        today,
        access.tenantId,
      )
    : null;
  const sick = rows.filter((r) => r.kind === "sickness").map((r) => r.id);
  const notes =
    hr && sick.length > 0
      ? await tx
          .select({
            absenceId: fitNote.absenceId,
            coversFrom: fitNote.coversFrom,
            coversTo: fitNote.coversTo,
          })
          .from(fitNote)
          .where(inArray(fitNote.absenceId, sick))
      : [];
  return rows.map((r) => {
    const name = names(r.memberId);
    let uncovered: string[] | null = null;
    if (hr && rates && r.kind === "sickness") {
      const need = fitNoteNeeded(
        r.startsOn,
        r.endsOn,
        today,
        notes.filter((n) => n.absenceId === r.id),
        rates,
      );
      uncovered = need.needed ? [...need.uncoveredDays] : [];
    }
    return {
      id: r.id,
      version: r.version,
      member: { id: r.memberId, displayName: name?.displayName ?? "Member of staff" },
      locationId: r.locationId,
      kind: r.kind as AbsenceKind,
      startsOn: r.startsOn,
      endsOn: r.endsOn,
      state: r.state as AbsenceState,
      decidedBy: r.decidedBy,
      decidedAt: r.decidedAt?.toISOString() ?? null,
      decisionReason: r.decisionReason,
      selfCertifiedAt: r.selfCertifiedAt?.toISOString() ?? null,
      bradfordExcluded: r.bradfordExcludedReason !== null,
      coverNeeded: cover.get(r.id) ?? 0,
      fitNoteUncoveredDays: uncovered,
    };
  });
}

const fitNoteOut = (n: typeof fitNote.$inferSelect) => ({
  id: n.id,
  absenceId: n.absenceId,
  documentId: n.documentId,
  issuedOn: n.issuedOn,
  coversFrom: n.coversFrom,
  coversTo: n.coversTo,
  fitness: n.fitness as "not_fit" | "may_be_fit",
  phasedReturn: n.phasedReturn,
  amendedDuties: n.amendedDuties,
  alteredHours: n.alteredHours,
  workplaceAdaptations: n.workplaceAdaptations,
  createdAt: n.createdAt.toISOString(),
});

const rtwOut = (r: typeof returnToWork.$inferSelect) => ({
  id: r.id,
  absenceId: r.absenceId,
  heldOn: r.heldOn,
  heldBy: r.heldBy,
  fitForUsualDuties: r.fitForUsualDuties,
  phasedReturn: r.phasedReturn,
  amendedDuties: r.amendedDuties,
  alteredHours: r.alteredHours,
  workplaceAdaptations: r.workplaceAdaptations,
  notes: r.notes,
  createdAt: r.createdAt.toISOString(),
});

async function detailOf(tx: Tx, access: TenantAccess, row: AbsenceRow) {
  const [item] = await itemsOf(tx, access, [row]);
  if (!item) throw problems.notFound();
  const hr = holdsAt(access, HR);
  const notes =
    hr && row.kind === "sickness"
      ? await tx.select().from(fitNote).where(eq(fitNote.absenceId, row.id))
      : null;
  const [rtw] =
    hr && row.kind === "sickness"
      ? await tx.select().from(returnToWork).where(eq(returnToWork.absenceId, row.id))
      : [];
  return {
    ...item,
    fitNotes: notes ? notes.map(fitNoteOut) : null,
    returnToWork: rtw ? rtwOut(rtw) : null,
    bradfordExcludedReason: hr ? row.bradfordExcludedReason : null,
  };
}

/** Changes an absence at the version loaded, through the domain's rule for the move. */
async function move(
  tx: Tx,
  access: TenantAccess,
  row: AbsenceRow,
  expected: number,
  to: AbsenceState,
  reason: string | null,
  set: Partial<typeof absence.$inferInsert> = {},
) {
  if (row.version !== expected) throw stale();
  const problem = checkAbsenceMove({
    from: row.state as AbsenceState,
    to,
    memberId: row.memberId,
    actorId: access.tenantUserId,
    reason,
  });
  if (problem) throw refusal(problem);
  const [saved] = await tx
    .update(absence)
    .set({ state: to, ...(reason ? { decisionReason: reason } : {}), ...set })
    .where(and(eq(absence.id, row.id), eq(absence.version, expected)))
    .returning();
  if (!saved) throw stale();
  return saved;
}

const versioned = <S extends z.ZodType>(schema: S) => ({
  params: IdParam,
  body: { content: { "application/json": { schema } } },
});
const absenceResponses = {
  200: jsonBody(AbsenceItem, "The absence"),
  ...errorResponses,
  ...notFoundResponse,
  ...conflictResponse,
};

export const absencesRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/absences",
      tags,
      summary: "Absences and leave a member may see",
      description:
        "scheduling.timesheet.self (one's own), scheduling.rota.manage or .approve (those at the homes they reach; row-level security decides). Filter by home, member and dates; newest first, up to 500. Fit note coverage only for holders of workforce.hr_document.read.",
      security,
      request: { query: AbsenceListQuery },
      responses: { 200: jsonBody(AbsenceList, "Absences"), ...errorResponses },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [SELF, MANAGE, APPROVE]);
      const q = c.req.valid("query");
      if (q.locationId) requireLocationInScope(access, q.locationId);
      const body = await inTx(c, async (tx) => {
        const rows = await tx
          .select()
          .from(absence)
          .where(
            and(
              isNull(absence.deletedAt),
              q.locationId ? eq(absence.locationId, q.locationId) : undefined,
              q.memberId ? eq(absence.memberId, q.memberId) : undefined,
              q.to ? lte(absence.startsOn, q.to) : undefined,
              q.from ? or(isNull(absence.endsOn), gte(absence.endsOn, q.from)) : undefined,
            ),
          )
          .orderBy(desc(absence.startsOn), desc(absence.id))
          .limit(LIST_LIMIT + 1);
        return {
          items: await itemsOf(tx, access, rows.slice(0, LIST_LIMIT)),
          truncated: rows.length > LIST_LIMIT,
        };
      });
      return c.json(body, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/absences",
      tags,
      summary: "Ask for one's own leave, or record a sickness or leave for a member",
      description:
        "Without memberId (or one's own): scheduling.timesheet.self, at a home where the member holds a role; leave kinds only (state requested). With another member: scheduling.rota.manage at the home (state recorded), which raises a cover need on each of the member's rostered shifts it touches (HZ-123). Audited (scheduling.absence.requested or .recorded) with the kind and dates.",
      security,
      request: { body: { content: { "application/json": { schema: NewAbsence } } } },
      responses: { 201: jsonBody(AbsenceItem, "Stored"), ...errorResponses, ...notFoundResponse },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const access = await requireAnyPermission(c, [SELF, MANAGE]);
      const own = !body.memberId || body.memberId === access.tenantUserId;
      if (!own) {
        await requirePermission(c, MANAGE);
        requireLocationInScope(access, body.locationId);
      } else {
        await requirePermission(c, SELF);
      }
      const problem = checkNewAbsence({
        kind: body.kind,
        startsOn: body.startsOn,
        endsOn: body.endsOn,
        requested: own,
      });
      if (problem) throw refusal(problem);
      if (body.selfCertified && body.kind !== "sickness") {
        throw problems.invalid("Only a sickness is self-certified.");
      }
      const memberId = own ? access.tenantUserId : (body.memberId as string);
      const out = await inTx(c, async (tx) => {
        if (!(await worksAt(tx, memberId, body.locationId))) throw problems.notFound();
        const [row] = await tx
          .insert(absence)
          .values({
            memberId,
            locationId: body.locationId,
            kind: body.kind,
            startsOn: body.startsOn,
            endsOn: body.endsOn,
            state: own ? "requested" : "recorded",
            selfCertifiedAt: body.selfCertified ? new Date() : null,
          })
          .returning();
        if (!row) throw new Error("absence not stored");
        const raised = own ? 0 : await raiseCoverNeeds(tx, row);
        await audit(c, tx, access, {
          action: own ? A.requested : A.recorded,
          resourceType: "absence",
          resourceId: row.id,
          scopeExtra: {
            memberId,
            kind: row.kind,
            startsOn: row.startsOn,
            endsOn: row.endsOn,
            coverNeeds: raised,
          },
        });
        const [item] = await itemsOf(tx, access, [row]);
        return item;
      });
      return c.json(out, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/absences/{id}",
      tags,
      summary: "One absence; with its fit notes and return to work for HR",
      description:
        "As the list. Fit notes, the return to work record and the Bradford exclusion reason only for holders of workforce.hr_document.read. Audited (scheduling.absence.viewed) for a sickness.",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(AbsenceDetail, "The absence"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [SELF, MANAGE, APPROVE, HR]);
      const { id } = c.req.valid("param");
      const out = await inTx(c, async (tx) => {
        const row = await loadAbsence(tx, id);
        if (row.kind === "sickness") {
          await audit(c, tx, access, { action: A.viewed, resourceType: "absence", resourceId: id });
        }
        return detailOf(tx, access, row);
      });
      c.header("cache-control", "private, no-store");
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/absences/{id}/decision",
      tags,
      summary: "Approve or decline a leave request",
      description:
        "scheduling.rota.approve at the home, never the member themselves (422 absence_decider_is_member; the database refuses it too). A decline needs a reason. Approving raises a cover need on each of the member's rostered shifts the leave touches (HZ-123). Audited (scheduling.absence.approved or .declined), never the reason.",
      security,
      request: versioned(DecideAbsence),
      responses: absenceResponses,
    }),
    async (c) => {
      const access = await requirePermission(c, APPROVE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const out = await inTx(c, async (tx) => {
        const row = await loadAbsence(tx, id);
        requireLocationInScope(access, row.locationId);
        const to = body.decision === "approve" ? "approved" : "declined";
        const saved = await move(tx, access, row, body.version, to, body.reason ?? null, {
          decidedBy: access.tenantUserId,
          decidedAt: new Date(),
        });
        const raised = to === "approved" ? await raiseCoverNeeds(tx, saved) : 0;
        await audit(c, tx, access, {
          action: to === "approved" ? A.approved : A.declined,
          resourceType: "absence",
          resourceId: id,
          scopeExtra: { coverNeeds: raised },
        });
        const [item] = await itemsOf(tx, access, [saved]);
        return item;
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/absences/{id}/cancel",
      tags,
      summary: "Cancel an absence",
      description:
        "The member cancels their own request before it is decided (scheduling.timesheet.self); a rota manager or approver at the home cancels an approved or recorded absence with a reason. Its open cover needs are resolved (absence_ended). Audited (scheduling.absence.cancelled), never the reason.",
      security,
      request: versioned(CancelAbsence),
      responses: absenceResponses,
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [SELF, MANAGE, APPROVE]);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const out = await inTx(c, async (tx) => {
        const row = await loadAbsence(tx, id);
        if (row.memberId !== access.tenantUserId) requireLocationInScope(access, row.locationId);
        const saved = await move(tx, access, row, body.version, "cancelled", body.reason ?? null);
        const resolved = await resolveCoverNeeds(tx, { absenceId: id }, "absence_ended");
        await audit(c, tx, access, {
          action: A.cancelled,
          resourceType: "absence",
          resourceId: id,
          scopeExtra: { coverNeedsResolved: resolved },
        });
        const [item] = await itemsOf(tx, access, [saved]);
        return item;
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/absences/{id}/end",
      tags,
      summary: "Record a sickness's last day",
      description:
        "scheduling.rota.manage at the home, for an open sickness (approved or recorded). Cover needs on shifts after the last day are resolved. Audited (scheduling.absence.ended) with the date.",
      security,
      request: versioned(EndAbsence),
      responses: absenceResponses,
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const out = await inTx(c, async (tx) => {
        const row = await loadAbsence(tx, id);
        requireLocationInScope(access, row.locationId);
        if (
          row.kind !== "sickness" ||
          row.endsOn !== null ||
          !["recorded", "approved"].includes(row.state)
        ) {
          throw new HttpProblem(
            409,
            "absence_not_open",
            "Only an open sickness is ended this way.",
          );
        }
        if (body.endsOn < row.startsOn) throw refusal("ends_before_start");
        if (body.endsOn > ukIsoDate(new Date())) {
          throw problems.invalid("The last day cannot be in the future.");
        }
        if (row.version !== body.version) throw stale();
        const [saved] = await tx
          .update(absence)
          .set({ endsOn: body.endsOn })
          .where(and(eq(absence.id, id), eq(absence.version, body.version)))
          .returning();
        if (!saved) throw stale();
        const resolved = await resolveCoverNeeds(
          tx,
          { absenceId: id },
          "absence_ended",
          body.endsOn,
        );
        await audit(c, tx, access, {
          action: A.ended,
          resourceType: "absence",
          resourceId: id,
          scopeExtra: { endsOn: body.endsOn, coverNeedsResolved: resolved },
        });
        const [item] = await itemsOf(tx, access, [saved]);
        return item;
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/absences/{id}/bradford-exclusion",
      tags,
      summary: "Leave a sickness out of the Bradford factor, or put it back",
      description:
        "workforce.hr_document.read and scheduling.rota.manage at the home: a reason (pregnancy-related, disability-related) leaves it out; null puts it back. Audited (scheduling.absence.bradford_excluded), never the reason.",
      security,
      request: versioned(ExcludeFromBradford),
      responses: absenceResponses,
    }),
    async (c) => {
      await requirePermission(c, HR);
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const out = await inTx(c, async (tx) => {
        const row = await loadAbsence(tx, id);
        requireLocationInScope(access, row.locationId);
        if (row.kind !== "sickness")
          throw problems.invalid("Only a sickness counts in the Bradford factor.");
        if (row.version !== body.version) throw stale();
        const [saved] = await tx
          .update(absence)
          .set({ bradfordExcludedReason: body.reason })
          .where(and(eq(absence.id, id), eq(absence.version, body.version)))
          .returning();
        if (!saved) throw stale();
        await audit(c, tx, access, {
          action: A.excluded,
          resourceType: "absence",
          resourceId: id,
          scopeExtra: { excluded: body.reason !== null },
        });
        const [item] = await itemsOf(tx, access, [saved]);
        return item;
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/absences/{id}/fit-notes",
      tags,
      summary: "Add a fit note to a sickness (the body is the file)",
      description:
        "workforce.hr_document.read at the home, never for one's own absence. The document is checked by its contents, scanned and kept as an HR-only staff document with retention sickness_absence; the dates, fitness and ticked adjustments are stored beside it, never the condition. Audited (workforce.fit_note.added) with ids and dates only.",
      security,
      request: { params: IdParam, query: FitNoteQuery, body: fileBody },
      responses: {
        201: jsonBody(FitNoteItem, "Stored"),
        ...errorResponses,
        ...notFoundResponse,
        413: jsonBody(z.object({ code: z.string() }), "The file is too large"),
      },
    }),
    async (c) => {
      const access = await requirePermission(c, HR);
      const { id } = c.req.valid("param");
      const q = c.req.valid("query");
      if (q.coversTo < q.coversFrom || q.issuedOn > q.coversTo) {
        throw problems.invalid("The fit note's dates do not run in order.");
      }
      const adjustments = {
        phasedReturn: q.phasedReturn === "true",
        amendedDuties: q.amendedDuties === "true",
        alteredHours: q.alteredHours === "true",
        workplaceAdaptations: q.workplaceAdaptations === "true",
      };
      if (q.fitness === "not_fit" && Object.values(adjustments).some(Boolean)) {
        throw problems.invalid("Adjustments are ticked only when the member may be fit for work.");
      }
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      const imagePrintable = imagePrintableOf(bytes);
      const { scanner } = c.get("services");
      const out = await destroyingOnFailure(c.get("services").storage, (storage) =>
        inTx(c, async (tx) => {
          const row = await loadAbsence(tx, id);
          requireLocationInScope(access, row.locationId);
          if (row.kind !== "sickness") throw problems.invalid("A fit note is for a sickness.");
          if (row.memberId === access.tenantUserId) throw problems.forbidden();
          const doc = await storeDocument(tx, { storage, scanner }, access.tenantId, {
            bytes,
            imagePrintable,
            declaredType: c.req.header("content-type") ?? null,
            category: "staff_hr_document",
            title: "Fit note",
            fileName: null,
            subjectType: "fit_note",
            subjectId: id,
            retentionClass: "sickness_absence",
          });
          const [made] = await tx
            .insert(fitNote)
            .values({
              absenceId: id,
              locationId: row.locationId,
              documentId: doc.id,
              issuedOn: q.issuedOn,
              coversFrom: q.coversFrom,
              coversTo: q.coversTo,
              fitness: q.fitness,
              ...adjustments,
            })
            .returning();
          if (!made) throw new Error("fit note not stored");
          await audit(c, tx, access, {
            action: A.fitNoteAdded,
            resourceType: "absence",
            resourceId: id,
            scopeExtra: {
              fitNoteId: made.id,
              documentId: doc.id,
              coversFrom: q.coversFrom,
              coversTo: q.coversTo,
            },
          });
          return fitNoteOut(made);
        }),
      );
      return c.json(out, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/absences/{id}/fit-notes/{fitNoteId}/content",
      tags,
      summary: "Open a fit note (audited)",
      description:
        "workforce.hr_document.read at the home, never one's own (as every HR-only document). Every open is audited as workforce.fit_note.viewed.",
      security,
      request: { params: FitNoteParam },
      responses: { 200: fileResponse("The fit note"), ...errorResponses, ...notFoundResponse },
    }),
    async (c) => {
      const access = await requirePermission(c, HR);
      const { id, fitNoteId } = c.req.valid("param");
      const { storage } = c.get("services");
      const { row, bytes } = await withAuditedRefusal(c, access, () =>
        inTx(c, async (tx) => {
          const [note] = await tx
            .select()
            .from(fitNote)
            .where(and(eq(fitNote.id, fitNoteId), eq(fitNote.absenceId, id)));
          if (!note) throw problems.notFound();
          const [doc] = await tx
            .select({ id: document.id })
            .from(document)
            .where(
              and(eq(document.id, note.documentId), eq(document.category, "staff_hr_document")),
            );
          if (!doc) throw problems.notFound();
          const content = await readDocumentContent(tx, storage, note.documentId);
          await audit(c, tx, access, {
            action: A.fitNoteViewed,
            resourceType: "absence",
            resourceId: id,
            scopeExtra: { fitNoteId },
          });
          return content;
        }),
      );
      c.header("cache-control", "private, no-store");
      return c.body(bytes as Uint8Array<ArrayBuffer>, 200, contentHeaders(row));
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/absences/{id}/return-to-work",
      tags,
      summary: "Record the return to work conversation after a sickness",
      description:
        "workforce.hr_document.read at the home, by someone other than the member, once the sickness has ended; one per absence (409 return_to_work_recorded). Audited (workforce.return_to_work.recorded) with ids and whether fit, never the notes.",
      security,
      request: versioned(NewReturnToWork),
      responses: {
        201: jsonBody(ReturnToWorkItem, "Recorded"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, HR);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const out = await inTx(c, async (tx) => {
        const row = await loadAbsence(tx, id);
        requireLocationInScope(access, row.locationId);
        if (row.kind !== "sickness" || row.endsOn === null) {
          throw new HttpProblem(409, "absence_not_ended", "Record the sickness's last day first.");
        }
        if (row.memberId === access.tenantUserId) throw problems.forbidden();
        if (body.heldOn < row.startsOn || body.heldOn > ukIsoDate(new Date())) {
          throw problems.invalid(
            "The day it was held must be during or after the absence, and not in the future.",
          );
        }
        const [already] = await tx
          .select({ id: returnToWork.id })
          .from(returnToWork)
          .where(eq(returnToWork.absenceId, id));
        if (already) {
          throw new HttpProblem(
            409,
            "return_to_work_recorded",
            "A return to work is already recorded for this absence.",
          );
        }
        const [made] = await tx
          .insert(returnToWork)
          .values({
            absenceId: id,
            locationId: row.locationId,
            memberId: row.memberId,
            heldOn: body.heldOn,
            heldBy: access.tenantUserId,
            fitForUsualDuties: body.fitForUsualDuties,
            phasedReturn: body.phasedReturn,
            amendedDuties: body.amendedDuties,
            alteredHours: body.alteredHours,
            workplaceAdaptations: body.workplaceAdaptations,
            notes: body.notes ?? null,
          })
          .returning();
        if (!made) throw new Error("return to work not stored");
        await audit(c, tx, access, {
          action: A.returnToWork,
          resourceType: "absence",
          resourceId: id,
          scopeExtra: { returnToWorkId: made.id, fitForUsualDuties: body.fitForUsualDuties },
        });
        return rtwOut(made);
      });
      return c.json(out, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/members/{id}/bradford",
      tags,
      summary: "A member's Bradford factor, with its working",
      description:
        "workforce.hr_document.read reaching a home where the member has an absence (or across the organisation). Over absence.bradford.window_weeks (the rate table) from the member's sickness days, not cancelled and not left out; days the member was not rostered between two absences join them into one spell. Shown with its working and a notice; never compared with a trigger and never acted on (H-583). Audited (workforce.bradford.viewed) with the member id.",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(BradfordResult, "The working"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, HR);
      const { id } = c.req.valid("param");
      const out = await inTx(c, async (tx) => {
        const today = ukIsoDate(new Date());
        const nation = await nationOf(tx);
        const rates = resolvePayRates(
          await rateRows(tx, Object.values(PAY_RATE_KEYS)),
          nation,
          today,
          access.tenantId,
        );
        const rows = await withSystemRights(tx, () =>
          tx
            .select()
            .from(absence)
            .where(and(eq(absence.memberId, id), isNull(absence.deletedAt))),
        );
        // The member must be one the holder reaches: an absence at a home in their scope.
        const reachable = rows.filter((r) => {
          try {
            requireLocationInScope(access, r.locationId);
            return true;
          } catch {
            return false;
          }
        });
        if (reachable.length === 0 && access.context.scope !== "tenant") throw problems.notFound();
        const days = bradfordDays(
          rows.map((r) => ({
            kind: r.kind as AbsenceKind,
            state: r.state as AbsenceState,
            startsOn: r.startsOn,
            endsOn: r.endsOn,
            excluded: r.bradfordExcludedReason !== null,
          })),
          today,
        );
        // Days the member was rostered: every other day is one they were not due to work.
        const windowStart = new Date(`${today}T00:00:00Z`);
        windowStart.setUTCDate(windowStart.getUTCDate() - rates.bradfordWindowWeeks * 7);
        const rostered = await withSystemRights(tx, () =>
          tx
            .select({ startsAt: shift.startsAt })
            .from(shiftAssignment)
            .innerJoin(
              shift,
              and(
                eq(shift.tenantId, shiftAssignment.tenantId),
                eq(shift.id, shiftAssignment.shiftId),
              ),
            )
            .where(
              and(
                eq(shiftAssignment.workerId, id),
                isNull(shift.deletedAt),
                gte(shift.startsAt, windowStart),
              ),
            ),
        );
        const due = new Set(rostered.map((r) => ukIsoDate(r.startsAt)));
        const nonWorking = new Set<string>();
        if (due.size > 0) {
          for (const d of absenceDays(ukIsoDate(windowStart), today, today)) {
            if (!due.has(d) && !days.includes(d)) nonWorking.add(d);
          }
        }
        const result = bradfordFactor(days, nonWorking, today, rates);
        await audit(c, tx, access, {
          action: A.bradford,
          resourceType: "tenant_user",
          resourceId: id,
        });
        return {
          memberId: id,
          spells: result.spells,
          days: result.days,
          score: result.score,
          windowStart: result.windowStart,
          windowEnd: today,
          windowWeeks: rates.bradfordWindowWeeks,
          excludedAbsences: rows.filter((r) => r.bradfordExcludedReason !== null).length,
          working: [
            `Window: ${rates.bradfordWindowWeeks} weeks (absence.bradford.window_weeks), from ${result.windowStart} to ${today}.`,
            `Sickness days in the window, not cancelled and not left out: ${result.days}.`,
            due.size > 0
              ? `Spells: ${result.spells} (days in a row, joined across days the member was not rostered).`
              : `Spells: ${result.spells} (days in a row; no rota is recorded, so only days next to each other join).`,
            `Score: ${result.spells} x ${result.spells} x ${result.days} = ${result.score}.`,
          ],
          notice: BRADFORD_NOTICE,
        };
      });
      c.header("cache-control", "private, no-store");
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/absences/{id}/ssp",
      tags,
      summary: "The SSP working for a sickness, for payroll",
      description:
        "workforce.hr_document.read at the home. From the member's sicknesses: the period of incapacity this one belongs to (ssp.piw_min_days, linked within ssp.piw_link_weeks), the qualifying days already paid in it, and the slice 6 rule (ssp.weekly, ssp.earnings_percentage, ssp.waiting_days, ssp.max_weeks) with the earnings and qualifying days given. Advice only: nothing is paid or stored. Audited (scheduling.ssp.calculated) with the absence id, never the earnings.",
      security,
      request: { params: IdParam, query: SspQuery },
      responses: {
        200: jsonBody(SspResultItem, "The working"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, HR);
      const { id } = c.req.valid("param");
      const q = c.req.valid("query");
      const weekdays = new Set(q.qualifyingWeekdays.split(",").map(Number));
      const out = await inTx(c, async (tx) => {
        const row = await withSystemRights(tx, async () => {
          const [r] = await tx.select().from(absence).where(eq(absence.id, id));
          return r ?? null;
        });
        if (row?.kind !== "sickness") throw problems.notFound();
        requireLocationInScope(access, row.locationId);
        const today = ukIsoDate(new Date());
        const nation = await nationOf(tx);
        const keys = [...Object.values(PAY_RATE_KEYS), ...Object.values(ABSENCE_RATE_KEYS)];
        const all = await rateRows(tx, keys);
        const pay = resolvePayRates(all, nation, row.startsOn, access.tenantId);
        const absenceRates = resolveAbsenceRates(all, nation, row.startsOn, access.tenantId);
        const spells = await withSystemRights(tx, () =>
          tx
            .select()
            .from(absence)
            .where(
              and(
                eq(absence.memberId, row.memberId),
                eq(absence.kind, "sickness"),
                inArray(absence.state, ["approved", "recorded"]),
                isNull(absence.deletedAt),
              ),
            ),
        );
        const periods = periodsOfIncapacity(
          spells.map((s) => ({ id: s.id, startsOn: s.startsOn, endsOn: s.endsOn })),
          today,
          absenceRates,
        );
        await audit(c, tx, access, { action: A.ssp, resourceType: "absence", resourceId: id });
        const base = { absenceId: id, notice: SSP_NOTICE };
        if (periods === null) {
          return {
            ...base,
            applies: false,
            reason: "no_rate_for_nation" as const,
            periodOfIncapacity: null,
            weeklyPence: null,
            daysPaid: null,
            payPence: null,
            daysLeft: null,
            working: [],
            inputHash: null,
          };
        }
        const period = periods.find((p) => p.spellIds.includes(id));
        if (!period) {
          return {
            ...base,
            applies: false,
            reason: "not_a_period_of_incapacity" as const,
            periodOfIncapacity: null,
            weeklyPence: null,
            daysPaid: null,
            payPence: null,
            daysLeft: null,
            working: [
              {
                step: `Fewer than ${absenceRates.piwMinDays} days in a row (ssp.piw_min_days): not a period of incapacity for work, so no SSP.`,
                pence: null,
              },
            ],
            inputHash: null,
          };
        }
        // Qualifying days in the period's earlier spells count as already paid towards the limit.
        const earlier = spells.filter(
          (s) => period.spellIds.includes(s.id) && s.id !== id && s.startsOn < row.startsOn,
        );
        const alreadyPaid = qualifyingDaysIn(
          earlier.flatMap((s) => absenceDays(s.startsOn, s.endsOn, today)),
          weekdays,
        ).length;
        const thisSpell = qualifyingDaysIn(
          absenceDays(row.startsOn, row.endsOn, today),
          weekdays,
        ).length;
        const result = sickPay(
          {
            averageWeeklyEarningsPence: q.averageWeeklyEarningsPence,
            qualifyingDaysPerWeek: weekdays.size,
            sickQualifyingDays: thisSpell,
            daysAlreadyPaid: alreadyPaid,
          },
          pay,
        );
        const periodOut = {
          startsOn: period.startsOn,
          endsOn: period.endsOn,
          linkedAbsences: period.spellIds.length,
        };
        if (!result.applies) {
          return {
            ...base,
            applies: false,
            reason: "no_rate_for_nation" as const,
            periodOfIncapacity: periodOut,
            weeklyPence: null,
            daysPaid: null,
            payPence: null,
            daysLeft: null,
            working: [],
            inputHash: null,
          };
        }
        return {
          ...base,
          applies: true,
          reason: null,
          periodOfIncapacity: periodOut,
          weeklyPence: result.weeklyPence,
          daysPaid: result.daysPaid,
          payPence: result.payPence,
          daysLeft: result.daysLeft,
          working: [
            {
              step: `Period of incapacity from ${period.startsOn} to ${period.endsOn} (${period.spellIds.length} linked absence(s)); ${alreadyPaid} qualifying day(s) already in it before this one.`,
              pence: null,
            },
            ...result.working.map((w) => ({ step: w.step, pence: w.pence ?? null })),
          ],
          // A hash of the inputs, so the same figures reproduce the same working; never the earnings.
          inputHash: createHash("sha256").update(result.canonicalInput).digest("hex"),
        };
      });
      c.header("cache-control", "private, no-store");
      return c.json(out, 200);
    },
  );
