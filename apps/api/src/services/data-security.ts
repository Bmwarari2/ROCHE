import {
  dsptSubmission,
  rateTable,
  securityCertificate,
  type Transaction,
  task,
  tenant,
} from "@harbour/db";
import {
  type CertificateKind,
  certificateStatus,
  dsptStatus,
  fromUkWallClock,
  QUALITY_PHASE_2_RATE_KEYS,
  type QualityPhase2Rates,
  type RateNation,
  RateNotFoundError,
  resolveQualityPhase2Rates,
  ukIsoDate,
} from "@harbour/domain";
import { and, eq, inArray, isNull } from "drizzle-orm";

/**
 * Data security evidence for the API and the worker (QUAL-012; quality.md section 22): the
 * figures from the rate table, the statuses worked out from the records (rules 29 to 31), and the
 * renewal tasks (rule 36). Nothing is stored about status; nothing is assumed current.
 */

type Nation = Exclude<RateNation, "uk" | "all">;

export const CERTIFICATE_KINDS: readonly CertificateKind[] = [
  "cyber_essentials",
  "cyber_essentials_plus",
  "ico_registration",
];

export const DSPT_TASK = "quality.dspt_submission";
export const CERTIFICATE_TASK = "quality.certificate_renewal";

/** The Phase 2 quality figures for the organisation's nation on a UK date (fails loudly). */
export async function dataSecurityRates(
  tx: Transaction,
  tenantId: string,
  on: string,
): Promise<QualityPhase2Rates> {
  const [t] = await tx
    .select({ nation: tenant.nation })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  const rows = await tx
    .select()
    .from(rateTable)
    .where(inArray(rateTable.key, Object.values(QUALITY_PHASE_2_RATE_KEYS)));
  return resolveQualityPhase2Rates(
    rows.map((r) => ({
      key: r.key,
      value: r.value,
      unit: r.unit,
      nation: r.nation,
      validFrom: r.validFrom,
      validTo: r.validTo,
      tenantId: r.tenantId,
      verificationStatus: r.verificationStatus,
      source: r.source,
    })),
    (t?.nation ?? "england") as Nation,
    on,
    tenantId,
  );
}

/** Where the DSPT and each certificate kind stand today, from the records and the rate table. */
export async function dataSecurityStatuses(tx: Transaction, tenantId: string, now: Date) {
  const on = ukIsoDate(now);
  const rates = await dataSecurityRates(tx, tenantId, on);
  const submissions = await tx.select().from(dsptSubmission);
  const certificates = await tx.select().from(securityCertificate);
  const dspt = dsptStatus(
    submissions.map((s) => ({
      financialYear: s.financialYear,
      submittedOn: s.submittedOn,
      outcome: s.outcome as "standards_met" | "approaching_standards" | "standards_not_met",
    })),
    on,
    rates,
  );
  const records = certificates.map((c) => ({
    kind: c.kind as CertificateKind,
    reference: c.reference,
    issuedOn: c.issuedOn,
    expiresOn: c.expiresOn,
  }));
  const kinds = CERTIFICATE_KINDS.map((kind) => {
    const status = certificateStatus(records, kind, on, rates);
    const latest =
      certificates
        .filter((c) => c.kind === kind)
        .sort((a, b) => b.issuedOn.localeCompare(a.issuedOn))[0] ?? null;
    return { kind, ...status, latest };
  });
  return { on, rates, dspt, kinds };
}

/**
 * Rule 36: one renewal task per DSPT deadline while the year is due soon or overdue and not
 * submitted, and one per certificate expiry while the newest of a kind is due soon or expired. To
 * the owner role, with `quality.dsar.manage` required; ids only and a generic title. Raised once:
 * a task already raised for the same kind, source and due time, whatever its status, stops another.
 */
export async function raiseDataSecurityReminders(
  tx: Transaction,
  tenantId: string,
  now: Date,
): Promise<number> {
  let statuses: Awaited<ReturnType<typeof dataSecurityStatuses>>;
  try {
    statuses = await dataSecurityStatuses(tx, tenantId, now);
  } catch (error) {
    // No DSPT figures for the organisation's nation (the toolkit is England's): nothing to raise.
    // Anything else fails the organisation's sweep, so the failed-job alarm sees it.
    if (error instanceof RateNotFoundError) return 0;
    throw error;
  }
  const wanted: {
    kind: string;
    title: string;
    sourceType: string;
    sourceId: string | null;
    dueOn: string;
  }[] = [];
  const { dspt } = statuses;
  if (dspt.status === "due_soon" || dspt.status === "overdue") {
    wanted.push({
      kind: DSPT_TASK,
      title: "Submit the Data Security and Protection Toolkit before its deadline",
      sourceType: "dspt_year",
      sourceId: null,
      dueOn: dspt.deadline,
    });
  }
  for (const k of statuses.kinds) {
    if ((k.status === "due_soon" || k.status === "expired") && k.latest && k.expiresOn) {
      wanted.push({
        kind: CERTIFICATE_TASK,
        title:
          k.kind === "ico_registration"
            ? "Renew the organisation's ICO registration"
            : "Renew the organisation's Cyber Essentials certificate",
        sourceType: "security_certificate",
        sourceId: k.latest.id,
        dueOn: k.expiresOn,
      });
    }
  }
  let raised = 0;
  for (const w of wanted) {
    // The end of the UK day it falls due (23:59 Europe/London), never after it in summer time.
    const [y, m, d] = w.dueOn.split("-").map(Number) as [number, number, number];
    const dueAt = fromUkWallClock(y, m, d, 23, 59);
    // Once per kind, source and due time: two certificates expiring the same day each get one.
    const [already] = await tx
      .select({ id: task.id })
      .from(task)
      .where(
        and(
          eq(task.kind, w.kind),
          eq(task.sourceType, w.sourceType),
          w.sourceId ? eq(task.sourceId, w.sourceId) : isNull(task.sourceId),
          eq(task.dueAt, dueAt),
        ),
      )
      .limit(1);
    if (already) continue;
    await tx.insert(task).values({
      kind: w.kind,
      title: w.title,
      requiredPermission: "quality.dsar.manage",
      sourceType: w.sourceType,
      sourceId: w.sourceId,
      assigneeRoleKey: "owner",
      dueAt,
      windowStart: now < dueAt ? now : dueAt,
      windowEnd: dueAt,
      priority: "routine",
    });
    raised += 1;
  }
  return raised;
}
