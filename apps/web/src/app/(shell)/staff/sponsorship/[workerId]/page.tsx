import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import {
  AbsenceForm,
  MarkReportedForm,
  ReportForm,
  SponsoredWorkerForm,
} from "@/components/staff/SponsorForms";
import { StaffChip } from "@/components/staff/StaffChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import {
  othersOnly,
  reportChip,
  SPONSOR_PAGE,
  salaryChip,
  sponsorManaged,
  sponsorShown,
  visaChip,
} from "@/lib/staff";

type Params = Promise<{ workerId: string }>;

export const metadata: Metadata = { title: t("sponsor.record.title") };

/**
 * One sponsored worker's record (WORK-003): where the visa, salary check and Appendix D records
 * stand; absences, with a warning when unauthorised absence has passed the limit; reportable
 * changes with their due dates; and, for holders of workforce.sponsor.manage, the forms to change
 * the record, record absences and changes, and mark a change reported. Never one's own record.
 */
export default async function SponsoredWorkerPage({ params }: { readonly params: Params }) {
  const { workerId } = await params;
  if (!isUuid(workerId)) notFound();
  const { me } = await getShellContext();
  if (!sponsorShown(me.permissions)) return <SafetyForbidden title={t("sponsor.title")} />;
  const api = await tenantApi();
  const listed = await api.GET("/v1/workforce/sponsored-workers");
  if (!listed.data) failWith(listed.error, listed.response, `${SPONSOR_PAGE}/${workerId}`);
  const worker = othersOnly(listed.data.items, me.tenantUserId).find((w) => w.id === workerId);
  if (!worker) notFound();
  const manage = sponsorManaged(me.permissions);

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={t("sponsor.title")}
        title={worker.member?.displayName ?? t("staff.unknownMember")}
        description={t("sponsor.route.name", { route: worker.route })}
      />
      <p className="m-0">
        <Link href={SPONSOR_PAGE} className="inline-flex min-h-target items-center underline">
          {t("sponsor.back")}
        </Link>
      </p>
      {worker.absenceToReport ? (
        <Card as="section" title={t("sponsor.absence.reportTitle")} headingLevel={2}>
          <p className="m-0 flex flex-wrap items-center gap-2">
            <StaffChip chip={reportChip("overdue", t)} />
            <span>
              {t("sponsor.absence.reportBody", {
                happened: formatDate(worker.absenceToReport.happenedOn) ?? "",
                due: formatDate(worker.absenceToReport.dueOn) ?? "",
              })}
            </span>
          </p>
        </Card>
      ) : null}
      <Card as="section" title={t("sponsor.record.summary")} headingLevel={2}>
        <dl className="m-0 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <dt className="font-semibold">{t("sponsor.form.visaExpiresOn")}</dt>
          <dd className="m-0 flex flex-wrap items-center gap-2">
            <span>{formatDate(worker.visaExpiresOn)}</span>
            <StaffChip chip={visaChip(worker.visa, t)} />
          </dd>
          <dt className="font-semibold">{t("sponsor.record.salary")}</dt>
          <dd className="m-0 flex flex-wrap items-center gap-2">
            <StaffChip chip={salaryChip(worker.salary.passes, t)} />
            <span>
              {t("sponsor.record.hourly", {
                pay: worker.salary.hourlyPay.toFixed(2),
                hours: worker.salary.countedWeeklyHours,
              })}
            </span>
          </dd>
          <dt className="font-semibold">{t("sponsor.form.cosReference")}</dt>
          <dd className="m-0">{worker.cosReference}</dd>
          <dt className="font-semibold">{t("sponsor.record.gaps")}</dt>
          <dd className="m-0">
            {worker.appendixDGaps.length === 0 ? (
              t("sponsor.record.noGaps")
            ) : (
              <ul className="m-0 pl-5">
                {worker.appendixDGaps.map((g) => (
                  <li key={g}>{t("sponsor.appendixD.name", { item: g })}</li>
                ))}
              </ul>
            )}
          </dd>
        </dl>
      </Card>
      <Card as="section" title={t("sponsor.reports.title")} headingLevel={2}>
        {worker.reports.length === 0 ? (
          <p className="m-0">{t("sponsor.reports.empty")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-4 p-0">
            {worker.reports.map((r) => (
              <li key={r.id} className="flex flex-col gap-2 border-b border-border pb-4">
                <h3 className="m-0 text-body font-semibold">
                  {t("sponsor.report.kindName", { kind: r.kind })}
                </h3>
                <p className="m-0 flex flex-wrap items-center gap-2">
                  <StaffChip chip={reportChip(r.state, t)} />
                  <span className="text-body-dense">
                    {r.reportedOn
                      ? t("sponsor.report.reportedLine", {
                          happened: formatDate(r.happenedOn) ?? "",
                          reported: formatDate(r.reportedOn) ?? "",
                          reference: r.smsReference ?? "",
                        })
                      : t("sponsor.report.dueLine", {
                          happened: formatDate(r.happenedOn) ?? "",
                          due: formatDate(r.dueOn) ?? "",
                        })}
                  </span>
                </p>
                {manage && !r.reportedOn ? (
                  <details>
                    <summary className="inline-flex min-h-target cursor-pointer items-center underline">
                      {t("sponsor.report.markOpen")}
                    </summary>
                    <div className="pt-3">
                      <MarkReportedForm workerId={worker.id} report={r} />
                    </div>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card as="section" title={t("sponsor.absences.title")} headingLevel={2}>
        {worker.absences.length === 0 ? (
          <p className="m-0">{t("sponsor.absences.empty")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {worker.absences.map((a) => (
              <li key={a.id}>
                {t("sponsor.absences.line", {
                  from: formatDate(a.fromOn) ?? "",
                  to: formatDate(a.toOn) ?? "",
                  authorised: a.authorised ? "yes" : "no",
                })}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {manage ? (
        <>
          <Card as="section" title={t("sponsor.report.newTitle")} headingLevel={2}>
            <ReportForm workerId={worker.id} suggested={worker.absenceToReport} />
          </Card>
          <Card as="section" title={t("sponsor.absence.newTitle")} headingLevel={2}>
            <AbsenceForm workerId={worker.id} />
          </Card>
          <Card as="section" title={t("sponsor.record.changeTitle")} headingLevel={2}>
            <SponsoredWorkerForm key={worker.version} worker={worker} />
          </Card>
        </>
      ) : null}
    </div>
  );
}
