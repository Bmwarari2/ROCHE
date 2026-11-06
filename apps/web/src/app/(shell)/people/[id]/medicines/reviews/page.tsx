import { Card, StatusChip } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { ArrivalNotice } from "@/components/care/ArrivalNotice";
import { NoAccess } from "@/components/care/NoAccess";
import { RecordFrame } from "@/components/care/RecordFrame";
import { ReviewChangeForm, ScheduleReviewForm } from "@/components/medicines/errors/ReviewForms";
import { getShellContext, tenantApi } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import {
  personReviewsHref,
  reviewChip,
  reviewEntryChip,
  reviewsShown,
} from "@/lib/medication-errors";
import { medicinesHref } from "@/lib/medicines";
import { getPerson, readOrFail } from "@/lib/person-record";
import { firstParam, recordMetadata } from "@/lib/record-metadata";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata(): Promise<Metadata> {
  return recordMetadata("medicines", t("medicines.errors.review.title"));
}

const DONE = ["scheduled", "recorded", "corrected", "reschedule", "cancel"] as const;

/**
 * A person's medication reviews (slice 55; MEDS-013; medicines.md section 14.2; HZ-134): where they
 * stand (the tracker line: the status as an icon and the API's words, the last done and the next
 * due, and a booking later than the interval allows), every review newest first, and the forms
 * that schedule one, record one done (the clinician's name, role and the outcome in their words),
 * move or cancel a booked one with a reason, or correct one done with a reason. Harbour suggests
 * no change to any medicine. For `medicines.record.manage`; the API checks the person's scope.
 */
async function PersonReviews({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await params;
  const { person } = await getPerson(id);
  if (!person) return null;
  const { me } = await getShellContext();
  if (!reviewsShown(me.permissions)) return <NoAccess />;
  const api = await tenantApi();
  const read = await api.GET("/v1/people/{id}/medication-reviews", {
    params: { path: { id } },
  });
  const data = readOrFail(read, personReviewsHref(id));
  if (!data) return <NoAccess />;
  const done = firstParam((await searchParams).done);
  const tracker = reviewChip(data.tracker.status, data.tracker.statusWords);
  const date = (iso: string | null) => formatDate(iso) ?? t("medicines.errors.noneRecorded");

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-eyebrow">{t("medicines.errors.review.title")}</h2>
        <p className="m-0 max-w-prose text-text-secondary">{t("medicines.errors.review.intro")}</p>
      </div>
      {done && (DONE as readonly string[]).includes(done) ? (
        <ArrivalNotice>{t("medicines.errors.review.done", { done })}</ArrivalNotice>
      ) : null}
      <Card as="section" title={t("medicines.errors.review.where")} headingLevel={3}>
        <div className="flex flex-col gap-2">
          <p className="m-0">
            <StatusChip status={tracker.status} label={tracker.label} icon={tracker.icon} />
          </p>
          <dl className="m-0 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {(
              [
                ["nextDueOn", data.tracker.nextDueOn],
                ["lastDoneOn", data.tracker.lastDoneOn],
                ["bookedOn", data.tracker.bookedOn],
                ["intervalDueOn", data.tracker.intervalDueOn],
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
          {data.tracker.bookedAfterInterval ? (
            <p className="m-0 font-semibold">{t("medicines.errors.tracker.bookedLate")}</p>
          ) : null}
        </div>
      </Card>
      <Card as="section" title={t("medicines.errors.review.scheduleTitle")} headingLevel={3}>
        <ScheduleReviewForm personId={id} />
      </Card>
      <Card as="section" title={t("medicines.errors.review.list")} headingLevel={3}>
        {data.reviews.length === 0 ? (
          <p className="m-0">{t("medicines.errors.review.none")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-4 p-0">
            {data.reviews.map((review) => {
              const chip = reviewEntryChip(review, t);
              return (
                <li key={review.id} className="flex flex-col gap-2 border-b border-border pb-4">
                  <p className="m-0 flex flex-wrap items-center gap-2">
                    <StatusChip status={chip.status} label={chip.label} icon={chip.icon} />
                    <span>
                      {review.doneOn
                        ? t("medicines.errors.review.doneLine", {
                            on: date(review.doneOn),
                            due: date(review.dueOn),
                          })
                        : t("medicines.errors.review.dueLine", { on: date(review.dueOn) })}
                    </span>
                  </p>
                  {review.doneOn ? (
                    <dl className="m-0 grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <div>
                        <dt className="text-body-dense font-semibold">
                          {t("medicines.errors.review.clinicianName")}
                        </dt>
                        <dd className="m-0">
                          {review.clinicianRole
                            ? t("medicines.errors.review.clinicianLine", {
                                name: review.clinicianName ?? "",
                                role: review.clinicianRole,
                              })
                            : (review.clinicianName ?? t("medicines.errors.noneRecorded"))}
                        </dd>
                      </div>
                      <div className="sm:col-span-2">
                        <dt className="text-body-dense font-semibold">
                          {t("medicines.errors.review.outcome")}
                        </dt>
                        <dd className="m-0 whitespace-pre-line break-words">
                          {review.outcome ?? t("medicines.errors.noneRecorded")}
                        </dd>
                      </div>
                    </dl>
                  ) : null}
                  {review.correctionReason ? (
                    <dl className="m-0">
                      <dt className="text-body-dense font-semibold">
                        {t("medicines.errors.review.lastReason")}
                      </dt>
                      <dd className="m-0 whitespace-pre-line break-words">
                        {review.correctionReason}
                      </dd>
                    </dl>
                  ) : null}
                  <details className="flex flex-col gap-3">
                    <summary className="inline-flex min-h-target cursor-pointer items-center underline">
                      {t("medicines.errors.review.changeSummary", {
                        state: review.doneOn ? "done" : "booked",
                        on: date(review.doneOn ?? review.dueOn),
                      })}
                    </summary>
                    <div className="pt-3">
                      <ReviewChangeForm personId={id} review={review} />
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <p className="m-0">
        <Link href={medicinesHref(id)} className="inline-flex min-h-target items-center underline">
          {t("medicines.back")}
        </Link>
      </p>
    </>
  );
}

export default async function PersonReviewsPage(props: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await props.params;
  return (
    <RecordFrame personId={id} tab="medicines">
      <PersonReviews {...props} />
    </RecordFrame>
  );
}
