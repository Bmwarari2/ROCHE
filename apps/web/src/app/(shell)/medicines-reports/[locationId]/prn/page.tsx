import { Info } from "lucide-react";
import type { Metadata } from "next";
import { Notice } from "@/components/care/Notice";
import { PeriodForm } from "@/components/medicines/errors/PeriodForm";
import { ReportFrame, ReportRefused } from "@/components/medicines/errors/ReportFrame";
import { ReportTable } from "@/components/medicines/errors/ReportTable";
import { reportLocation, reportProblem } from "@/components/medicines/errors/report-location";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, tenantApi } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { defaultPeriod, readPeriod, reportHref, usageRows } from "@/lib/medication-errors";

type Params = Promise<{ locationId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = {
  title: t("medicines.errors.reports.name", { report: "prn" }),
};

/**
 * PRN and psychotropic use (slice 55; medicines.md section 14.3; HZ-134): per person living at the
 * location, the doses taken in the period of when-required entries, of entries tagged psychotropic,
 * and of both, then by medicine. The API's note is shown with the counts every time: a count of
 * records for a clinician's review, never a judgement of the person or the prescribing.
 */
export default async function PrnReportPage({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { locationId } = await params;
  const title = t("medicines.errors.reports.name", { report: "prn" });
  const location = await reportLocation(locationId);
  if (!location) return <SafetyForbidden title={title} />;
  const href = reportHref(location.id, "prn");
  const chosen = readPeriod(await searchParams, t, defaultPeriod(28));
  const api = await tenantApi();
  const read = chosen.ok
    ? await api.GET("/v1/locations/{id}/medicines/prn-report", {
        params: { path: { id: location.id }, query: chosen.period },
      })
    : null;
  const problem = read ? reportProblem(read.error) : null;
  if (problem?.kind === "forbidden") return <SafetyForbidden title={title} />;
  if (read && !read.data && !problem) failWith(read.error, read.response, href);
  const report = read?.data;

  return (
    <ReportFrame
      locationId={location.id}
      locationName={location.name}
      title={title}
      description={t("medicines.errors.reports.about", { report: "prn" })}
      informationOnly={false}
    >
      <PeriodForm action={href} period={chosen.period} errors={chosen.ok ? null : chosen.errors} />
      {problem?.kind === "refused" ? <ReportRefused message={problem.message} /> : null}
      {report ? (
        <>
          <Notice
            icon={<Info size={20} strokeWidth={1.5} aria-hidden="true" />}
            title={t("medicines.errors.reports.countsOnly")}
          >
            {report.note}
          </Notice>
          <ReportTable
            caption={t("medicines.errors.reports.caption", {
              report: "prn",
              from: formatDate(report.from) ?? "",
              to: formatDate(report.to) ?? "",
            })}
            rowHeader={t("medicines.errors.prn.person")}
            headers={[
              t("medicines.errors.prn.column", { column: "prnGiven" }),
              t("medicines.errors.prn.column", { column: "psychotropicGiven" }),
              t("medicines.errors.prn.column", { column: "psychotropicPrnGiven" }),
            ]}
            rows={usageRows(report, t)}
            empty={t("medicines.errors.prn.empty")}
          />
        </>
      ) : null}
    </ReportFrame>
  );
}
