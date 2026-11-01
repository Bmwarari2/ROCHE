import {
  ChangeDsptAssertion,
  CorrectDsptSubmission,
  DataSecurityOverview,
  DsptAssertionList,
  DsptAssertionOut,
  DsptSubmissionList,
  DsptSubmissionOut,
  LinkDsptEvidence,
  RecordDsptAssertion,
  RecordDsptSubmission,
  RecordSecurityCertificate,
  SecurityCertificateList,
  SecurityCertificateOut,
} from "@harbour/contracts";
import {
  document,
  dpBreach,
  dpComplaint,
  dsptAssertion,
  dsptEvidence,
  dsptSubmission,
  securityCertificate,
  type Transaction,
  tenantUser,
} from "@harbour/db";
import {
  breachClock,
  DATA_RIGHTS_RATE_KEYS,
  dsptDeadline,
  RateNotFoundError,
  ukIsoDate,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx } from "../http/audit";
import type { AppEnv, TenantAccess } from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { dataSecurityRates, dataSecurityStatuses } from "../services/data-security";
import { rateNumber } from "../services/rates";
import { dpTransaction, requireOrganisationWide } from "./data-protection";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";

/**
 * Data security evidence (QUAL-012; quality.md section 22): the DSPT assertion tracker with its
 * evidence, DSPT submissions, Cyber Essentials and ICO registration records, and an overview that
 * links them to the breach register and complaints. Everything needs `quality.dsar.manage` across
 * the whole organisation (as slice 20), which row-level security checks again. Statuses are worked
 * out on every read from the rate table. Every read and change is audited with ids and codes only.
 */

type Tx = Transaction;
type AssertionRow = typeof dsptAssertion.$inferSelect;

const IdParam = z.object({ id: z.uuid() });
const unprocessable = (code: string, title: string) => new HttpProblem(422, code, title);
const today = () => ukIsoDate(new Date());

const audit = (
  c: Context<AppEnv>,
  tx: Tx,
  access: TenantAccess,
  action: string,
  resourceType: string,
  resourceId: string | null,
  scope: Record<string, unknown> = {},
) =>
  auditInTx(tx, access, {
    action: `quality.data_security.${action}`,
    resourceType,
    ...(resourceId ? { resourceId } : {}),
    scope,
    requestId: c.get("requestId"),
  });

/** The documents linked as evidence now: each document's latest event is a link. */
async function evidenceOf(tx: Tx, assertionIds: readonly string[]) {
  if (assertionIds.length === 0)
    return new Map<string, z.infer<typeof DsptAssertionOut>["evidence"]>();
  const events = await tx
    .select()
    .from(dsptEvidence)
    .where(inArray(dsptEvidence.assertionId, [...assertionIds]))
    .orderBy(asc(dsptEvidence.recordedAt), asc(dsptEvidence.id));
  const latest = new Map<string, typeof dsptEvidence.$inferSelect>();
  for (const e of events) latest.set(`${e.assertionId}:${e.documentId}`, e);
  const out = new Map<string, z.infer<typeof DsptAssertionOut>["evidence"]>();
  for (const e of latest.values()) {
    if (e.kind !== "linked") continue;
    const list = out.get(e.assertionId) ?? [];
    list.push({
      documentId: e.documentId,
      linkedAt: e.recordedAt.toISOString(),
      linkedBy: e.recordedBy,
    });
    out.set(e.assertionId, list);
  }
  return out;
}

async function assertionsOut(tx: Tx, rows: readonly AssertionRow[]) {
  const evidence = await evidenceOf(
    tx,
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({
    id: r.id,
    financialYear: r.financialYear,
    assertionRef: r.assertionRef,
    title: r.title,
    status: r.status as z.infer<typeof DsptAssertionOut>["status"],
    notes: r.notes,
    ownerId: r.ownerId,
    evidence: evidence.get(r.id) ?? [],
    version: r.version,
  }));
}

async function oneAssertion(tx: Tx, id: string) {
  const [row] = await tx.select().from(dsptAssertion).where(eq(dsptAssertion.id, id));
  if (!row) throw problems.notFound();
  return row;
}

async function checkOwner(tx: Tx, ownerId: string | null | undefined) {
  if (!ownerId) return;
  const [m] = await tx
    .select({ id: tenantUser.id })
    .from(tenantUser)
    .where(eq(tenantUser.id, ownerId));
  if (!m) throw unprocessable("owner_not_found", "That member is not in this organisation.");
}

/** Evidence and certificate copies are available organisation documents, never a person's. */
/** The records an organisation document may be attached to (as routes/documents.ts). */
const ORGANISATION_SUBJECT_TYPES: ReadonlySet<string> = new Set([
  "location",
  "escalation_policy",
  "statement_of_purpose_version",
  "letter_template_version",
]);

async function checkOrganisationDocument(tx: Tx, documentId: string) {
  const [d] = await tx
    .select({
      personId: document.personId,
      status: document.status,
      category: document.category,
      subjectType: document.subjectType,
      deletedAt: document.deletedAt,
    })
    .from(document)
    .where(eq(document.id, documentId));
  const usable =
    d !== undefined &&
    d.personId === null &&
    d.category === "organisation_document" &&
    d.status === "available" &&
    d.deletedAt === null &&
    (d.subjectType === null || ORGANISATION_SUBJECT_TYPES.has(d.subjectType));
  if (!usable) {
    throw unprocessable(
      "document_not_usable",
      "Choose an available organisation document, not a person's.",
    );
  }
}

const submissionOut = (r: typeof dsptSubmission.$inferSelect) => ({
  id: r.id,
  financialYear: r.financialYear,
  submittedOn: r.submittedOn,
  outcome: r.outcome as z.infer<typeof DsptSubmissionOut>["outcome"],
  reference: r.reference,
  version: r.version,
});

const certificateOut = (r: typeof securityCertificate.$inferSelect) => ({
  id: r.id,
  kind: r.kind as z.infer<typeof SecurityCertificateOut>["kind"],
  reference: r.reference,
  issuedOn: r.issuedOn,
  expiresOn: r.expiresOn,
  issuer: r.issuer,
  documentId: r.documentId,
  version: r.version,
});

const STATUSES = ["not_started", "in_progress", "met", "not_met", "not_applicable"] as const;

export const dataSecurityRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/data-security",
      tags: ["quality"],
      summary: "Where the DSPT, Cyber Essentials and ICO registration stand, with the registers",
      description:
        "quality.dsar.manage across the organisation. Worked out now from the records and the rate table (dspt.submission_deadline.*, quality.renewal_reminder_days, cyber_essentials.certificate_valid_months, ico.registration.renewal_months): the DSPT year's status and its assertions by status (met but holding no evidence counted apart); each certificate kind's status, missing when there is no record; and the breach register and complaints. Audited (quality.data_security.overview_viewed).",
      security,
      responses: { 200: jsonBody(DataSecurityOverview, "The overview"), ...errorResponses },
    }),
    async (c) => {
      const access = await requireOrganisationWide(c);
      const now = new Date();
      const out = await dpTransaction(c, async (tx) => {
        let statuses: Awaited<ReturnType<typeof dataSecurityStatuses>>;
        try {
          statuses = await dataSecurityStatuses(tx, access.tenantId, now);
        } catch (error) {
          if (!(error instanceof RateNotFoundError)) throw error;
          throw new HttpProblem(
            422,
            "rates_missing",
            "The data security figures are not set for this organisation's nation.",
          );
        }
        const rows = await tx
          .select()
          .from(dsptAssertion)
          .where(eq(dsptAssertion.financialYear, statuses.dspt.financialYear));
        const assertions = await assertionsOut(tx, rows);
        const byStatus = Object.fromEntries(
          STATUSES.map((s) => [s, assertions.filter((a) => a.status === s).length]),
        ) as Record<(typeof STATUSES)[number], number>;
        const open = await tx
          .select({ awareAt: dpBreach.awareAt, reportedAt: dpBreach.reportedAt })
          .from(dpBreach)
          .where(and(eq(dpBreach.status, "open"), isNull(dpBreach.deletedAt)));
        const hours = await rateNumber(
          tx,
          access.tenantId,
          DATA_RIGHTS_RATE_KEYS.breachReportHours,
        );
        const past = open.filter(
          (b) =>
            breachClock(
              { awareAt: b.awareAt, reportedAt: b.reportedAt, delayReason: null },
              { reportHours: hours },
              now,
            ).state === "overdue",
        ).length;
        const complaints = await tx
          .select({ id: dpComplaint.id })
          .from(dpComplaint)
          .where(eq(dpComplaint.status, "open"));
        await audit(c, tx, access, "overview_viewed", "data_security", null, {
          dsptStatus: statuses.dspt.status,
        });
        return {
          on: statuses.on,
          dspt: {
            ...statuses.dspt,
            assertions: {
              total: assertions.length,
              byStatus,
              metWithoutEvidence: assertions.filter(
                (a) => a.status === "met" && a.evidence.length === 0,
              ).length,
            },
          },
          certificates: statuses.kinds.map((k) => ({
            kind: k.kind,
            status: k.status,
            expiresOn: k.expiresOn,
            latest: k.latest ? certificateOut(k.latest) : null,
          })),
          registers: {
            openBreaches: open.length,
            breachesPastIcoClock: past,
            openComplaints: complaints.length,
          },
        };
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/data-security/dspt/assertions",
      tags: ["quality"],
      summary: "The DSPT assertions for a financial year, with the evidence linked now",
      description:
        "quality.dsar.manage across the organisation. The year defaults to the one whose deadline is next. Audited (quality.data_security.assertions_listed).",
      security,
      request: {
        query: z.object({
          financialYear: z
            .string()
            .regex(/^[0-9]{4}\/[0-9]{2}$/)
            .optional(),
        }),
      },
      responses: { 200: jsonBody(DsptAssertionList, "Assertions"), ...errorResponses },
    }),
    async (c) => {
      const access = await requireOrganisationWide(c);
      const q = c.req.valid("query");
      const out = await dpTransaction(c, async (tx) => {
        const financialYear =
          q.financialYear ??
          dsptDeadline(today(), await dataSecurityRates(tx, access.tenantId, today()))
            .financialYear;
        const rows = await tx
          .select()
          .from(dsptAssertion)
          .where(eq(dsptAssertion.financialYear, financialYear))
          .orderBy(asc(dsptAssertion.assertionRef));
        await audit(c, tx, access, "assertions_listed", "dspt_assertion", null, {
          financialYear,
          count: rows.length,
        });
        return { financialYear, items: await assertionsOut(tx, rows) };
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/data-security/dspt/assertions",
      tags: ["quality"],
      summary: "Track a DSPT assertion for a financial year",
      description:
        "quality.dsar.manage across the organisation. One per organisation, year and reference (409 already_tracked). Audited (quality.data_security.assertion_recorded).",
      security,
      request: { body: { content: { "application/json": { schema: RecordDsptAssertion } } } },
      responses: {
        201: jsonBody(DsptAssertionOut, "Tracked"),
        ...errorResponses,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireOrganisationWide(c);
      const body = c.req.valid("json");
      const out = await dpTransaction(c, async (tx) => {
        await checkOwner(tx, body.ownerId);
        const [row] = await tx
          .insert(dsptAssertion)
          .values({
            financialYear: body.financialYear,
            assertionRef: body.assertionRef,
            title: body.title,
            ownerId: body.ownerId ?? null,
          })
          .onConflictDoNothing()
          .returning();
        if (!row) {
          throw new HttpProblem(
            409,
            "already_tracked",
            "That assertion is already tracked for the year.",
          );
        }
        await audit(c, tx, access, "assertion_recorded", "dspt_assertion", row.id, {
          financialYear: row.financialYear,
        });
        const [one] = await assertionsOut(tx, [row]);
        return one;
      });
      return c.json(out, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/data-security/dspt/assertions/{id}/status",
      tags: ["quality"],
      summary: "Change where a DSPT assertion stands",
      description:
        "quality.dsar.manage across the organisation. Met needs evidence linked (422 evidence_required); not met and not applicable need notes (422 notes_required). Send the record's version (409 when stale). Audited (quality.data_security.assertion_changed) with the status code.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: ChangeDsptAssertion } } },
      },
      responses: {
        200: jsonBody(DsptAssertionOut, "Changed"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireOrganisationWide(c);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const out = await dpTransaction(c, async (tx) => {
        const row = await oneAssertion(tx, id);
        if (row.version !== body.expectedVersion) throw problems.conflict();
        await checkOwner(tx, body.ownerId);
        const notes = body.notes === undefined ? row.notes : body.notes;
        if ((body.status === "not_met" || body.status === "not_applicable") && !notes) {
          throw unprocessable("notes_required", "Say why in the notes.");
        }
        if (body.status === "met" && ((await evidenceOf(tx, [id])).get(id) ?? []).length === 0) {
          throw unprocessable("evidence_required", "Link the evidence before marking it met.");
        }
        const [saved] = await tx
          .update(dsptAssertion)
          .set({
            status: body.status,
            notes,
            ...(body.ownerId !== undefined ? { ownerId: body.ownerId } : {}),
          })
          .where(and(eq(dsptAssertion.id, id), eq(dsptAssertion.version, body.expectedVersion)))
          .returning();
        if (!saved) throw problems.conflict();
        await audit(c, tx, access, "assertion_changed", "dspt_assertion", id, {
          status: body.status,
        });
        const [one] = await assertionsOut(tx, [saved]);
        return one;
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/data-security/dspt/assertions/{id}/evidence",
      tags: ["quality"],
      summary: "Link an organisation document as evidence for an assertion",
      description:
        "quality.dsar.manage across the organisation. An available organisation document, never a person's (422 document_not_usable); already linked is refused (409 already_linked). Append-only. Audited (quality.data_security.evidence_linked).",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: LinkDsptEvidence } } },
      },
      responses: {
        200: jsonBody(DsptAssertionOut, "Linked"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireOrganisationWide(c);
      const { id } = c.req.valid("param");
      const { documentId } = c.req.valid("json");
      const out = await dpTransaction(c, async (tx) => {
        const row = await oneAssertion(tx, id);
        await checkOrganisationDocument(tx, documentId);
        const linked = (await evidenceOf(tx, [id])).get(id) ?? [];
        if (linked.some((e) => e.documentId === documentId)) {
          throw new HttpProblem(409, "already_linked", "That document is already evidence for it.");
        }
        await tx.insert(dsptEvidence).values({ assertionId: id, documentId, kind: "linked" });
        await audit(c, tx, access, "evidence_linked", "dspt_assertion", id, { documentId });
        const [one] = await assertionsOut(tx, [row]);
        return one;
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/data-security/dspt/assertions/{id}/evidence/{documentId}/unlink",
      tags: ["quality"],
      summary: "Stop using a document as evidence for an assertion",
      description:
        "quality.dsar.manage across the organisation. Recorded as a new event (append-only); a document not linked now is refused (409 not_linked). An assertion marked met keeps its status but is counted as met without evidence in the overview until evidence is linked again. Audited (quality.data_security.evidence_unlinked).",
      security,
      request: { params: z.object({ id: z.uuid(), documentId: z.uuid() }) },
      responses: {
        200: jsonBody(DsptAssertionOut, "Unlinked"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireOrganisationWide(c);
      const { id, documentId } = c.req.valid("param");
      const out = await dpTransaction(c, async (tx) => {
        const row = await oneAssertion(tx, id);
        const linked = (await evidenceOf(tx, [id])).get(id) ?? [];
        if (!linked.some((e) => e.documentId === documentId)) {
          throw new HttpProblem(409, "not_linked", "That document is not evidence for it now.");
        }
        await tx.insert(dsptEvidence).values({ assertionId: id, documentId, kind: "unlinked" });
        await audit(c, tx, access, "evidence_unlinked", "dspt_assertion", id, { documentId });
        const [one] = await assertionsOut(tx, [row]);
        return one;
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/data-security/dspt/submissions",
      tags: ["quality"],
      summary: "The organisation's DSPT submissions, newest year first",
      description:
        "quality.dsar.manage across the organisation. Audited (quality.data_security.submissions_listed).",
      security,
      responses: { 200: jsonBody(DsptSubmissionList, "Submissions"), ...errorResponses },
    }),
    async (c) => {
      const access = await requireOrganisationWide(c);
      const items = await dpTransaction(c, async (tx) => {
        const rows = await tx
          .select()
          .from(dsptSubmission)
          .orderBy(desc(dsptSubmission.financialYear));
        await audit(c, tx, access, "submissions_listed", "dspt_submission", null, {
          count: rows.length,
        });
        return rows.map(submissionOut);
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/data-security/dspt/submissions",
      tags: ["quality"],
      summary: "Record the DSPT submission for a financial year",
      description:
        "quality.dsar.manage across the organisation. One per year (409 already_recorded: correct it instead); submitted on a day not in the future, for a year whose deadline is no more than a year away (422 year_out_of_range). Audited (quality.data_security.submission_recorded) with the outcome code.",
      security,
      request: { body: { content: { "application/json": { schema: RecordDsptSubmission } } } },
      responses: {
        201: jsonBody(DsptSubmissionOut, "Recorded"),
        ...errorResponses,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireOrganisationWide(c);
      const body = c.req.valid("json");
      if (body.submittedOn > today())
        throw unprocessable("date_in_future", "The day cannot be in the future.");
      const out = await dpTransaction(c, async (tx) => {
        const next = dsptDeadline(today(), await dataSecurityRates(tx, access.tenantId, today()));
        if (body.financialYear > next.financialYear) {
          throw unprocessable("year_out_of_range", "That year's toolkit is not open yet.");
        }
        const [row] = await tx
          .insert(dsptSubmission)
          .values({
            financialYear: body.financialYear,
            submittedOn: body.submittedOn,
            outcome: body.outcome,
            reference: body.reference ?? null,
          })
          .onConflictDoNothing()
          .returning();
        if (!row) {
          throw new HttpProblem(
            409,
            "already_recorded",
            "A submission is already recorded for that year.",
          );
        }
        await audit(c, tx, access, "submission_recorded", "dspt_submission", row.id, {
          financialYear: row.financialYear,
          outcome: row.outcome,
        });
        return submissionOut(row);
      });
      return c.json(out, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/data-security/dspt/submissions/{id}/correct",
      tags: ["quality"],
      summary: "Correct a recorded DSPT submission",
      description:
        "quality.dsar.manage across the organisation. Send the record's version (409 when stale); the earlier values stay in its history. Audited (quality.data_security.submission_corrected).",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: CorrectDsptSubmission } } },
      },
      responses: {
        200: jsonBody(DsptSubmissionOut, "Corrected"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireOrganisationWide(c);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      if (body.submittedOn > today())
        throw unprocessable("date_in_future", "The day cannot be in the future.");
      const out = await dpTransaction(c, async (tx) => {
        const [row] = await tx.select().from(dsptSubmission).where(eq(dsptSubmission.id, id));
        if (!row) throw problems.notFound();
        const [saved] = await tx
          .update(dsptSubmission)
          .set({
            submittedOn: body.submittedOn,
            outcome: body.outcome,
            reference: body.reference ?? null,
          })
          .where(and(eq(dsptSubmission.id, id), eq(dsptSubmission.version, body.expectedVersion)))
          .returning();
        if (!saved) throw problems.conflict();
        await audit(c, tx, access, "submission_corrected", "dspt_submission", id, {
          outcome: saved.outcome,
        });
        return submissionOut(saved);
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/data-security/certificates",
      tags: ["quality"],
      summary: "Cyber Essentials and ICO registration records, newest first",
      description:
        "quality.dsar.manage across the organisation. Audited (quality.data_security.certificates_listed).",
      security,
      responses: { 200: jsonBody(SecurityCertificateList, "Records"), ...errorResponses },
    }),
    async (c) => {
      const access = await requireOrganisationWide(c);
      const items = await dpTransaction(c, async (tx) => {
        const rows = await tx
          .select()
          .from(securityCertificate)
          .orderBy(desc(securityCertificate.issuedOn));
        await audit(c, tx, access, "certificates_listed", "security_certificate", null, {
          count: rows.length,
        });
        return rows.map(certificateOut);
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/data-security/certificates",
      tags: ["quality"],
      summary: "Record a Cyber Essentials, Cyber Essentials Plus or ICO registration",
      description:
        "quality.dsar.manage across the organisation. Issued on a day not in the future; a stated expiry after issue; a copy must be an available organisation document. The newest record of a kind counts for its status. Audited (quality.data_security.certificate_recorded) with the kind.",
      security,
      request: { body: { content: { "application/json": { schema: RecordSecurityCertificate } } } },
      responses: { 201: jsonBody(SecurityCertificateOut, "Recorded"), ...errorResponses },
    }),
    async (c) => {
      const access = await requireOrganisationWide(c);
      const body = c.req.valid("json");
      if (body.issuedOn > today())
        throw unprocessable("date_in_future", "The day cannot be in the future.");
      if (body.expiresOn && body.expiresOn <= body.issuedOn) {
        throw unprocessable(
          "expiry_before_issue",
          "The expiry must be after the day it was issued.",
        );
      }
      const out = await dpTransaction(c, async (tx) => {
        if (body.documentId) await checkOrganisationDocument(tx, body.documentId);
        const [row] = await tx
          .insert(securityCertificate)
          .values({
            kind: body.kind,
            reference: body.reference,
            issuedOn: body.issuedOn,
            expiresOn: body.expiresOn ?? null,
            issuer: body.issuer ?? null,
            documentId: body.documentId ?? null,
          })
          .returning();
        if (!row) throw problems.conflict();
        await audit(c, tx, access, "certificate_recorded", "security_certificate", row.id, {
          kind: row.kind,
        });
        return certificateOut(row);
      });
      return c.json(out, 201);
    },
  );
