import { Card, PageHeader } from "@harbour/ui";
import { CircleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Notice } from "@/components/care/Notice";
import { QualityChip } from "@/components/quality/QualityChip";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext, tenantApi } from "@/lib/api";
import {
  ASSERTION_STATUSES,
  assertionChip,
  dataSecurityShown,
  dsptChip,
  renewalChip,
} from "@/lib/data-security";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { readOrFail } from "@/lib/person-record";

export const metadata: Metadata = { title: t("quality.dataSecurity.title") };

const linkClass = "inline-flex min-h-target items-center underline";

/**
 * Data security evidence (QUAL-012; quality.md section 22): the DSPT year's status and deadline
 * with its assertions by status (met without evidence said apart), each certificate kind's status
 * (a missing one said as missing, never current), and the breach and complaint registers' counts.
 */
export default async function DataSecurityPage() {
  const { me } = await getShellContext();
  const title = t("quality.dataSecurity.title");
  if (!dataSecurityShown(me.permissions))
    return <SafetyForbidden title={title} hint={t("quality.dataSecurity.organisationOnly")} />;
  const api = await tenantApi();
  const overview = readOrFail(await api.GET("/v1/data-security"), "/quality/data-security");
  if (!overview)
    return <SafetyForbidden title={title} hint={t("quality.dataSecurity.organisationOnly")} />;
  const { dspt, certificates, registers } = overview;
  const deadline = formatDate(dspt.deadline) ?? dspt.deadline;

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6 break-words">
      <PageHeader title={title} description={t("quality.dataSecurity.description")} />

      <Card
        as="section"
        title={t("quality.dataSecurity.dspt.title", { year: dspt.financialYear })}
        headingLevel={2}
      >
        <div className="flex flex-col gap-3">
          <span>
            <QualityChip chip={dsptChip(dspt.status, deadline, t)} />
          </span>
          <p className="m-0">
            {t("quality.dataSecurity.dspt.assertions", { total: dspt.assertions.total })}
          </p>
          <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
            {ASSERTION_STATUSES.map((status) => (
              <li key={status} className="flex items-center gap-2">
                <QualityChip chip={assertionChip(status, t)} />
                <span>{dspt.assertions.byStatus[status] ?? 0}</span>
              </li>
            ))}
          </ul>
          {dspt.assertions.metWithoutEvidence > 0 ? (
            <Notice
              icon={<CircleAlert size={20} aria-hidden="true" />}
              title={t("quality.dataSecurity.dspt.metWithoutEvidenceTitle")}
              tone="warning"
            >
              <p className="m-0">
                {t("quality.dataSecurity.dspt.metWithoutEvidence", {
                  count: dspt.assertions.metWithoutEvidence,
                })}
              </p>
            </Notice>
          ) : null}
          <p className="m-0 flex flex-wrap gap-4">
            <Link
              href={`/quality/data-security/assertions?year=${encodeURIComponent(dspt.financialYear)}`}
              className={linkClass}
            >
              {t("quality.dataSecurity.dspt.openAssertions")}
            </Link>
            <Link href="/quality/data-security/submissions" className={linkClass}>
              {t("quality.dataSecurity.dspt.openSubmissions")}
            </Link>
          </p>
        </div>
      </Card>

      <Card as="section" title={t("quality.dataSecurity.certificates.title")} headingLevel={2}>
        <div className="flex flex-col gap-3">
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {certificates.map((c) => (
              <li key={c.kind} className="flex flex-col gap-1 border-b border-border pb-3">
                <span className="font-semibold">
                  {t("quality.dataSecurity.kind", { kind: c.kind })}
                </span>
                <span>
                  <QualityChip chip={renewalChip(c.status, t)} />
                </span>
                <span className="text-body-dense text-text-secondary">
                  {c.latest
                    ? t("quality.dataSecurity.certificates.latest", {
                        reference: c.latest.reference,
                        issued: formatDate(c.latest.issuedOn) ?? "",
                        expires: formatDate(c.expiresOn) ?? "",
                        hasExpiry: String(c.expiresOn !== null),
                      })
                    : t("quality.dataSecurity.certificates.noRecord")}
                </span>
              </li>
            ))}
          </ul>
          <p className="m-0">
            <Link href="/quality/data-security/certificates" className={linkClass}>
              {t("quality.dataSecurity.certificates.open")}
            </Link>
          </p>
        </div>
      </Card>

      <Card as="section" title={t("quality.dataSecurity.registers.title")} headingLevel={2}>
        <ul className="m-0 flex flex-col gap-1 pl-5">
          <li>
            {t("quality.dataSecurity.registers.openBreaches", { count: registers.openBreaches })}
          </li>
          <li>
            {t("quality.dataSecurity.registers.pastIcoClock", {
              count: registers.breachesPastIcoClock,
            })}
          </li>
          <li>
            {t("quality.dataSecurity.registers.openComplaints", {
              count: registers.openComplaints,
            })}
          </li>
        </ul>
      </Card>
    </div>
  );
}
