import type { Metadata } from "next";
import { PeriodForm } from "@/components/medicines/errors/PeriodForm";
import { ReportFrame, ReportRefused } from "@/components/medicines/errors/ReportFrame";
import { ReportTable } from "@/components/medicines/errors/ReportTable";
import { reportLocation, reportProblem } from "@/components/medicines/errors/report-location";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, tenantApi } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { defaultPeriod, overrideRows, readPeriod, reportHref } from "@/lib/medication-errors";

type Params = Promise<{ locationId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = {
  title: t("medicines.errors.reports.name", { report: "overrides" }),
};

/**
 * Competence overrides and doses recorded after they were given (slice 55; medicines.md section
 * 14.3; HZ-119, HZ-134): per member, for the period chosen (UK dates, inclusive), from the latest
 * version of each dose record. A count for the manager to read, never a judgement of the member.
 */
export default async function OverrideReportPage({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { locationId } = await params;
  const title = t("medicines.errors.reports.name", { report: "overrides" });
  const location = await reportLocation(locationId);
  if (!location) return <SafetyForbidden title={title} />;
  const href = reportHref(location.id, "overrides");
  const chosen = readPeriod(await searchParams, t, defaultPeriod(28));
  const api = await tenantApi();
  const read = chosen.ok
    ? await api.GET("/v1/locations/{id}/medicines/override-report", {
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
      description={t("medicines.errors.reports.about", { report: "overrides" })}
    >
      <PeriodForm action={href} period={chosen.period} errors={chosen.ok ? null : chosen.errors} />
      {problem?.kind === "refused" ? <ReportRefused message={problem.message} /> : null}
      {report ? (
        <ReportTable
          caption={t("medicines.errors.reports.caption", {
            report: "overrides",
            from: formatDate(report.from) ?? "",
            to: formatDate(report.to) ?? "",
          })}
          rowHeader={t("medicines.errors.overrides.member")}
          headers={[
            t("medicines.errors.overrides.column", { column: "competenceOverride" }),
            t("medicines.errors.overrides.column", { column: "competenceNotCurrent" }),
            t("medicines.errors.overrides.column", { column: "givenBeforeRecorded" }),
          ]}
          rows={overrideRows(report, t)}
          empty={t("medicines.errors.overrides.empty")}
        />
      ) : null}
    </ReportFrame>
  );
}
