import type { ReviewSchedule } from "@harbour/contracts";
import { Card, StatusChip } from "@harbour/ui";
import { History } from "lucide-react";
import type { Metadata } from "next";
import { NoAccess } from "@/components/care/NoAccess";
import { ReadOnlyNotice } from "@/components/care/ReadOnlyNotice";
import { RecordFrame } from "@/components/care/RecordFrame";
import { ReviewChip } from "@/components/people/ReviewChip";
import { CarePlanChangeForm, ReviewForm } from "@/components/people/ReviewForms";
import { getShellContext, tenantApi } from "@/lib/api";
import { can, tabHref, writeAccess } from "@/lib/care-record";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { getPerson, readOrFail } from "@/lib/person-record";
import { recordMetadata } from "@/lib/record-metadata";
import { orderReviews } from "@/lib/reviews";
import { ukToday } from "@/lib/uk-time";

type Params = Promise<{ id: string }>;

/** The page title names the tab, never the person. */
export async function generateMetadata(): Promise<Metadata> {
  return recordMetadata("reviews");
}

function DueList({ items }: { readonly items: ReviewSchedule["items"] }) {
  if (items.length === 0) return <p className="m-0">{t("people.reviews.none")}</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-3 p-0">
      {orderReviews(items).map((item) => (
        <li
          key={`${item.kind}-${item.dueOn}`}
          className="flex flex-col gap-1"
          data-review-kind={item.kind}
        >
          <p className="m-0 flex flex-wrap items-center gap-2">
            <span className="font-semibold">{t("people.reviews.kind", { kind: item.kind })}</span>
            <ReviewChip state={item.state} />
          </p>
          <p className="m-0 flex flex-wrap gap-x-4 text-body-dense">
            <span>{t("people.reviews.dueOn", { date: formatDate(item.dueOn) ?? "" })}</span>
            {item.windowOpensOn ? (
              <span>
                {t("people.reviews.windowOpens", { date: formatDate(item.windowOpensOn) ?? "" })}
              </span>
            ) : null}
            {item.changeIds.length > 0 ? (
              <span>{t("people.reviews.covers", { count: item.changeIds.length })}</span>
            ) : null}
          </p>
          {item.basis.length > 0 ? (
            <p className="m-0 text-body-dense text-text-secondary">
              {t("people.reviews.basis", { keys: item.basis.join(", ") })}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function Records({ records }: { readonly records: ReviewSchedule["records"] }) {
  if (records.length === 0) return <p className="m-0">{t("people.reviews.recordsNone")}</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-4 p-0">
      {records.map((record) => (
        <li key={record.id} className="flex flex-col gap-1" data-review-record={record.kind}>
          <p className="m-0 flex flex-wrap items-center gap-2">
            {/* A corrected record stays readable, struck through and marked in words (§5.5). */}
            <span className={record.superseded ? "font-semibold line-through" : "font-semibold"}>
              {t("people.reviews.recordKind", { kind: record.kind })}
            </span>
            {record.superseded ? (
              <StatusChip
                status="notApplicable"
                label={t("people.reviews.corrected")}
                icon={History}
              />
            ) : null}
          </p>
          <p className="m-0 text-body-dense">
            {t("people.reviews.heldOn", { date: formatDate(record.heldOn) ?? "" })}
          </p>
          {record.familyInvolvementKind ? (
            <p className="m-0">
              {t("people.reviews.familyKind", { kind: record.familyInvolvementKind })}
            </p>
          ) : null}
          {record.laReference ? (
            <p className="m-0">
              {t("people.reviews.laReference", { reference: record.laReference })}
            </p>
          ) : null}
          {record.participants.length > 0 ? (
            <p className="m-0">
              {t("people.reviews.participants", {
                roles: record.participants.map((p) => p.role).join(", "),
              })}
            </p>
          ) : null}
          {record.changesCovered.length > 0 ? (
            <p className="m-0 text-body-dense">
              {t("people.reviews.changesCovered", { count: record.changesCovered.length })}
            </p>
          ) : null}
          {record.outcome ? <p className="m-0 whitespace-pre-line">{record.outcome}</p> : null}
          {record.correctionReason ? (
            <p className="m-0 text-body-dense">
              {t("people.reviews.correctionReason", { reason: record.correctionReason })}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * The reviews tab (people.md rule 8 and section 6a; PEOP-008; HZ-008): when each review is due,
 * as the API schedules it from the rate table, the changes waiting for review, the reviews held,
 * and for those who may, recording a review or a change in need.
 */
async function ReviewsTab({ params }: { readonly params: Params }) {
  const { id } = await params;
  const { person } = await getPerson(id);
  if (!person) return null;
  const { me } = await getShellContext();
  if (!can(me.permissions, "care.plan.read")) return <NoAccess />;
  const api = await tenantApi();
  const schedule = readOrFail(
    await api.GET("/v1/people/{id}/reviews", { params: { path: { id } } }),
    tabHref(id, "reviews"),
  );
  if (!schedule) return <NoAccess />;
  const { canWrite, readOnlyNotice } = writeAccess(person, me.permissions, "care.plan.write");
  const waiting = schedule.changes.filter((change) => change.reviewedOn === null);
  const today = ukToday();

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-eyebrow">{t("people.reviews.title")}</h2>
        <p className="m-0 max-w-prose text-text-secondary">{t("people.reviews.intro")}</p>
      </div>
      <Card as="section" title={t("people.reviews.dueTitle")} headingLevel={3}>
        <div className="flex flex-col gap-3">
          {schedule.available ? (
            <DueList items={schedule.items} />
          ) : (
            <p className="m-0">{t("people.reviews.unavailable")}</p>
          )}
          <p className="m-0 text-body-dense">
            {t("people.reviews.family", { status: schedule.familyInvolvement })}
          </p>
        </div>
      </Card>
      <Card as="section" title={t("people.reviews.changesTitle")} headingLevel={3}>
        <div className="flex flex-col gap-4">
          {waiting.length === 0 ? (
            <p className="m-0">{t("people.reviews.changesNone")}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {waiting.map((change) => (
                <li key={change.id} className="flex flex-wrap gap-x-2" data-care-plan-change="">
                  <span className="font-semibold">
                    {t("people.reviews.changeKind", { kind: change.kind })}
                  </span>
                  <span>
                    {t("people.reviews.changeOn", { date: formatDate(change.occurredOn) ?? "" })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
      {canWrite ? (
        <>
          <Card as="section" title={t("people.reviews.form.title")} headingLevel={3}>
            <ReviewForm personId={id} today={today} />
          </Card>
          <Card as="section" title={t("people.reviews.change.title")} headingLevel={3}>
            <CarePlanChangeForm personId={id} today={today} />
          </Card>
        </>
      ) : readOnlyNotice ? (
        <ReadOnlyNotice text={t(readOnlyNotice)} />
      ) : null}
      <Card as="section" title={t("people.reviews.recordsTitle")} headingLevel={3}>
        <Records records={schedule.records} />
      </Card>
    </>
  );
}

/** The tab inside the record's frame: the point-of-care header, read again on every tab. */
export default async function ReviewsPage(props: { readonly params: Params }) {
  const { id } = await props.params;
  return (
    <RecordFrame personId={id} tab="reviews">
      <ReviewsTab {...props} />
    </RecordFrame>
  );
}
