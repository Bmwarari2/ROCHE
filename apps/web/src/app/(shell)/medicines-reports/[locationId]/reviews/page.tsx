import { EmptyState, StatusChip } from "@harbour/ui";
import { CalendarCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ReportFrame } from "@/components/medicines/errors/ReportFrame";
import { reportLocation, reportProblem } from "@/components/medicines/errors/report-location";
import { PersonNeeds, type PersonNeedsOf } from "@/components/safety/PersonNeeds";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, tenantApi } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { personReviewsHref, reportHref, reviewChip } from "@/lib/medication-errors";

type Params = Promise<{ locationId: string }>;

export const metadata: Metadata = {
  title: t("medicines.errors.reports.name", { report: "reviews" }),
};

/**
 * The medication review tracker for a location (slice 55; MEDS-013; medicines.md section 14.2;
 * HZ-134): each person living there with a medicines entry, overdue first as the API orders them,
 * with the status as an icon and the API's words, the last review done, the booked date, the date
 * due by the interval and the next due; a booking later than the interval allows is said in words.
 * Each person links to their reviews, where one is scheduled, recorded, moved or cancelled.
 */
export default async function ReviewTrackerPage({ params }: { readonly params: Params }) {
  const { locationId } = await params;
  const title = t("medicines.errors.reports.name", { report: "reviews" });
  const location = await reportLocation(locationId);
  if (!location) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const [read, people] = await Promise.all([
    api.GET("/v1/locations/{id}/medication-reviews", { params: { path: { id: location.id } } }),
    api.GET("/v1/people", { params: { query: { locationId: location.id } } }),
  ]);
  const summaries = new Map((people.data?.items ?? []).map((p) => [p.id, p]));
  if (reportProblem(read.error)?.kind === "forbidden") return <SafetyForbidden title={title} />;
  if (!read.data) failWith(read.error, read.response, reportHref(location.id, "reviews"));
  const items = read.data.items;
  const date = (iso: string | null) => formatDate(iso) ?? t("medicines.errors.noneRecorded");

  return (
    <ReportFrame
      locationId={location.id}
      locationName={location.name}
      title={title}
      description={t("medicines.errors.tracker.description")}
      informationOnly={false}
    >
      <p className="m-0">
        {t("medicines.errors.tracker.summary", {
          overdue: items.filter((l) => l.status === "overdue").length,
          dueSoon: items.filter((l) => l.status === "due_soon").length,
        })}
      </p>
      {items.length === 0 ? (
        <EmptyState
          headingLevel={2}
          icon={<CalendarCheck size={32} strokeWidth={1.5} aria-hidden="true" />}
          title={t("medicines.errors.tracker.empty")}
        />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {items.map((line) => {
            const chip = reviewChip(line.status, line.statusWords);
            return (
              <li
                key={line.personId}
                className="flex flex-col gap-2 rounded-input border border-border p-4"
              >
                <h2 className="m-0 text-body font-semibold">
                  <Link
                    href={personReviewsHref(line.personId)}
                    className="inline-flex min-h-target items-center underline"
                  >
                    {t("medicines.errors.tracker.open", { name: line.name })}
                  </Link>
                </h2>
                {summaries.get(line.personId) ? (
                  <PersonNeeds person={summaries.get(line.personId) as PersonNeedsOf} />
                ) : null}
                <p className="m-0">
                  <StatusChip status={chip.status} label={chip.label} icon={chip.icon} />
                </p>
                <dl className="m-0 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {(
                    [
                      ["nextDueOn", line.nextDueOn],
                      ["lastDoneOn", line.lastDoneOn],
                      ["bookedOn", line.bookedOn],
                      ["intervalDueOn", line.intervalDueOn],
                    ] as const
                  ).map(([field, value]) => (
                    <div key={field}>
                      <dt className="text-body-dense font-semibold">
                        {t("medicines.errors.tracker.field", { field })}
                      </dt>
                      <dd className="m-0">
                        {value ? <time dateTime={value}>{date(value)}</time> : date(value)}
                      </dd>
                    </div>
                  ))}
                </dl>
                {line.nextFrom ? (
                  <p className="m-0 text-body-dense">
                    {t("medicines.errors.tracker.nextFrom", { from: line.nextFrom })}
                  </p>
                ) : null}
                {line.bookedAfterInterval ? (
                  <p className="m-0 font-semibold">{t("medicines.errors.tracker.bookedLate")}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </ReportFrame>
  );
}
