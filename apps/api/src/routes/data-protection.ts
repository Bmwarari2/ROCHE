import {
  AssessBreach,
  BreachList,
  BreachOut,
  ChangeBreachFacts,
  CloseBreach,
  CloseComplaint,
  ComplaintDate,
  ComplaintList,
  ComplaintOut,
  DecideBreach,
  RecordBreach,
  RecordComplaint,
  ReportBreach,
  SubjectNoticeDraft,
  TellIndividuals,
} from "@harbour/contracts";
import {
  dpBreach,
  dpComplaint,
  location,
  person,
  processorBreachNotice,
  processorBreachNoticeAck,
  type Transaction,
  tenant,
} from "@harbour/db";
import {
  assessBreach,
  type BreachFactors,
  breachClock,
  checkBreachDecision,
  checkComplaintClosure,
  complaintClock,
  DATA_RIGHTS_RATE_KEYS,
  noticeHasPrompts,
  type RateNation,
  resolveOptionalRate,
  scopeFor,
  subjectNoticeDraft,
  ukIsoDate,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx } from "../http/audit";
import { type AppEnv, requirePermission, type TenantAccess, withTenant } from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { bankHolidays, rateNumber, rateRows } from "../services/rates";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import { dbCode } from "./people-shared";

/**
 * The breach register, Thapsus's processor breach notices and data protection complaints
 * (PLAT-022; platform.md rules 6 to 10 and 18 to 26; migration 0082). Everything needs
 * `quality.dsar.manage`, which row-level security checks again. Clocks are worked out on every read
 * from the stored dates and the rate table (`ico.breach.report_hours`, `dp_complaint.*`), never
 * stored; the assessment is decision support only. Each change sends the record's `version`
 * (409 when stale). Every read and change is audited with ids and codes only: never the summary,
 * names, contact details, reasoning or notice text.
 */

const PERMISSION = "quality.dsar.manage";
/** The most entries one list returns; `truncated` says when there were more (never silently cut). */
const LIST_LIMIT = 1000;
type Tx = Transaction;
type BreachRow = typeof dpBreach.$inferSelect;
type ComplaintRow = typeof dpComplaint.$inferSelect;
type Nation = Exclude<RateNation, "uk" | "all">;

const IdParam = z.object({ id: z.uuid() });
const iso = (d: Date | null) => (d ? d.toISOString() : null);

const unprocessable = (code: string, title: string, detail?: string) =>
  new HttpProblem(422, code, title, detail);

/** The organisation's row, for its nation and its data protection contact. */
async function tenantOf(tx: Tx, access: TenantAccess) {
  const [t] = await tx.select().from(tenant).where(eq(tenant.id, access.tenantId));
  if (!t) throw problems.notFound();
  return t;
}

/** The nation whose bank holidays and figures apply: the location's, else the organisation's. */
async function nationOf(tx: Tx, fallback: string, locationId: string | null): Promise<Nation> {
  if (locationId) {
    const [l] = await tx
      .select({ nation: location.nation })
      .from(location)
      .where(eq(location.id, locationId));
    if (l) return l.nation as Nation;
  }
  return fallback as Nation;
}

async function locationExists(tx: Tx, id: string | null | undefined) {
  if (!id) return;
  const [l] = await tx.select({ id: location.id }).from(location).where(eq(location.id, id));
  if (!l) throw unprocessable("location_not_found", "That location is not in this organisation.");
}

/**
 * `quality.dsar.manage` across the whole organisation (security review, #149 High): the register
 * and complaints are the organisation's data protection function, so a Registered Manager or
 * deputy who holds it for one home only is refused here, as row-level security refuses them
 * (`app.holds_role_permission_at(..., NULL)`, migration 0082).
 */
export async function requireOrganisationWide(c: Context<AppEnv>): Promise<TenantAccess> {
  const access = await requirePermission(c, PERMISSION);
  if (scopeFor(access.effective, PERMISSION).scope !== "tenant") {
    throw new HttpProblem(
      403,
      "missing_permission",
      "The breach register and data protection complaints are for people who handle data protection for the whole organisation.",
    );
  }
  return access;
}

/**
 * A tenant transaction whose database refusals are said plainly: a check or guard (23514) is a
 * 422 with the guard's code when it gave one, a missing reference (23503) a 422, a row-level
 * security refusal (42501) a 403. The values never reach the logs (app.ts logs codes only).
 */
export function dbRefusal(error: unknown): unknown {
  const code = dbCode(error);
  const message = (error as { message?: string }).message ?? "";
  if (code === "23514") {
    const guard = /^(dp_breach|dp_complaint|data_security)_[a-z_]+$/.test(message)
      ? message
      : "not_allowed";
    return unprocessable(guard, "That change is not allowed for this record.");
  }
  if (code === "23503") return unprocessable("not_found", "Something it refers to was not found.");
  if (code === "42501") return problems.forbidden();
  return error;
}

export async function dpTransaction<T>(c: Context<AppEnv>, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await withTenant(c, fn);
  } catch (error) {
    throw dbRefusal(error);
  }
}

// ------------------------------------------------------------------------------------------------
// Breaches
// ------------------------------------------------------------------------------------------------

function suggestionOf(row: BreachRow) {
  if (!row.factors) return null;
  const a = assessBreach(row.factors as BreachFactors);
  return {
    severity: a.suggestedSeverity,
    reasons: [...a.reasons],
    considerReportingToIco: a.considerReportingToIco,
    considerTellingIndividuals: a.considerTellingIndividuals,
  };
}

async function breachOut(
  tx: Tx,
  rows: readonly BreachRow[],
  reportHours: number,
  now: Date,
): Promise<BreachOut[]> {
  const ids = rows.map((r) => r.id);
  const notices =
    ids.length === 0
      ? []
      : await tx
          .select()
          .from(processorBreachNotice)
          .where(inArray(processorBreachNotice.breachId, ids))
          .orderBy(processorBreachNotice.sentAt);
  const acks =
    notices.length === 0
      ? []
      : await tx
          .select()
          .from(processorBreachNoticeAck)
          .where(
            inArray(
              processorBreachNoticeAck.noticeId,
              notices.map((n) => n.id),
            ),
          );
  return rows.map((r) => {
    const clock = breachClock(
      { awareAt: r.awareAt, reportedAt: r.reportedAt, delayReason: r.delayReason },
      { reportHours },
      now,
    );
    return {
      id: r.id,
      locationId: r.locationId,
      source: r.source as BreachOut["source"],
      summary: r.summary,
      awareAt: r.awareAt.toISOString(),
      occurredAt: iso(r.occurredAt),
      factors: (r.factors as BreachFactors | null) ?? null,
      suggestion: suggestionOf(r),
      decision:
        r.decidedAt && r.decidedBy && r.reportToIco !== null && r.tellIndividuals !== null
          ? {
              reportToIco: r.reportToIco,
              tellIndividuals: r.tellIndividuals,
              reasoning: r.decisionReasoning ?? "",
              acknowledgedSuggestion: r.acknowledgedSuggestion,
              decidedBy: r.decidedBy,
              decidedAt: r.decidedAt.toISOString(),
            }
          : null,
      report:
        r.reportedAt && r.icoReference
          ? {
              reportedAt: r.reportedAt.toISOString(),
              icoReference: r.icoReference,
              delayReason: r.delayReason,
            }
          : null,
      individuals:
        r.subjectNotice && r.individualsToldOn
          ? { notice: r.subjectNotice, toldOn: r.individualsToldOn }
          : null,
      status: r.status as BreachOut["status"],
      lessons: r.lessons,
      closedAt: iso(r.closedAt),
      clock: {
        deadline: clock.deadline.toISOString(),
        state: clock.state,
        hoursLeft: clock.hoursLeft,
        delayReasonRequired: clock.delayReasonRequired,
      },
      notices: notices
        .filter((n) => n.breachId === r.id)
        .map((n) => {
          const ack = acks.find((a) => a.noticeId === n.id);
          return {
            id: n.id,
            followsId: n.followsId,
            sentAt: n.sentAt.toISOString(),
            nature: n.nature,
            dataCategories: n.dataCategories,
            approxPeople: n.approxPeople,
            approxRecords: n.approxRecords,
            likelyConsequences: n.likelyConsequences,
            measures: n.measures,
            tenantActions: n.tenantActions,
            contact: n.contact,
            acknowledgedAt: iso(ack?.acknowledgedAt ?? null),
            acknowledgedBy: ack?.acknowledgedBy ?? null,
          };
        }),
      createdAt: r.createdAt.toISOString(),
      version: r.version,
    };
  });
}

async function reportHoursFor(tx: Tx, access: TenantAccess, nation: Nation) {
  return rateNumber(tx, access.tenantId, DATA_RIGHTS_RATE_KEYS.breachReportHours, nation);
}

async function loadBreach(tx: Tx, id: string): Promise<BreachRow> {
  const [row] = await tx.select().from(dpBreach).where(eq(dpBreach.id, id));
  if (!row) throw problems.notFound();
  return row;
}

/** One breach as the API returns it, read in the same transaction. */
async function oneBreach(tx: Tx, access: TenantAccess, row: BreachRow) {
  const t = await tenantOf(tx, access);
  const hours = await reportHoursFor(tx, access, await nationOf(tx, t.nation, row.locationId));
  const [out] = await breachOut(tx, [row], hours, new Date());
  if (!out) throw problems.notFound();
  return out;
}

/** Applies a change to an open breach at the expected version (409 when stale, 422 when closed). */
async function changeBreach(
  tx: Tx,
  id: string,
  expectedVersion: number,
  check: (row: BreachRow) => void,
  set: (row: BreachRow) => Partial<typeof dpBreach.$inferInsert>,
): Promise<BreachRow> {
  const row = await loadBreach(tx, id);
  if (row.version !== expectedVersion) throw problems.conflict();
  if (row.status === "closed") {
    throw unprocessable("breach_closed", "This breach is closed and cannot be changed.");
  }
  check(row);
  const [saved] = await tx
    .update(dpBreach)
    .set(set(row))
    .where(and(eq(dpBreach.id, id), eq(dpBreach.version, expectedVersion)))
    .returning();
  if (!saved) throw problems.conflict();
  return saved;
}

/** The audit for one breach action: ids and codes only. */
const breachAudit = (
  c: Context<AppEnv>,
  tx: Tx,
  access: TenantAccess,
  action: string,
  id: string,
  scope: Record<string, unknown> = {},
) =>
  auditInTx(tx, access, {
    action: `platform.breach.${action}`,
    resourceType: "dp_breach",
    resourceId: id,
    scope,
    requestId: c.get("requestId"),
  });

const breachResponses = {
  200: jsonBody(BreachOut, "The breach"),
  ...errorResponses,
  ...notFoundResponse,
  ...conflictResponse,
};

// ------------------------------------------------------------------------------------------------
// Complaints
// ------------------------------------------------------------------------------------------------

async function complaintOut(tx: Tx, access: TenantAccess, rows: readonly ComplaintRow[]) {
  const t = await tenantOf(tx, access);
  const keys = Object.values(DATA_RIGHTS_RATE_KEYS);
  const rates = await rateRows(tx, keys);
  const today = ukIsoDate(new Date());
  const holidayCache = new Map<Nation, Awaited<ReturnType<typeof bankHolidays>>>();
  const out = [];
  for (const r of rows) {
    const nation = await nationOf(tx, t.nation, r.locationId);
    const holidays = holidayCache.get(nation) ?? (await bankHolidays(tx, nation));
    holidayCache.set(nation, holidays);
    const optional = (key: string, on: string) =>
      resolveOptionalRate(rates, key, nation, on, access.tenantId);
    const target = optional(DATA_RIGHTS_RATE_KEYS.complaintAcknowledgeTargetWorkingDays, today);
    const interval = optional(DATA_RIGHTS_RATE_KEYS.complaintUpdateIntervalMonths, today);
    if (target === null || interval === null) {
      throw new HttpProblem(500, "rate_missing", "A data protection complaint figure is missing.");
    }
    const clock = complaintClock(
      {
        receivedOn: r.receivedOn,
        acknowledgedOn: r.acknowledgedOn,
        lastContactOn: r.lastContactOn,
        closedOn: r.closedOn,
      },
      {
        // The duty applies to complaints received from the day it came into force (rule 9).
        acknowledgeDays: optional(DATA_RIGHTS_RATE_KEYS.complaintAcknowledgeDays, r.receivedOn),
        targetWorkingDays: target,
        updateIntervalMonths: interval,
      },
      holidays,
      today,
    );
    out.push({
      id: r.id,
      locationId: r.locationId,
      receivedOn: r.receivedOn,
      channel: r.channel as z.infer<typeof ComplaintOut>["channel"],
      complainantKind: r.complainantKind as z.infer<typeof ComplaintOut>["complainantKind"],
      complainantName: r.complainantName,
      complainantContact: r.complainantContact,
      personId: r.personId,
      about: r.about as z.infer<typeof ComplaintOut>["about"],
      summary: r.summary,
      acknowledgedOn: r.acknowledgedOn,
      lastContactOn: r.lastContactOn,
      outcome: r.outcome,
      icoRightStated: r.icoRightStated,
      breachId: r.breachId,
      status: r.status as "open" | "closed",
      closedOn: r.closedOn,
      clock,
      version: r.version,
    });
  }
  return out;
}

async function loadComplaint(tx: Tx, id: string): Promise<ComplaintRow> {
  const [row] = await tx.select().from(dpComplaint).where(eq(dpComplaint.id, id));
  if (!row) throw problems.notFound();
  return row;
}

/** A date for a complaint: on or after receipt and not in the future (rule 25). */
function checkComplaintDay(row: ComplaintRow, on: string) {
  if (on < row.receivedOn || on > ukIsoDate(new Date())) {
    throw unprocessable(
      "date_out_of_range",
      "Give a date on or after the day the complaint was received, and not in the future.",
    );
  }
}

async function changeComplaint(
  tx: Tx,
  id: string,
  expectedVersion: number,
  check: (row: ComplaintRow) => void,
  set: (row: ComplaintRow) => Partial<typeof dpComplaint.$inferInsert>,
): Promise<ComplaintRow> {
  const row = await loadComplaint(tx, id);
  if (row.version !== expectedVersion) throw problems.conflict();
  if (row.status === "closed") {
    throw unprocessable("complaint_closed", "This complaint is closed and cannot be changed.");
  }
  check(row);
  const [saved] = await tx
    .update(dpComplaint)
    .set(set(row))
    .where(and(eq(dpComplaint.id, id), eq(dpComplaint.version, expectedVersion)))
    .returning();
  if (!saved) throw problems.conflict();
  return saved;
}

const complaintAudit = (
  c: Context<AppEnv>,
  tx: Tx,
  access: TenantAccess,
  action: string,
  id: string,
  scope: Record<string, unknown> = {},
) =>
  auditInTx(tx, access, {
    action: `platform.dp_complaint.${action}`,
    resourceType: "dp_complaint",
    resourceId: id,
    scope,
    requestId: c.get("requestId"),
  });

const complaintResponses = {
  200: jsonBody(ComplaintOut, "The complaint"),
  ...errorResponses,
  ...notFoundResponse,
  ...conflictResponse,
};

async function oneComplaint(tx: Tx, access: TenantAccess, row: ComplaintRow) {
  const [out] = await complaintOut(tx, access, [row]);
  if (!out) throw problems.notFound();
  return out;
}

// ------------------------------------------------------------------------------------------------
// Routes
// ------------------------------------------------------------------------------------------------

export const dataProtectionRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/data-protection/breaches",
      tags: ["platform"],
      summary: "The breach register, newest awareness first, each with its ICO clock",
      description:
        "quality.dsar.manage. Every breach, reportable or not (Art 33(5)), with its clock worked out now from aware_at and ico.breach.report_hours, the suggestion recomputed from its factors (decision support only) and Thapsus's notices about it. Audited (platform.breach.list).",
      security,
      responses: { 200: jsonBody(BreachList, "The register"), ...errorResponses },
    }),
    async (c) => {
      const access = await requireOrganisationWide(c);
      const result = await dpTransaction(c, async (tx) => {
        const t = await tenantOf(tx, access);
        const fetched = await tx
          .select()
          .from(dpBreach)
          .orderBy(desc(dpBreach.awareAt))
          .limit(LIST_LIMIT + 1);
        const truncated = fetched.length > LIST_LIMIT;
        const rows = fetched.slice(0, LIST_LIMIT);
        const hours = await reportHoursFor(tx, access, t.nation as Nation);
        // Each entry's clock uses its own location's figure, which is the same unless overridden.
        const items: BreachOut[] = [];
        for (const row of rows) {
          const nation = await nationOf(tx, t.nation, row.locationId);
          const h = nation === t.nation ? hours : await reportHoursFor(tx, access, nation);
          items.push(...(await breachOut(tx, [row], h, new Date())));
        }
        await auditInTx(tx, access, {
          action: "platform.breach.list",
          resourceType: "dp_breach",
          scope: { count: rows.length },
          requestId: c.get("requestId"),
        });
        return { items, reportHours: hours, truncated };
      });
      return c.json(result, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/data-protection/breaches",
      tags: ["platform"],
      summary: "Record a breach in the register",
      description:
        "quality.dsar.manage. What happened (no names: the register is not a care record), when the organisation became aware (the ICO clock starts there) and, if known, when it happened. Audited (platform.breach.recorded).",
      security,
      request: { body: { content: { "application/json": { schema: RecordBreach } } } },
      responses: { 201: jsonBody(BreachOut, "Recorded"), ...errorResponses },
    }),
    async (c) => {
      const access = await requireOrganisationWide(c);
      const body = c.req.valid("json");
      const now = new Date();
      if (new Date(body.awareAt) > now || (body.occurredAt && new Date(body.occurredAt) > now)) {
        throw unprocessable("time_in_future", "Times cannot be in the future.");
      }
      const out = await dpTransaction(c, async (tx) => {
        await locationExists(tx, body.locationId);
        const [row] = await tx
          .insert(dpBreach)
          .values({
            source: "tenant",
            summary: body.summary,
            awareAt: new Date(body.awareAt),
            occurredAt: body.occurredAt ? new Date(body.occurredAt) : null,
            locationId: body.locationId ?? null,
          })
          .returning();
        if (!row) throw problems.conflict();
        await breachAudit(c, tx, access, "recorded", row.id, { locationId: row.locationId });
        return oneBreach(tx, access, row);
      });
      return c.json(out, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/data-protection/breaches/{id}",
      tags: ["platform"],
      summary: "One breach, with its clock, suggestion, decision and notices",
      description: "quality.dsar.manage. Audited (platform.breach.viewed).",
      security,
      request: { params: IdParam },
      responses: { 200: jsonBody(BreachOut, "The breach"), ...errorResponses, ...notFoundResponse },
    }),
    async (c) => {
      const access = await requireOrganisationWide(c);
      const { id } = c.req.valid("param");
      const out = await dpTransaction(c, async (tx) => {
        const row = await loadBreach(tx, id);
        await breachAudit(c, tx, access, "viewed", id);
        return oneBreach(tx, access, row);
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/data-protection/breaches/{id}/facts",
      tags: ["platform"],
      summary: "Correct what happened, where and when",
      description:
        "quality.dsar.manage. The time the organisation became aware may be corrected only until the ICO report is recorded (rule 19; the database refuses it too); every change is kept in the record's history. Audited (platform.breach.facts_changed) with which fields changed.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: ChangeBreachFacts } } },
      },
      responses: breachResponses,
    }),
    async (c) => {
      const access = await requireOrganisationWide(c);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      if (
        (body.awareAt && new Date(body.awareAt) > now) ||
        (body.occurredAt && new Date(body.occurredAt) > now)
      ) {
        throw unprocessable("time_in_future", "Times cannot be in the future.");
      }
      const out = await dpTransaction(c, async (tx) => {
        await locationExists(tx, body.locationId);
        // Art 33(2): an entry Thapsus opened was known no later than its first notice.
        const [first] = await tx
          .select({ sentAt: processorBreachNotice.sentAt })
          .from(processorBreachNotice)
          .where(eq(processorBreachNotice.breachId, id))
          .orderBy(processorBreachNotice.sentAt)
          .limit(1);
        const firstNotice = first?.sentAt ?? null;
        const saved = await changeBreach(
          tx,
          id,
          body.expectedVersion,
          (row) => {
            if (body.awareAt && row.reportedAt) {
              throw unprocessable(
                "aware_at_fixed",
                "The time of awareness cannot change once the ICO report is recorded.",
              );
            }
            const later = body.awareAt && new Date(body.awareAt) > row.awareAt;
            if (later && row.decidedAt) {
              throw unprocessable(
                "aware_at_fixed",
                "The time of awareness cannot move later once the decision is made.",
              );
            }
            if (later && firstNotice && new Date(body.awareAt as string) > firstNotice) {
              throw unprocessable(
                "aware_at_after_notice",
                "The organisation was aware no later than Thapsus's notice.",
              );
            }
          },
          () => ({
            ...(body.summary !== undefined ? { summary: body.summary } : {}),
            ...(body.awareAt !== undefined ? { awareAt: new Date(body.awareAt) } : {}),
            ...(body.occurredAt !== undefined
              ? { occurredAt: body.occurredAt ? new Date(body.occurredAt) : null }
              : {}),
            ...(body.locationId !== undefined ? { locationId: body.locationId } : {}),
          }),
        );
        const fields = (["summary", "awareAt", "occurredAt", "locationId"] as const).filter(
          (f) => body[f] !== undefined,
        );
        await breachAudit(c, tx, access, "facts_changed", id, { fields });
        return oneBreach(tx, access, saved);
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/data-protection/breaches/{id}/assessment",
      tags: ["platform"],
      summary: "Record the assessment factors and store the suggested severity",
      description:
        "quality.dsar.manage. Stores the factors from breach-response.md section 4 and assessBreach's suggestion: decision support only, never the decision (rule 7). Reassessing after a decision is refused. Audited (platform.breach.assessed) with the suggested severity code.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: AssessBreach } } },
      },
      responses: breachResponses,
    }),
    async (c) => {
      const access = await requireOrganisationWide(c);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const suggestion = assessBreach(body.factors);
      const out = await dpTransaction(c, async (tx) => {
        const saved = await changeBreach(
          tx,
          id,
          body.expectedVersion,
          (row) => {
            if (row.decidedAt) {
              throw unprocessable(
                "already_decided",
                "The decision has been made on this assessment. Record a new decision instead.",
              );
            }
          },
          () => ({
            factors: body.factors,
            suggestedSeverity: suggestion.suggestedSeverity,
            suggestedReportToIco: suggestion.considerReportingToIco,
            suggestedTellIndividuals: suggestion.considerTellingIndividuals,
            assessedBy: access.tenantUserId,
            assessedAt: new Date(),
          }),
        );
        await breachAudit(c, tx, access, "assessed", id, {
          suggestedSeverity: suggestion.suggestedSeverity,
        });
        return oneBreach(tx, access, saved);
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/data-protection/breaches/{id}/decision",
      tags: ["platform"],
      summary: "Record the decision on reporting to the ICO and telling the people affected",
      description:
        "quality.dsar.manage. A person's decision against the stored suggestion (checkBreachDecision, 422 with its problem code): written reasoning, the decider is the person recording it, and an acknowledgement when going against the suggestion. A changed decision is recorded the same way and kept in history; a decision to report cannot be withdrawn once the report is recorded. Audited (platform.breach.decided) with the two choices, never the reasoning.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: DecideBreach } } },
      },
      responses: breachResponses,
    }),
    async (c) => {
      const access = await requireOrganisationWide(c);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const out = await dpTransaction(c, async (tx) => {
        const saved = await changeBreach(
          tx,
          id,
          body.expectedVersion,
          (row) => {
            if (!row.factors) {
              throw unprocessable("not_assessed", "Record the assessment before the decision.");
            }
            const checked = checkBreachDecision(
              {
                reportToIco: body.reportToIco,
                tellIndividuals: body.tellIndividuals,
                reasoning: body.reasoning,
                decidedBy: access.tenantUserId,
                acknowledgedSuggestion: body.acknowledgedSuggestion,
              },
              assessBreach(row.factors as BreachFactors),
            );
            if (!checked.ok) throw unprocessable(checked.problem, checked.message);
            if (row.reportedAt && !body.reportToIco) {
              throw unprocessable(
                "already_reported",
                "The breach has been reported to the ICO: the decision to report stands.",
              );
            }
            if (row.individualsToldOn && !body.tellIndividuals) {
              throw unprocessable(
                "already_told",
                "The people affected have been told: the decision to tell them stands.",
              );
            }
          },
          () => ({
            reportToIco: body.reportToIco,
            tellIndividuals: body.tellIndividuals,
            decisionReasoning: body.reasoning,
            acknowledgedSuggestion: body.acknowledgedSuggestion,
            decidedBy: access.tenantUserId,
            decidedAt: new Date(),
          }),
        );
        await breachAudit(c, tx, access, "decided", id, {
          reportToIco: body.reportToIco,
          tellIndividuals: body.tellIndividuals,
          acknowledgedSuggestion: body.acknowledgedSuggestion,
        });
        return oneBreach(tx, access, saved);
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/data-protection/breaches/{id}/ico-report",
      tags: ["platform"],
      summary: "Record the report to the ICO",
      description:
        "quality.dsar.manage. Needs a decision to report (422 not_decided_to_report). A report made after the deadline needs the reasons for the delay (Art 33(1); 422 delay_reason_required). Audited (platform.breach.reported) with whether it was late.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: ReportBreach } } },
      },
      responses: breachResponses,
    }),
    async (c) => {
      const access = await requireOrganisationWide(c);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const reportedAt = new Date(body.reportedAt);
      if (reportedAt > new Date())
        throw unprocessable("time_in_future", "Times cannot be in the future.");
      let late = false;
      const out = await dpTransaction(c, async (tx) => {
        const t = await tenantOf(tx, access);
        const before = await loadBreach(tx, id);
        const hours = await reportHoursFor(
          tx,
          access,
          await nationOf(tx, t.nation, before.locationId),
        );
        const saved = await changeBreach(
          tx,
          id,
          body.expectedVersion,
          (row) => {
            if (row.reportToIco !== true) {
              throw unprocessable(
                "not_decided_to_report",
                "Record a decision to report to the ICO first.",
              );
            }
            if (reportedAt < row.awareAt) {
              throw unprocessable(
                "report_before_awareness",
                "The report cannot be before the organisation became aware.",
              );
            }
            const clock = breachClock(
              { awareAt: row.awareAt, reportedAt, delayReason: body.delayReason ?? null },
              { reportHours: hours },
              new Date(),
            );
            late = clock.state === "reported_late";
            if (clock.delayReasonRequired && !clock.delayReasonGiven) {
              throw unprocessable(
                "delay_reason_required",
                "The report was made after the deadline: give the reasons for the delay.",
              );
            }
          },
          () => ({
            reportedAt,
            icoReference: body.icoReference,
            delayReason: body.delayReason ?? null,
          }),
        );
        await breachAudit(c, tx, access, "reported", id, { late });
        return oneBreach(tx, access, saved);
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/data-protection/breaches/{id}/subject-notice-draft",
      tags: ["platform"],
      summary: "Draft the notice to the people affected from Harbour's template",
      description:
        "quality.dsar.manage. The plain-English template (what happened, what it means for them, what has been done, what they can do, who to contact) filled from the entry and the organisation's data protection contact; the parts in square brackets are for a person to write. Nothing is stored.",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(SubjectNoticeDraft, "The draft"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireOrganisationWide(c);
      const { id } = c.req.valid("param");
      const notice = await dpTransaction(c, async (tx) => {
        const row = await loadBreach(tx, id);
        const t = await tenantOf(tx, access);
        await breachAudit(c, tx, access, "notice_drafted", id);
        return subjectNoticeDraft({
          summary: row.summary,
          organisation: t.name,
          contactName: t.dpoName,
          contactEmail: t.dpoEmail,
        });
      });
      return c.json({ notice }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/data-protection/breaches/{id}/individuals-told",
      tags: ["platform"],
      summary: "Record the notice sent to the people affected, and the day they were told",
      description:
        "quality.dsar.manage. Needs a decision to tell them (422 not_decided_to_tell); a notice still holding one of the template's prompts is refused (422 notice_unfinished). Audited (platform.breach.individuals_told), never the notice text.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: TellIndividuals } } },
      },
      responses: breachResponses,
    }),
    async (c) => {
      const access = await requireOrganisationWide(c);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      if (body.toldOn > ukIsoDate(new Date())) {
        throw unprocessable("date_in_future", "The day they were told cannot be in the future.");
      }
      if (noticeHasPrompts(body.notice)) {
        throw unprocessable(
          "notice_unfinished",
          "Replace every part in square brackets before recording the notice.",
        );
      }
      const out = await dpTransaction(c, async (tx) => {
        const saved = await changeBreach(
          tx,
          id,
          body.expectedVersion,
          (row) => {
            if (row.tellIndividuals !== true) {
              throw unprocessable(
                "not_decided_to_tell",
                "Record a decision to tell the people affected first.",
              );
            }
          },
          () => ({ subjectNotice: body.notice, individualsToldOn: body.toldOn }),
        );
        await breachAudit(c, tx, access, "individuals_told", id);
        return oneBreach(tx, access, saved);
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/data-protection/breaches/{id}/close",
      tags: ["platform"],
      summary: "Close a breach with its lessons",
      description:
        "quality.dsar.manage. Needs a decision (422 not_decided); a decision to report needs the report recorded (422 not_reported), and a decision to tell the people affected needs the notice recorded (422 not_told). Once closed nothing changes. Audited (platform.breach.closed).",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: CloseBreach } } },
      },
      responses: breachResponses,
    }),
    async (c) => {
      const access = await requireOrganisationWide(c);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const out = await dpTransaction(c, async (tx) => {
        const saved = await changeBreach(
          tx,
          id,
          body.expectedVersion,
          (row) => {
            if (!row.decidedAt) throw unprocessable("not_decided", "Record the decision first.");
            if (row.reportToIco && !row.reportedAt) {
              throw unprocessable("not_reported", "Record the report to the ICO first.");
            }
            if (row.tellIndividuals && !row.individualsToldOn) {
              throw unprocessable("not_told", "Record the notice to the people affected first.");
            }
          },
          () => ({
            status: "closed",
            lessons: body.lessons,
            closedBy: access.tenantUserId,
            closedAt: new Date(),
          }),
        );
        await breachAudit(c, tx, access, "closed", id);
        return oneBreach(tx, access, saved);
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/data-protection/breach-notices/{id}/acknowledge",
      tags: ["platform"],
      summary: "Acknowledge a breach notice from Thapsus",
      description:
        "quality.dsar.manage, in the acknowledger's own name, once per notice (409 already_acknowledged). Audited (platform.breach.notice_acknowledged).",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(BreachOut, "The breach the notice is about"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireOrganisationWide(c);
      const { id } = c.req.valid("param");
      const out = await dpTransaction(c, async (tx) => {
        const [notice] = await tx
          .select()
          .from(processorBreachNotice)
          .where(eq(processorBreachNotice.id, id));
        if (!notice) throw problems.notFound();
        const [saved] = await tx
          .insert(processorBreachNoticeAck)
          .values({ noticeId: id, acknowledgedBy: access.tenantUserId })
          .onConflictDoNothing()
          .returning();
        if (!saved) {
          throw new HttpProblem(
            409,
            "already_acknowledged",
            "This notice has already been acknowledged.",
          );
        }
        await auditInTx(tx, access, {
          action: "platform.breach.notice_acknowledged",
          resourceType: "processor_breach_notice",
          resourceId: id,
          scope: { breachId: notice.breachId },
          requestId: c.get("requestId"),
        });
        return oneBreach(tx, access, await loadBreach(tx, notice.breachId));
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/data-protection/complaints",
      tags: ["platform"],
      summary: "Data protection complaints, open first, each with its clocks",
      description:
        "quality.dsar.manage. The acknowledgement clock (dp_complaint.acknowledge_days from the day of receipt, for complaints received once the duty was in force) and the tenant's working-day target beside it, and the next update due while open, worked out now. Audited (platform.dp_complaint.list).",
      security,
      responses: { 200: jsonBody(ComplaintList, "Complaints"), ...errorResponses },
    }),
    async (c) => {
      const access = await requireOrganisationWide(c);
      const result = await dpTransaction(c, async (tx) => {
        const fetched = await tx
          .select()
          .from(dpComplaint)
          .orderBy(desc(dpComplaint.status), desc(dpComplaint.receivedOn))
          .limit(LIST_LIMIT + 1);
        const truncated = fetched.length > LIST_LIMIT;
        const rows = fetched.slice(0, LIST_LIMIT);
        await auditInTx(tx, access, {
          action: "platform.dp_complaint.list",
          resourceType: "dp_complaint",
          scope: { count: rows.length },
          requestId: c.get("requestId"),
        });
        return { items: await complaintOut(tx, access, rows), truncated };
      });
      return c.json(result, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/data-protection/complaints",
      tags: ["platform"],
      summary: "Record a data protection complaint",
      description:
        "quality.dsar.manage. Logs a complaint received by any channel; the day received may not be in the future. Audited (platform.dp_complaint.recorded) with its codes, never the names or summary.",
      security,
      request: { body: { content: { "application/json": { schema: RecordComplaint } } } },
      responses: { 201: jsonBody(ComplaintOut, "Recorded"), ...errorResponses },
    }),
    async (c) => {
      const access = await requireOrganisationWide(c);
      const body = c.req.valid("json");
      if (body.receivedOn > ukIsoDate(new Date())) {
        throw unprocessable("date_in_future", "The day received cannot be in the future.");
      }
      if (body.personId) await requirePermission(c, "people.person.read");
      const out = await dpTransaction(c, async (tx) => {
        await locationExists(tx, body.locationId);
        if (body.breachId) {
          const [b] = await tx
            .select({ id: dpBreach.id })
            .from(dpBreach)
            .where(eq(dpBreach.id, body.breachId));
          if (!b) throw unprocessable("breach_not_found", "That breach is not in the register.");
        }
        if (body.personId) {
          // Only someone the recorder may see, through people.person.read and its scope (RLS,
          // required before the transaction opened).
          const [p] = await tx
            .select({ id: person.id })
            .from(person)
            .where(eq(person.id, body.personId));
          if (!p)
            throw unprocessable("person_not_found", "That person is not someone you can see.");
        }
        const [row] = await tx
          .insert(dpComplaint)
          .values({
            locationId: body.locationId ?? null,
            receivedOn: body.receivedOn,
            channel: body.channel,
            complainantKind: body.complainantKind,
            complainantName: body.complainantName,
            complainantContact: body.complainantContact ?? null,
            personId: body.personId ?? null,
            about: body.about,
            summary: body.summary,
            breachId: body.breachId ?? null,
          })
          .returning();
        if (!row) throw problems.conflict();
        await complaintAudit(c, tx, access, "recorded", row.id, {
          channel: row.channel,
          about: row.about,
          personId: row.personId,
        });
        return oneComplaint(tx, access, row);
      });
      return c.json(out, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/data-protection/complaints/{id}",
      tags: ["platform"],
      summary: "One data protection complaint with its clocks",
      description: "quality.dsar.manage. Audited (platform.dp_complaint.viewed).",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(ComplaintOut, "The complaint"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireOrganisationWide(c);
      const { id } = c.req.valid("param");
      const out = await dpTransaction(c, async (tx) => {
        const row = await loadComplaint(tx, id);
        await complaintAudit(c, tx, access, "viewed", id);
        return oneComplaint(tx, access, row);
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/data-protection/complaints/{id}/acknowledge",
      tags: ["platform"],
      summary: "Record the day the complaint was acknowledged",
      description:
        "quality.dsar.manage. On or after the day received and not in the future. Audited (platform.dp_complaint.acknowledged).",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: ComplaintDate } } },
      },
      responses: complaintResponses,
    }),
    async (c) => {
      const access = await requireOrganisationWide(c);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const out = await dpTransaction(c, async (tx) => {
        const saved = await changeComplaint(
          tx,
          id,
          body.expectedVersion,
          (row) => {
            if (row.acknowledgedOn) {
              throw unprocessable("already_acknowledged", "The complaint has been acknowledged.");
            }
            checkComplaintDay(row, body.on);
          },
          () => ({ acknowledgedOn: body.on }),
        );
        await complaintAudit(c, tx, access, "acknowledged", id);
        return oneComplaint(tx, access, saved);
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/data-protection/complaints/{id}/contact",
      tags: ["platform"],
      summary: "Record a day the complainant was told how it is going",
      description:
        "quality.dsar.manage. Moves the next update due (dp_complaint.update_interval_months from the last contact). Not before the last contact, and not in the future. Audited (platform.dp_complaint.contacted).",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: ComplaintDate } } },
      },
      responses: complaintResponses,
    }),
    async (c) => {
      const access = await requireOrganisationWide(c);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const out = await dpTransaction(c, async (tx) => {
        const saved = await changeComplaint(
          tx,
          id,
          body.expectedVersion,
          (row) => {
            checkComplaintDay(row, body.on);
            if (row.lastContactOn && body.on < row.lastContactOn) {
              throw unprocessable(
                "date_out_of_range",
                "Give a date on or after the last contact recorded.",
              );
            }
          },
          () => ({ lastContactOn: body.on }),
        );
        await complaintAudit(c, tx, access, "contacted", id);
        return oneComplaint(tx, access, saved);
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/data-protection/complaints/{id}/close",
      tags: ["platform"],
      summary: "Close a complaint with its outcome",
      description:
        "quality.dsar.manage. checkComplaintClosure (422 with its problem code): the outcome recorded, and it tells the complainant they can complain to the ICO. Needs the acknowledgement recorded first (422 not_acknowledged). Once closed nothing changes. Audited (platform.dp_complaint.closed).",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: CloseComplaint } } },
      },
      responses: complaintResponses,
    }),
    async (c) => {
      const access = await requireOrganisationWide(c);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const closure = checkComplaintClosure({
        outcomeRecorded: body.outcome.trim().length >= 20,
        icoRightStated: body.icoRightStated,
      });
      if (!closure.ok) throw unprocessable(closure.problem, closure.message);
      const out = await dpTransaction(c, async (tx) => {
        const saved = await changeComplaint(
          tx,
          id,
          body.expectedVersion,
          (row) => {
            checkComplaintDay(row, body.closedOn);
            if (!row.acknowledgedOn) {
              throw unprocessable("not_acknowledged", "Record the acknowledgement first.");
            }
          },
          () => ({
            status: "closed",
            outcome: body.outcome,
            icoRightStated: body.icoRightStated,
            closedOn: body.closedOn,
            closedBy: access.tenantUserId,
          }),
        );
        await complaintAudit(c, tx, access, "closed", id);
        return oneComplaint(tx, access, saved);
      });
      return c.json(out, 200);
    },
  );
