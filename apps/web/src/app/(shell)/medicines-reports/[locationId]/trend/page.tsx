import type { Metadata } from "next";
import { PeriodForm } from "@/components/medicines/errors/PeriodForm";
import { ReportFrame, ReportRefused } from "@/components/medicines/errors/ReportFrame";
import { ReportTable } from "@/components/medicines/errors/ReportTable";
import { reportLocation, reportProblem } from "@/components/medicines/errors/report-location";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, tenantApi } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { defaultTrendPeriod, readPeriod, reportHref, trendTables } from "@/lib/medication-errors";

type Params = Promise<{ locationId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = {
  title: t("medicines.errors.reports.name", { report: "trend" }),
};

/**
 * The medication error trend (slice 55; medicines.md section 14.3; HZ-134): per UK month in the
 * period, by when the incident happened, the errors, near misses and those not yet known, then by
 * kind and by stage, from the incidents the reader can see. Every month is a column, an empty one
 * shown as zero. Tables only, so nothing depends on colour; the NRLS source is named.
 */
export default async function ErrorTrendPage({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { locationId } = await params;
  const title = t("medicines.errors.reports.name", { report: "trend" });
  const location = await reportLocation(locationId);
  if (!location) return <SafetyForbidden title={title} />;
  const href = reportHref(location.id, "trend");
  const chosen = readPeriod(await searchParams, t, defaultTrendPeriod());
  const api = await tenantApi();
  const read = chosen.ok
    ? await api.GET("/v1/locations/{id}/medication-errors/trend", {
        params: { path: { id: location.id }, query: chosen.period },
      })
    : null;
  const problem = read ? reportProblem(read.error) : null;
  if (problem?.kind === "forbidden") return <SafetyForbidden title={title} />;
  if (read && !read.data && !problem) failWith(read.error, read.response, href);
  const report = read?.data;
  const tables = report ? trendTables(report, t) : null;
  const period = report
    ? { from: formatDate(report.from) ?? "", to: formatDate(report.to) ?? "" }
    : null;
  const headers = (months: readonly string[]) => [...months, t("medicines.errors.trend.total")];

  return (
    <ReportFrame
      locationId={location.id}
      locationName={location.name}
      title={title}
      description={t("medicines.errors.reports.about", { report: "trend" })}
    >
      <PeriodForm action={href} period={chosen.period} errors={chosen.ok ? null : chosen.errors} />
      {problem?.kind === "refused" ? <ReportRefused message={problem.message} /> : null}
      {report && tables && period ? (
        <>
          <ReportTable
            caption={t("medicines.errors.trend.caption", { table: "reached", ...period })}
            rowHeader={t("medicines.errors.trend.rowHeader", { table: "reached" })}
            headers={headers(tables.months)}
            rows={tables.reached}
            empty={t("medicines.errors.trend.empty")}
          />
          <ReportTable
            caption={t("medicines.errors.trend.caption", { table: "kinds", ...period })}
            rowHeader={t("medicines.errors.trend.rowHeader", { table: "kinds" })}
            headers={headers(tables.months)}
            rows={tables.kinds}
            empty={t("medicines.errors.trend.empty")}
          />
          <ReportTable
            caption={t("medicines.errors.trend.caption", { table: "stages", ...period })}
            rowHeader={t("medicines.errors.trend.rowHeader", { table: "stages" })}
            headers={headers(tables.months)}
            rows={tables.stages}
            empty={t("medicines.errors.trend.empty")}
          />
          <p className="m-0 text-body-dense text-text-secondary">
            {t("medicines.errors.source", { source: report.source })}
          </p>
        </>
      ) : null}
    </ReportFrame>
  );
}
