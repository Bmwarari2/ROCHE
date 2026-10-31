import {
  AcknowledgeStaffPrivacyNotice,
  ChangeLdssClaimStatus,
  CreateLdssClaim,
  CreateSponsoredWorker,
  DecideStaffImageConsent,
  LdssClaim,
  LdssClaimList,
  MarkSponsorReportReported,
  RecordSponsorAbsence,
  RecordSponsorReport,
  SetStaffPrivacyNotice,
  SponsoredWorker,
  SponsoredWorkerList,
  StaffPrivacy,
  UpdateSponsoredWorker,
} from "@harbour/contracts";
import {
  ldssClaim,
  sponsorAbsence,
  sponsoredWorker,
  sponsorReport,
  staffImageConsent,
  staffPrivacyAcknowledgement,
  type Transaction,
  tenant,
} from "@harbour/db";
import {
  appendixDGaps,
  changeReportState,
  checkLdssTransition,
  IMAGE_PURPOSES,
  imageConsent,
  type LdssStatus,
  privacyNoticeAcknowledged,
  resolveSponsorshipRates,
  resolveWorkforceRates,
  SPONSORSHIP_RATE_KEYS,
  salaryCheck,
  ukIsoDate,
  unauthorisedAbsence,
  visaExpiryState,
  WORKFORCE_RATE_KEYS,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { AuditedRefusal, withAuditedRefusal, writeAudit } from "../http/audit";
import { type AppEnv, requirePermission, type TenantAccess, withTenant } from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { bankHolidays, rateRows } from "../services/rates";
import { type StaffLookup, staffNames } from "../services/staff";
import { isCurrentStaff } from "../services/staff-files";
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
 * Sponsored workers, the staff privacy notice, staff image consent and LDSS claims (workforce.md
 * section 12; slice 35; WORK-003, WORK-007, WORK-011). Sponsor records need
 * workforce.immigration.read to read and workforce.sponsor.manage to change, never one's own; the
 * notice and image consent are the member's own (workforce.self.read), read by HR with
 * workforce.staff_file.read; LDSS claims need workforce.ldss.manage. The database enforces the same
 * (migration 0097). Audit events carry opaque ids and codes only.
 */

const IMMIGRATION = "workforce.immigration.read";
const SPONSOR = "workforce.sponsor.manage";
const LDSS = "workforce.ldss.manage";
const STAFF_FILE = "workforce.staff_file.read";
const SELF = "workforce.self.read";
const TENANT = "platform.tenant.manage";
const SOURCE = "sponsored_worker";
const A = {
  listed: "workforce.sponsored_worker.listed",
  created: "workforce.sponsored_worker.created",
  updated: "workforce.sponsored_worker.updated",
  absence: "workforce.sponsor_absence.recorded",
  report: "workforce.sponsor_report.recorded",
  reported: "workforce.sponsor_report.reported",
  noticeSet: "workforce.staff_privacy_notice.set",
  acknowledged: "workforce.staff_privacy_notice.acknowledged",
  consent: "workforce.staff_image_consent.decided",
  privacyViewed: "workforce.staff_privacy.viewed",
  ldssCreated: "workforce.ldss_claim.created",
  ldssChanged: "workforce.ldss_claim.status_changed",
} as const;

const IdParam = z.object({ id: z.uuid() });

type WorkerRow = typeof sponsoredWorker.$inferSelect;
type ClaimRow = typeof ldssClaim.$inferSelect;

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

const ownRecord = (action: string, id: string | null) =>
  refused(
    new HttpProblem(403, "own_sponsor_record", "Someone else keeps your own sponsor records."),
    action,
    SOURCE,
    id,
    "own_sponsor_record",
  );

/** Runs a change; refusals and the database's own (403, 409, 422) are audited. */
async function change<T>(
  c: Context<AppEnv>,
  access: TenantAccess,
  action: string,
  resourceType: string,
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
      resourceType,
      ...(id ? { resourceId: id } : {}),
      reason: code === "42501" ? "refused_by_database" : `invalid_${code}`,
      requestId: c.get("requestId"),
    });
    if (code === "42501") throw problems.forbidden();
    if (code === "23505") {
      throw new HttpProblem(409, "already_recorded", "This has already been recorded.");
    }
    if (code === "23503") throw problems.invalid("Choose a member of staff of this organisation.");
    throw problems.invalid(
      "Those details cannot be saved together. Check the dates and try again.",
    );
  }
}

const today = () => ukIsoDate(new Date());

/** The figures and bank holidays for the organisation's nation, in force today. */
async function clocks(tx: Transaction, tenantId: string, on: string) {
  const [t] = await tx
    .select({ nation: tenant.nation })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  const nation = t?.nation ?? "england";
  const workforce = resolveWorkforceRates(
    await rateRows(tx, Object.values(WORKFORCE_RATE_KEYS)),
    nation,
    on,
    tenantId,
  );
  const sponsorship = resolveSponsorshipRates(
    await rateRows(tx, Object.values(SPONSORSHIP_RATE_KEYS)),
    nation,
    on,
    tenantId,
  );
  return { rates: { ...workforce, ...sponsorship }, holidays: await bankHolidays(tx, nation) };
}
type Clocks = Awaited<ReturnType<typeof clocks>>;

function workerView(
  row: WorkerRow,
  absences: (typeof sponsorAbsence.$inferSelect)[],
  reports: (typeof sponsorReport.$inferSelect)[],
  names: StaffLookup,
  { rates, holidays }: Clocks,
  on: string,
) {
  const hours = Number(row.contractedWeeklyHours);
  const pay = Number(row.guaranteedYearlyPay);
  const salary = salaryCheck(pay, hours, rates);
  const absence = unauthorisedAbsence(
    absences.map((a) => ({ from: a.fromOn, to: a.toOn, authorised: a.authorised })),
    holidays,
    rates,
  );
  const reported =
    absence.reportable &&
    reports.some((r) => r.kind === "unauthorised_absence" && r.happenedOn >= absence.happenedOn);
  return {
    id: row.id,
    version: row.version,
    tenantUserId: row.tenantUserId,
    member: names(row.tenantUserId) ?? {
      id: row.tenantUserId,
      displayName: "Unknown member",
      jobTitle: null,
    },
    cosReference: row.cosReference,
    cosAssignedOn: row.cosAssignedOn,
    socCode: row.socCode,
    route: row.route as SponsoredWorker["route"],
    visaExpiresOn: row.visaExpiresOn,
    contractedWeeklyHours: hours,
    guaranteedYearlyPay: pay,
    englishEvidence: row.englishEvidence as SponsoredWorker["englishEvidence"],
    switchingEvidenceOn: row.switchingEvidenceOn,
    appendixDHeld: row.appendixDHeld as SponsoredWorker["appendixDHeld"],
    status: row.status as SponsoredWorker["status"],
    endedOn: row.endedOn,
    visa: visaExpiryState(row.visaExpiresOn, on, rates),
    salary,
    appendixDGaps: appendixDGaps(row.appendixDHeld),
    absenceToReport:
      absence.reportable && !reported
        ? { happenedOn: absence.happenedOn, dueOn: absence.dueOn }
        : null,
    absences: absences
      .map((a) => ({ id: a.id, fromOn: a.fromOn, toOn: a.toOn, authorised: a.authorised }))
      .sort((x, y) => x.fromOn.localeCompare(y.fromOn)),
    reports: reports
      .map((r) => ({
        id: r.id,
        version: r.version,
        kind: r.kind as SponsoredWorker["reports"][number]["kind"],
        happenedOn: r.happenedOn,
        reportedOn: r.reportedOn,
        smsReference: r.smsReference,
        ...changeReportState(r.happenedOn, r.reportedOn, on, holidays, rates),
      }))
      .sort((x, y) => x.happenedOn.localeCompare(y.happenedOn)),
    asOf: on,
  };
}

async function workerViews(tx: Transaction, access: TenantAccess, rows: WorkerRow[], on: string) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const absences = await tx
    .select()
    .from(sponsorAbsence)
    .where(and(inArray(sponsorAbsence.sponsoredWorkerId, ids), isNull(sponsorAbsence.deletedAt)));
  const reports = await tx
    .select()
    .from(sponsorReport)
    .where(and(inArray(sponsorReport.sponsoredWorkerId, ids), isNull(sponsorReport.deletedAt)));
  const names = await staffNames(
    tx,
    rows.map((r) => r.tenantUserId),
  );
  const c = await clocks(tx, access.tenantId, on);
  return rows.map((row) =>
    workerView(
      row,
      absences.filter((a) => a.sponsoredWorkerId === row.id),
      reports.filter((r) => r.sponsoredWorkerId === row.id),
      names,
      c,
      on,
    ),
  );
}

async function workerFor(tx: Transaction, access: TenantAccess, action: string, id: string) {
  const [row] = await tx
    .select()
    .from(sponsoredWorker)
    .where(and(eq(sponsoredWorker.id, id), isNull(sponsoredWorker.deletedAt)));
  if (!row) throw refused(problems.notFound(), action, SOURCE, id, "not_found");
  if (row.tenantUserId === access.tenantUserId) throw ownRecord(action, id);
  return row;
}

async function oneWorkerView(tx: Transaction, access: TenantAccess, id: string, on: string) {
  const [row] = await tx.select().from(sponsoredWorker).where(eq(sponsoredWorker.id, id));
  if (!row) throw new Error("sponsored worker not readable after change");
  const [view] = await workerViews(tx, access, [row], on);
  if (!view) throw new Error("sponsored worker view not built");
  return view;
}

const workerValues = (body: CreateSponsoredWorker | UpdateSponsoredWorker) => ({
  cosReference: body.cosReference,
  cosAssignedOn: body.cosAssignedOn,
  socCode: body.socCode,
  route: body.route,
  visaExpiresOn: body.visaExpiresOn,
  contractedWeeklyHours: String(body.contractedWeeklyHours),
  guaranteedYearlyPay: String(body.guaranteedYearlyPay),
  englishEvidence: body.englishEvidence,
  switchingEvidenceOn: body.switchingEvidenceOn,
  appendixDHeld: [...new Set(body.appendixDHeld)],
});

/** The member's own notice and image consent state. */
async function privacyOf(tx: Transaction, tenantId: string, member: string): Promise<StaffPrivacy> {
  const [t] = await tx
    .select({ version: tenant.staffPrivacyNoticeVersion })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  const acknowledgements = await tx
    .select({ version: staffPrivacyAcknowledgement.noticeVersion })
    .from(staffPrivacyAcknowledgement)
    .where(eq(staffPrivacyAcknowledgement.tenantUserId, member))
    .orderBy(staffPrivacyAcknowledgement.acknowledgedAt);
  const decisions = await tx
    .select()
    .from(staffImageConsent)
    .where(eq(staffImageConsent.tenantUserId, member));
  const versions = acknowledgements.map((a) => a.version);
  const current = t?.version ?? null;
  const events = decisions.map((d) => ({
    purpose: d.purpose as (typeof IMAGE_PURPOSES)[number],
    decision: d.decision as "given" | "refused" | "withdrawn",
    at: `${d.decidedAt.toISOString()}|${d.id}`,
  }));
  return {
    tenantUserId: member,
    currentNoticeVersion: current,
    acknowledged: privacyNoticeAcknowledged(versions, current),
    acknowledgedVersions: versions,
    imageConsent: IMAGE_PURPOSES.map((purpose) => ({ purpose, ...imageConsent(events, purpose) })),
  };
}

function claimView(row: ClaimRow, names: StaffLookup) {
  return {
    id: row.id,
    version: row.version,
    tenantUserId: row.tenantUserId,
    member: names(row.tenantUserId) ?? {
      id: row.tenantUserId,
      displayName: "Unknown member",
      jobTitle: null,
    },
    courseTitle: row.courseTitle,
    completedOn: row.completedOn,
    claimedAmount: row.claimedAmount === null ? null : Number(row.claimedAmount),
    status: row.status as LdssStatus,
    reference: row.reference,
    submittedOn: row.submittedOn,
    paidOn: row.paidOn,
    reason: row.reason,
  };
}

const LDSS_PROBLEMS: Record<string, string> = {
  not_allowed: "A claim cannot move to that status from where it is.",
  reference_required: "Give the reference the claim was submitted under.",
  date_required: "Give the date.",
  reason_required: "Say why.",
};

export const sponsorshipRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/workforce/sponsored-workers",
      tags: ["workforce"],
      summary: "Sponsored workers",
      description:
        "workforce.immigration.read. Every sponsored worker but oneself, with the visa's state, the salary check, Appendix D gaps, absences, reportable changes and each report's due date today. Audited.",
      security,
      responses: { 200: jsonBody(SponsoredWorkerList, "Sponsored workers"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, IMMIGRATION);
      const on = today();
      const items = await withTenant(c, async (tx) => {
        const rows = await tx
          .select()
          .from(sponsoredWorker)
          .where(isNull(sponsoredWorker.deletedAt))
          .orderBy(sponsoredWorker.createdAt);
        await audit(c, tx, access, { action: A.listed, resourceType: SOURCE });
        return workerViews(tx, access, rows, on);
      });
      return c.json({ items, asOf: on }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/sponsored-workers",
      tags: ["workforce"],
      summary: "Record a sponsored worker",
      description:
        "workforce.sponsor.manage. One active record per member of staff, never one's own. Audited.",
      security,
      request: { body: { content: { "application/json": { schema: CreateSponsoredWorker } } } },
      responses: {
        201: jsonBody(SponsoredWorker, "Recorded"),
        ...errorResponses,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, SPONSOR);
      const body = c.req.valid("json");
      const on = today();
      const view = await change(c, access, A.created, SOURCE, null, async (tx) => {
        if (body.tenantUserId === access.tenantUserId) throw ownRecord(A.created, null);
        if (!(await isCurrentStaff(tx, body.tenantUserId))) {
          throw refused(
            new HttpProblem(422, "not_current_staff", "Choose a current member of staff."),
            A.created,
            SOURCE,
            null,
            "not_current_staff",
          );
        }
        const [row] = await tx
          .insert(sponsoredWorker)
          .values({ tenantUserId: body.tenantUserId, ...workerValues(body) })
          .returning();
        if (!row) throw new Error("sponsored worker not stored");
        await audit(c, tx, access, {
          action: A.created,
          resourceType: SOURCE,
          resourceId: row.id,
          scopeExtra: { memberId: row.tenantUserId },
        });
        return oneWorkerView(tx, access, row.id, on);
      });
      return c.json(view, 201);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/workforce/sponsored-workers/{id}",
      tags: ["workforce"],
      summary: "Change a sponsored worker's record",
      description:
        "workforce.sponsor.manage. The certificate, visa, pay, evidence held and, with an end date, the end of sponsorship. Never one's own; a stale version is refused. Audited with the changed fields' names only.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: UpdateSponsoredWorker } } },
      },
      responses: {
        200: jsonBody(SponsoredWorker, "Changed"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, SPONSOR);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const on = today();
      const view = await change(c, access, A.updated, SOURCE, id, async (tx) => {
        const before = await workerFor(tx, access, A.updated, id);
        if (before.version !== body.expectedVersion) {
          throw refused(problems.conflict(), A.updated, SOURCE, id, "version_conflict");
        }
        const values = {
          ...workerValues(body),
          status: body.endedOn ? "ended" : "active",
          endedOn: body.endedOn,
        };
        const [row] = await tx
          .update(sponsoredWorker)
          .set(values)
          .where(and(eq(sponsoredWorker.id, id), eq(sponsoredWorker.version, body.expectedVersion)))
          .returning();
        if (!row) throw refused(problems.conflict(), A.updated, SOURCE, id, "version_conflict");
        const changed = (Object.keys(values) as (keyof typeof values)[]).filter(
          (k) => JSON.stringify(before[k]) !== JSON.stringify(row[k]),
        );
        await audit(c, tx, access, {
          action: A.updated,
          resourceType: SOURCE,
          resourceId: id,
          scopeExtra: { changed },
        });
        return oneWorkerView(tx, access, id, on);
      });
      return c.json(view, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/sponsored-workers/{id}/absences",
      tags: ["workforce"],
      summary: "Record a sponsored worker's absence",
      description:
        "workforce.sponsor.manage. An absence, authorised or not; the record then says whether unauthorised absence has passed the limit and when the report is due. Audited.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: RecordSponsorAbsence } } },
      },
      responses: {
        201: jsonBody(SponsoredWorker, "Recorded"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, SPONSOR);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const on = today();
      const view = await change(c, access, A.absence, "sponsor_absence", id, async (tx) => {
        await workerFor(tx, access, A.absence, id);
        const [row] = await tx
          .insert(sponsorAbsence)
          .values({ sponsoredWorkerId: id, ...body })
          .returning({ id: sponsorAbsence.id });
        if (!row) throw new Error("absence not stored");
        await audit(c, tx, access, {
          action: A.absence,
          resourceType: "sponsor_absence",
          resourceId: row.id,
          scopeExtra: { sponsoredWorkerId: id },
        });
        return oneWorkerView(tx, access, id, on);
      });
      return c.json(view, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/sponsored-workers/{id}/reports",
      tags: ["workforce"],
      summary: "Record a reportable change",
      description:
        "workforce.sponsor.manage. A change the sponsor must report on the sponsor management system, with the day it happened; the due date follows from the rate table and bank holidays. Audited.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: RecordSponsorReport } } },
      },
      responses: {
        201: jsonBody(SponsoredWorker, "Recorded"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, SPONSOR);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const on = today();
      if (body.happenedOn > on) throw problems.invalid("A change cannot have happened in future.");
      const view = await change(c, access, A.report, "sponsor_report", id, async (tx) => {
        await workerFor(tx, access, A.report, id);
        const [row] = await tx
          .insert(sponsorReport)
          .values({ sponsoredWorkerId: id, kind: body.kind, happenedOn: body.happenedOn })
          .returning({ id: sponsorReport.id });
        if (!row) throw new Error("report not stored");
        await audit(c, tx, access, {
          action: A.report,
          resourceType: "sponsor_report",
          resourceId: row.id,
          scopeExtra: { sponsoredWorkerId: id, kind: body.kind },
        });
        return oneWorkerView(tx, access, id, on);
      });
      return c.json(view, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/sponsor-reports/{id}/reported",
      tags: ["workforce"],
      summary: "Mark a change as reported",
      description:
        "workforce.sponsor.manage. The date it was reported on the sponsor management system and the reference given; never on one's own record. Audited.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: MarkSponsorReportReported } } },
      },
      responses: {
        200: jsonBody(SponsoredWorker, "Marked"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, SPONSOR);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const on = today();
      if (body.reportedOn > on) throw problems.invalid("It cannot have been reported in future.");
      const view = await change(c, access, A.reported, "sponsor_report", id, async (tx) => {
        const [report] = await tx
          .select()
          .from(sponsorReport)
          .where(and(eq(sponsorReport.id, id), isNull(sponsorReport.deletedAt)));
        if (!report)
          throw refused(problems.notFound(), A.reported, "sponsor_report", id, "not_found");
        await workerFor(tx, access, A.reported, report.sponsoredWorkerId);
        if (report.version !== body.expectedVersion || report.reportedOn !== null) {
          throw refused(problems.conflict(), A.reported, "sponsor_report", id, "version_conflict");
        }
        const [row] = await tx
          .update(sponsorReport)
          .set({ reportedOn: body.reportedOn, smsReference: body.smsReference })
          .where(and(eq(sponsorReport.id, id), eq(sponsorReport.version, body.expectedVersion)))
          .returning({ id: sponsorReport.id });
        if (!row) {
          throw refused(problems.conflict(), A.reported, "sponsor_report", id, "version_conflict");
        }
        await audit(c, tx, access, {
          action: A.reported,
          resourceType: "sponsor_report",
          resourceId: id,
          scopeExtra: { sponsoredWorkerId: report.sponsoredWorkerId },
        });
        return oneWorkerView(tx, access, report.sponsoredWorkerId, on);
      });
      return c.json(view, 200);
    },
  );

export const staffPrivacyRouter = createRouter()
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/workforce/staff-privacy-notice",
      tags: ["workforce"],
      summary: "Set the staff privacy notice in force",
      description:
        "platform.tenant.manage. The version of the organisation's staff privacy notice now in force; members are asked to acknowledge it. Audited.",
      security,
      request: { body: { content: { "application/json": { schema: SetStaffPrivacyNotice } } } },
      responses: {
        200: jsonBody(z.object({ version: z.string() }), "Set"),
        ...errorResponses,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, TENANT);
      const { version } = c.req.valid("json");
      await withTenant(c, async (tx) => {
        await tx
          .update(tenant)
          .set({ staffPrivacyNoticeVersion: version })
          .where(eq(tenant.id, access.tenantId));
        await audit(c, tx, access, {
          action: A.noticeSet,
          resourceType: "tenant",
          resourceId: access.tenantId,
          scopeExtra: { noticeVersion: version },
        });
      });
      return c.json({ version }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/me/staff-privacy",
      tags: ["workforce"],
      summary: "My staff privacy notice and image consent",
      description:
        "workforce.self.read. The notice version in force, whether the member has acknowledged it, and their decision on each optional use of their photo or image.",
      security,
      responses: { 200: jsonBody(StaffPrivacy, "Your privacy choices"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, SELF);
      const body = await withTenant(c, (tx) => privacyOf(tx, access.tenantId, access.tenantUserId));
      return c.json(body, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/me/staff-privacy/acknowledgements",
      tags: ["workforce"],
      summary: "Acknowledge the staff privacy notice",
      description:
        "workforce.self.read. The member acknowledges the version in force, once; kept as made. Audited.",
      security,
      request: {
        body: { content: { "application/json": { schema: AcknowledgeStaffPrivacyNotice } } },
      },
      responses: {
        200: jsonBody(StaffPrivacy, "Acknowledged"),
        ...errorResponses,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, SELF);
      const { noticeVersion } = c.req.valid("json");
      const body = await change(c, access, A.acknowledged, "tenant_user", null, async (tx) => {
        const now = await privacyOf(tx, access.tenantId, access.tenantUserId);
        if (now.currentNoticeVersion !== noticeVersion) {
          throw refused(
            new HttpProblem(
              409,
              "notice_version_changed",
              "The privacy notice has changed. Read the version in force and acknowledge that.",
            ),
            A.acknowledged,
            "tenant_user",
            access.tenantUserId,
            "notice_version_changed",
          );
        }
        if (now.acknowledged) return now;
        const [row] = await tx
          .insert(staffPrivacyAcknowledgement)
          .values({ tenantUserId: access.tenantUserId, noticeVersion })
          .returning({ id: staffPrivacyAcknowledgement.id });
        await audit(c, tx, access, {
          action: A.acknowledged,
          resourceType: "staff_privacy_acknowledgement",
          ...(row ? { resourceId: row.id } : {}),
          scopeExtra: { noticeVersion },
        });
        return privacyOf(tx, access.tenantId, access.tenantUserId);
      });
      return c.json(body, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/me/staff-image-consent",
      tags: ["workforce"],
      summary: "Decide on an optional use of my photo or image",
      description:
        "workforce.self.read. Give, refuse or withdraw consent for one optional use; the latest decision stands and earlier ones are kept. Audited.",
      security,
      request: {
        body: { content: { "application/json": { schema: DecideStaffImageConsent } } },
      },
      responses: { 200: jsonBody(StaffPrivacy, "Decided"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, SELF);
      const { purpose, decision } = c.req.valid("json");
      const body = await change(c, access, A.consent, "staff_image_consent", null, async (tx) => {
        const [row] = await tx
          .insert(staffImageConsent)
          .values({ tenantUserId: access.tenantUserId, purpose, decision })
          .returning({ id: staffImageConsent.id });
        await audit(c, tx, access, {
          action: A.consent,
          resourceType: "staff_image_consent",
          ...(row ? { resourceId: row.id } : {}),
          scopeExtra: { purpose, decision },
        });
        return privacyOf(tx, access.tenantId, access.tenantUserId);
      });
      return c.json(body, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/workforce/members/{id}/staff-privacy",
      tags: ["workforce"],
      summary: "A member's privacy notice acknowledgement and image consent",
      description:
        "workforce.staff_file.read. Whether the member has acknowledged the notice in force and their image consent decisions, before their photo is used. Audited.",
      security,
      request: { params: IdParam },
      responses: { 200: jsonBody(StaffPrivacy, "The member's choices"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, STAFF_FILE);
      const { id } = c.req.valid("param");
      const body = await withTenant(c, async (tx) => {
        await audit(c, tx, access, {
          action: A.privacyViewed,
          resourceType: "tenant_user",
          resourceId: id,
        });
        return privacyOf(tx, access.tenantId, id);
      });
      return c.json(body, 200);
    },
  );

export const ldssRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/workforce/ldss-claims",
      tags: ["workforce"],
      summary: "LDSS claims",
      description:
        "workforce.ldss.manage. Every Learning and Development Support Scheme claim, newest first.",
      security,
      responses: { 200: jsonBody(LdssClaimList, "Claims"), ...errorResponses },
    }),
    async (c) => {
      await requirePermission(c, LDSS);
      const items = await withTenant(c, async (tx) => {
        const rows = await tx
          .select()
          .from(ldssClaim)
          .where(isNull(ldssClaim.deletedAt))
          .orderBy(desc(ldssClaim.createdAt));
        const names = await staffNames(
          tx,
          rows.map((r) => r.tenantUserId),
        );
        return rows.map((r) => claimView(r, names));
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/ldss-claims",
      tags: ["workforce"],
      summary: "Plan an LDSS claim",
      description:
        "workforce.ldss.manage. A planned claim for a member's course; the amount as the claim states it. Audited.",
      security,
      request: { body: { content: { "application/json": { schema: CreateLdssClaim } } } },
      responses: { 201: jsonBody(LdssClaim, "Planned"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, LDSS);
      const body = c.req.valid("json");
      const view = await change(c, access, A.ldssCreated, "ldss_claim", null, async (tx) => {
        const [row] = await tx
          .insert(ldssClaim)
          .values({
            tenantUserId: body.tenantUserId,
            courseTitle: body.courseTitle,
            completedOn: body.completedOn,
            claimedAmount: body.claimedAmount === null ? null : String(body.claimedAmount),
          })
          .returning();
        if (!row) throw new Error("claim not stored");
        await audit(c, tx, access, {
          action: A.ldssCreated,
          resourceType: "ldss_claim",
          resourceId: row.id,
          scopeExtra: { memberId: row.tenantUserId },
        });
        return claimView(row, await staffNames(tx, [row.tenantUserId]));
      });
      return c.json(view, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/ldss-claims/{id}/status",
      tags: ["workforce"],
      summary: "Move an LDSS claim on",
      description:
        "workforce.ldss.manage. Submitted (reference and date), paid (date), rejected or withdrawn (a reason), or resubmitted after a rejection. A stale version is refused. Audited.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: ChangeLdssClaimStatus } } },
      },
      responses: {
        200: jsonBody(LdssClaim, "Moved on"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, LDSS);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      if (body.on && body.on > today()) throw problems.invalid("The date cannot be in future.");
      const view = await change(c, access, A.ldssChanged, "ldss_claim", id, async (tx) => {
        const [before] = await tx
          .select()
          .from(ldssClaim)
          .where(and(eq(ldssClaim.id, id), isNull(ldssClaim.deletedAt)));
        if (!before)
          throw refused(problems.notFound(), A.ldssChanged, "ldss_claim", id, "not_found");
        if (before.version !== body.expectedVersion) {
          throw refused(problems.conflict(), A.ldssChanged, "ldss_claim", id, "version_conflict");
        }
        const check = checkLdssTransition(before.status as LdssStatus, body.status, body);
        if (!check.ok) {
          throw refused(
            new HttpProblem(422, `ldss_${check.problem}`, LDSS_PROBLEMS[check.problem] ?? ""),
            A.ldssChanged,
            "ldss_claim",
            id,
            check.problem,
          );
        }
        const [row] = await tx
          .update(ldssClaim)
          .set({
            status: body.status,
            ...(body.status === "submitted"
              ? { reference: body.reference, submittedOn: body.on, reason: null }
              : {}),
            ...(body.status === "paid" ? { paidOn: body.on } : {}),
            ...(body.status === "rejected" || body.status === "withdrawn"
              ? { reason: body.reason }
              : {}),
          })
          .where(and(eq(ldssClaim.id, id), eq(ldssClaim.version, body.expectedVersion)))
          .returning();
        if (!row) {
          throw refused(problems.conflict(), A.ldssChanged, "ldss_claim", id, "version_conflict");
        }
        await audit(c, tx, access, {
          action: A.ldssChanged,
          resourceType: "ldss_claim",
          resourceId: id,
          scopeExtra: { from: before.status, to: row.status },
        });
        return claimView(row, await staffNames(tx, [row.tenantUserId]));
      });
      return c.json(view, 200);
    },
  );
