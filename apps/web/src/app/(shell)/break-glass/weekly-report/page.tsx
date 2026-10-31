import { Card, EmptyState, PageHeader } from "@harbour/ui";
import { FileSearch, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { CountTable } from "@/components/platform/CountTable";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import {
  breakGlassReportShown,
  flagChip,
  flagCount,
  flaggedSearchers,
  flagsText,
  isoWeek,
  listHref,
  readSummary,
  reportEntries,
  reportHref,
  reportWeek,
  reviewChip,
  type SearchSection,
  searchFlagSentence,
  staffNamer,
  unreadableChip,
  weekParam,
} from "@/lib/break-glass-report";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = { title: t("breakGlassReport.title") };

/**
 * The organisation's searches that showed no one at any location (a tenant-level section the API
 * gives only to readers reaching the whole organisation): who searched, why, and who is flagged.
 */
function UnplacedSearches({
  section,
  threshold,
  staff,
}: {
  readonly section: SearchSection;
  readonly threshold: number;
  readonly staff: (id: string | null) => string;
}) {
  const flagged = flaggedSearchers(section);
  return (
    <Card as="section" headingLevel={2} title={t("breakGlassReport.unplaced.title")}>
      <div className="flex flex-col gap-4">
        <p className="m-0 max-w-prose">{t("breakGlassReport.unplaced.about")}</p>
        {section.total === 0 && section.byUser.length === 0 ? (
          <p className="m-0">{t("breakGlassReport.unplaced.none")}</p>
        ) : (
          <>
            {flagged.length > 0 ? (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {flagged.map((line) => (
                  <li key={line.tenantUserId} className="flex items-start gap-2">
                    <TriangleAlert
                      size={18}
                      strokeWidth={1.5}
                      aria-hidden="true"
                      className="mt-0.5 shrink-0"
                    />
                    <span>{searchFlagSentence(line, threshold, staff, t)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <CountTable
              caption={t("breakGlassReport.searches.byUser")}
              columns={[
                { id: "who", header: t("breakGlassReport.column.staff") },
                { id: "searches", header: t("breakGlassReport.column.searches"), numeric: true },
                { id: "flags", header: t("breakGlassReport.column.flags") },
              ]}
              rows={section.byUser.map((line) => ({
                id: line.tenantUserId,
                cells: {
                  who: staff(line.tenantUserId),
                  searches: line.searches,
                  flags: flagsText(line.flags, t),
                },
              }))}
            />
            <CountTable
              caption={t("breakGlassReport.searches.byReason")}
              columns={[
                { id: "reason", header: t("breakGlassReport.column.reason") },
                { id: "count", header: t("breakGlassReport.column.searches"), numeric: true },
              ]}
              rows={section.byReason.map((line) => ({
                id: line.reason,
                cells: {
                  reason: t("breakGlassReport.reason", { reason: line.reason }),
                  count: line.events,
                },
              }))}
            />
          </>
        )}
      </div>
    </Card>
  );
}

/**
 * The weekly break-glass report (PLAT-006; people.md rule 14; hazard HZ-011): for one UK week
 * (Monday to Sunday, the last complete week by default), each location's report in the reader's
 * access, with how much break-glass was used, whether anything is flagged, whether it could be
 * read and whether it has been reviewed, each as an icon and words; for a reader whose access
 * reaches the whole organisation, also the searches that showed no one at any location. For
 * holders of `platform.audit.read`, as the API allows; everyone else is told they cannot open it.
 * The alert to the Registered Manager and the data protection lead links here.
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
  const all = reportEntries(data.items);
  // The location switcher narrows the list to its location, as on the other manager pages.
  const entries = all.filter((e) => !location || e.report.locationId === location.id);
  const range = t("breakGlassReport.week", {
    monday: formatDate(shown.monday) ?? shown.monday,
    sunday: formatDate(shown.sunday) ?? shown.sunday,
  });
  // The organisation's searches that showed no one at any location: the same in each report of
  // the week, and given only to a reader whose access reaches the whole organisation.
  const withUnplaced = all
    .map((e) => ({ report: e.report, summary: readSummary(e.report.summary) }))
    .find((e) => e.summary.unplacedSearches !== null);

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
      <Card
        as="section"
        headingLevel={2}
        title={<time dateTime={isoWeek(shown.monday)}>{range}</time>}
      >
        {entries.length === 0 ? (
          <EmptyState
            headingLevel={3}
            icon={<FileSearch size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("breakGlassReport.empty.title")}
            description={
              location && all.length > 0
                ? t("breakGlassReport.empty.filtered", { location: location.name })
                : t("breakGlassReport.empty.body")
            }
          />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {entries.map(({ report, review }) => {
              const summary = readSummary(report.summary);
              const flags = flagChip(flagCount(summary), t);
              const unreadable = unreadableChip(summary.unreadable, t);
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
                    {unreadable ? <SafetyChip chip={unreadable} /> : null}
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
      {withUnplaced?.summary.unplacedSearches ? (
        <UnplacedSearches
          section={withUnplaced.summary.unplacedSearches}
          threshold={withUnplaced.report.repeatThreshold}
          staff={staffNamer(withUnplaced.report.staff, t)}
        />
      ) : null}
      <p className="m-0 text-body-dense text-text-secondary">{t("breakGlassReport.about")}</p>
    </div>
  );
}
