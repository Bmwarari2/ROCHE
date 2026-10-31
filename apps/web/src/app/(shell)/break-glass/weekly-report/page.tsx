import { Card, EmptyState, PageHeader } from "@harbour/ui";
import { FileSearch } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import {
  breakGlassReportShown,
  flagChip,
  flagCount,
  listHref,
  readSummary,
  reportEntries,
  reportHref,
  reportWeek,
  reviewChip,
  weekParam,
} from "@/lib/break-glass-report";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = { title: t("breakGlassReport.title") };

/**
 * The weekly break-glass report (PLAT-006; people.md rule 14; hazard HZ-011): for one UK week
 * (Monday to Sunday, the last complete week by default), each location's report in the reader's
 * access, with how much break-glass was used, whether anything is flagged and whether it has been
 * reviewed, each as an icon and words. For holders of `platform.audit.read`, as the API allows;
 * everyone else is told they cannot open it. The alert to the Registered Manager and the data
 * protection lead links here.
 */
export default async function BreakGlassReportsPage({
  searchParams,
}: {
  readonly searchParams: SearchParams;
}) {
  const { me, locationId } = await getShellContext();
  const title = t("breakGlassReport.title");
  if (!breakGlassReportShown(me.permissions)) return <SafetyForbidden title={title} />;
  const week = weekParam((await searchParams).week);
  const api = await tenantApi();
  const { data, error, response } = await api.GET("/v1/break-glass/weekly-report", {
    params: { query: week ? { week } : {} },
  });
  if (!data) {
    if (problemCode(error) === "missing_permission") return <SafetyForbidden title={title} />;
    return failWith(error, response, listHref(week));
  }
  const shown = reportWeek(data);
  const locationNames = new Map(me.locations.map((l) => [l.id, l.name]));
  const location = me.locations.find((l) => l.id === locationId);
  // The location switcher narrows the list to its location, as on the other manager pages.
  const entries = reportEntries(data.items).filter(
    (e) => !location || e.report.locationId === location.id,
  );
  const range = t("breakGlassReport.week", {
    monday: formatDate(shown.monday) ?? shown.monday,
    sunday: formatDate(shown.sunday) ?? shown.sunday,
  });

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={location ? location.name : me.tenant.name}
        title={title}
        description={t("breakGlassReport.description")}
      />
      <nav aria-label={t("breakGlassReport.weeks")} className="flex flex-wrap items-center gap-4">
        <Link
          href={listHref(shown.previous)}
          className="inline-flex min-h-target items-center underline"
        >
          {t("breakGlassReport.previousWeek")}
        </Link>
        {shown.next ? (
          <Link
            href={listHref(shown.next)}
            className="inline-flex min-h-target items-center underline"
          >
            {t("breakGlassReport.nextWeek")}
          </Link>
        ) : null}
      </nav>
      <Card as="section" headingLevel={2} title={range}>
        {entries.length === 0 ? (
          <EmptyState
            headingLevel={3}
            icon={<FileSearch size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("breakGlassReport.empty.title")}
            description={t("breakGlassReport.empty.body")}
          />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {entries.map(({ report, review }) => {
              const summary = readSummary(report.summary);
              const flags = flagChip(flagCount(summary), t);
              const name =
                locationNames.get(report.locationId) ?? t("breakGlassReport.locationHidden");
              const describedBy = `about-${report.id}`;
              return (
                <li
                  key={report.id}
                  className="flex flex-col gap-1 border-b border-border pb-3 break-words"
                >
                  <h3 className="m-0 text-body font-semibold">
                    <Link
                      href={reportHref(report.id, shown.monday)}
                      aria-describedby={describedBy}
                      className="inline-flex min-h-target items-center underline"
                    >
                      {name}
                    </Link>
                  </h3>
                  <span className="flex flex-wrap items-center gap-2">
                    <SafetyChip chip={reviewChip({ report, review }, t)} />
                    {flags ? <SafetyChip chip={flags} /> : null}
                  </span>
                  <span id={describedBy}>
                    {t("breakGlassReport.totals", {
                      opened: summary.totalEvents,
                      staff: summary.distinctUsers,
                      people: summary.distinctPeople,
                      searches: summary.searches.total,
                    })}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <p className="m-0 text-body-dense text-text-secondary">{t("breakGlassReport.about")}</p>
    </div>
  );
}
