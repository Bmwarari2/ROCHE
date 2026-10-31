import { z } from "zod";

/**
 * Data security evidence (QUAL-012; quality.md section 18): the DSPT assertion tracker with its
 * evidence, DSPT submissions, and Cyber Essentials and ICO registration records. Statuses are worked
 * out by the API from the stored dates and the rate table on every read, never stored; a kind with
 * no record is `missing`, never assumed current.
 */

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });
const ukDate = z.iso.date();
const FinancialYear = z.string().regex(/^[0-9]{4}\/[0-9]{2}$/, "Use the form 2025/26");
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const Versioned = { expectedVersion: z.number().int().min(1) };

export const DsptAssertionStatus = z
  .enum(["not_started", "in_progress", "met", "not_met", "not_applicable"])
  .meta({ id: "DsptAssertionStatus" });
export const DsptOutcome = z
  .enum(["standards_met", "approaching_standards", "standards_not_met"])
  .meta({ id: "DsptOutcome" });
export const CertificateKind = z
  .enum(["cyber_essentials", "cyber_essentials_plus", "ico_registration"])
  .meta({ id: "SecurityCertificateKind" });
export const RenewalStatus = z
  .enum(["current", "due_soon", "expired", "missing"])
  .meta({ id: "RenewalStatus" });

export const DsptAssertionOut = z
  .object({
    id: uuid,
    financialYear: FinancialYear,
    assertionRef: z.string(),
    title: z.string(),
    status: DsptAssertionStatus,
    notes: z.string().nullable(),
    ownerId: uuid.nullable(),
    /** The organisation documents linked as evidence now. */
    evidence: z.array(z.object({ documentId: uuid, linkedAt: isoDateTime, linkedBy: uuid })),
    version: z.number().int(),
  })
  .meta({ id: "DsptAssertion" });

export const DsptAssertionList = z
  .object({ financialYear: FinancialYear, items: z.array(DsptAssertionOut) })
  .meta({ id: "DsptAssertionList" });

export const RecordDsptAssertion = z
  .object({
    financialYear: FinancialYear,
    assertionRef: z
      .string()
      .regex(/^[0-9]{1,2}(\.[0-9]{1,2}){1,3}$/, "Use the toolkit's numbering"),
    title: text(3, 500),
    ownerId: uuid.nullable().optional(),
  })
  .meta({ id: "RecordDsptAssertion" });

export const ChangeDsptAssertion = z
  .object({
    ...Versioned,
    status: DsptAssertionStatus,
    notes: text(1, 4000).nullable().optional(),
    ownerId: uuid.nullable().optional(),
  })
  .meta({ id: "ChangeDsptAssertion" });

export const LinkDsptEvidence = z.object({ documentId: uuid }).meta({ id: "LinkDsptEvidence" });

export const DsptSubmissionOut = z
  .object({
    id: uuid,
    financialYear: FinancialYear,
    submittedOn: ukDate,
    outcome: DsptOutcome,
    reference: z.string().nullable(),
    version: z.number().int(),
  })
  .meta({ id: "DsptSubmission" });

export const RecordDsptSubmission = z
  .object({
    financialYear: FinancialYear,
    submittedOn: ukDate,
    outcome: DsptOutcome,
    reference: text(1, 100).nullable().optional(),
  })
  .meta({ id: "RecordDsptSubmission" });

export const CorrectDsptSubmission = z
  .object({
    ...Versioned,
    submittedOn: ukDate,
    outcome: DsptOutcome,
    reference: text(1, 100).nullable().optional(),
  })
  .meta({ id: "CorrectDsptSubmission" });

export const SecurityCertificateOut = z
  .object({
    id: uuid,
    kind: CertificateKind,
    reference: z.string(),
    issuedOn: ukDate,
    expiresOn: ukDate.nullable(),
    issuer: z.string().nullable(),
    documentId: uuid.nullable(),
    version: z.number().int(),
  })
  .meta({ id: "SecurityCertificate" });

export const RecordSecurityCertificate = z
  .object({
    kind: CertificateKind,
    reference: text(1, 100),
    issuedOn: ukDate,
    expiresOn: ukDate.nullable().optional(),
    issuer: text(1, 200).nullable().optional(),
    documentId: uuid.nullable().optional(),
  })
  .meta({ id: "RecordSecurityCertificate" });

export const DataSecurityOverview = z
  .object({
    /** The UK date the statuses were worked out for. */
    on: ukDate,
    dspt: z.object({
      status: z.enum(["submitted", "due", "due_soon", "overdue"]),
      deadline: ukDate,
      financialYear: FinancialYear,
      /** Submitted with the outcome "standards not met". */
      flagged: z.boolean(),
      assertions: z.object({
        total: z.number().int(),
        byStatus: z.record(DsptAssertionStatus, z.number().int()),
        /** Marked met but holding no evidence now (an unlinked document). */
        metWithoutEvidence: z.number().int(),
      }),
    }),
    certificates: z.array(
      z.object({
        kind: CertificateKind,
        status: RenewalStatus,
        expiresOn: ukDate.nullable(),
        latest: SecurityCertificateOut.nullable(),
      }),
    ),
    /** The breach register and complaints (slice 20); the DSAR register joins with slice 15. */
    registers: z.object({
      openBreaches: z.number().int(),
      breachesPastIcoClock: z.number().int(),
      openComplaints: z.number().int(),
    }),
  })
  .meta({ id: "DataSecurityOverview" });

export const DsptSubmissionList = z
  .object({ items: z.array(DsptSubmissionOut) })
  .meta({ id: "DsptSubmissionList" });

export const SecurityCertificateList = z
  .object({ items: z.array(SecurityCertificateOut) })
  .meta({ id: "SecurityCertificateList" });
