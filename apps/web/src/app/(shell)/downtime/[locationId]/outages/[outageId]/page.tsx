import type { OutageItem } from "@harbour/contracts";
import { Card, PageHeader, StatusChip } from "@harbour/ui";
import { Clock, TriangleAlert, UserX } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrivalNotice } from "@/components/care/ArrivalNotice";
import { Notice } from "@/components/care/Notice";
import {
  CancelOutageForm,
  CloseOutageForm,
  CorrectOutageForm,
} from "@/components/operations/OutageForms";
import { ReconcileForm } from "@/components/operations/ReconcileForm";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { entryAuthor } from "@/lib/care-record";
import { isUuid } from "@/lib/context-cookies";
import {
  downtimeAccess,
  outageActions,
  outageStateChip,
  outageTitle,
  outageWindow,
  reviewItems,
} from "@/lib/downtime";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { firstParam } from "@/lib/record-metadata";

type Params = Promise<{ locationId: string; outageId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;
type Row = readonly [field: string, value: string | null, dateTime?: string | null];

export const metadata: Metadata = { title: t("operations.outage.pageTitle") };

const iconProps = { size: 20, strokeWidth: 1.5, "aria-hidden": true } as const;
const DONE = new Set(["declared", "closed", "cancelled", "corrected", "reconciled"]);

function Fields({ rows }: { readonly rows: readonly Row[] }) {
  const shown = rows.filter(([, value]) => Boolean(value));
  return (
    <dl className="m-0 grid grid-cols-1 gap-3 sm:grid-cols-2">
      {shown.map(([field, value, dateTime]) => (
        <div key={field} className="min-w-0">
          <dt className="text-body-dense font-semibold">
            {t("operations.outage.field", { field })}
          </dt>
          <dd className="m-0 whitespace-pre-line break-words">
            {dateTime ? <time dateTime={dateTime}>{value}</time> : value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * One outage (operations.md section 13, part 3c; HZ-017): where it stands, its window and its
 * history, and what the viewer may do next: close it, cancel it, correct its times, or review
 * and reconcile its paper records, each only in the state the API accepts and only for holders
 * of `operations.downtime.manage` who work at the location. The reconciliation lists entry
 * references and counts, never people.
 */
export default async function OutagePage({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { locationId, outageId } = await params;
  if (!isUuid(locationId) || !isUuid(outageId)) notFound();
  const { me } = await getShellContext();
  const access = downtimeAccess(me, locationId);
  if (!access) notFound();
  if (!access.outages) return <SafetyForbidden title={t("operations.outages.title")} />;
  const page = `/downtime/${locationId}/outages/${outageId}`;
  const done = firstParam((await searchParams).done);

  const api = await tenantApi();
  const listed = await api.GET("/v1/locations/{id}/outages", {
    params: { path: { id: locationId } },
  });
  if (!listed.data) failWith(listed.error, listed.response, page);
  const outage: OutageItem | undefined = listed.data.items.find((o) => o.id === outageId);
  if (!outage) notFound();
  const actions = outageActions(outage.state, access.manage);

  const reconciliation = actions.reconcile
    ? await api.GET("/v1/outages/{id}/reconciliation", { params: { path: { id: outageId } } })
    : null;
  if (reconciliation && !reconciliation.data) {
    if (problemCode(reconciliation.error) === "not_found") notFound();
    failWith(reconciliation.error, reconciliation.response, page);
  }
  const summary = reconciliation?.data ?? null;

  const title = outageTitle(outage, t);
  const when = (iso: string | null) => formatDateTime(iso);
  const who = (userId: string | null) =>
    userId ? t("operations.outage.who", { who: entryAuthor(userId, me.tenantUserId) }) : null;
  const ref = { locationId, outageId, version: outage.version };

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <nav aria-label={t("common.breadcrumb")} className="text-body-dense">
        <Link href={`/downtime/${locationId}`} className="underline">
          {t("operations.downtime.title")}
        </Link>
        <span aria-hidden="true" className="px-2 text-text-secondary">
          ›
        </span>
        <span>{title}</span>
      </nav>
      <PageHeader
        eyebrow={me.locations.find((l) => l.id === locationId)?.name ?? me.tenant.name}
        title={title}
      />
      {done && DONE.has(done) ? (
        <ArrivalNotice>{t("operations.outage.arrived", { done })}</ArrivalNotice>
      ) : null}
      <p className="m-0 flex flex-wrap items-center gap-2">
        <SafetyChip chip={outageStateChip(outage.state, t)} />
        {outage.declaredLate ? (
          <StatusChip status="due" label={t("operations.outage.declaredLate")} icon={Clock} />
        ) : null}
      </p>
      <Card as="section" title={t("operations.outage.detailsTitle")} headingLevel={2}>
        <Fields
          rows={[
            ["window", outageWindow(outage, t)],
            ["description", outage.description],
            ["declaredAt", when(outage.declaredAt), outage.declaredAt],
            ["declaredBy", who(outage.declaredBy)],
            ["closedAt", when(outage.closedAt), outage.closedAt],
            ["backEntryDueAt", when(outage.backEntryDueAt), outage.backEntryDueAt],
            ["correctionReason", outage.correctionReason],
            ["reconciledAt", when(outage.reconciledAt), outage.reconciledAt],
            ["reconciledBy", who(outage.reconciledBy)],
            ["reconciliationStatement", outage.reconciliationStatement],
            ["formsEntered", outage.formsEntered === null ? null : String(outage.formsEntered)],
            ["cancelledAt", when(outage.cancelledAt), outage.cancelledAt],
            ["cancelledBy", who(outage.cancelledBy)],
            ["cancellationReason", outage.cancellationReason],
          ]}
        />
      </Card>
      {actions.close || actions.cancel || actions.correct ? (
        <Card as="section" title={t("operations.outage.actionsTitle")} headingLevel={2}>
          <div className="flex flex-col gap-4">
            {actions.close ? <CloseOutageForm {...ref} /> : null}
            {actions.correct ? (
              <CorrectOutageForm {...ref} startedAt={outage.startedAt} endedAt={outage.endedAt} />
            ) : null}
            {actions.cancel ? <CancelOutageForm {...ref} /> : null}
          </div>
        </Card>
      ) : null}
      {summary ? (
        <Card as="section" title={t("operations.reconcile.title")} headingLevel={2}>
          <div className="flex flex-col gap-4">
            <p className="m-0">
              {t("operations.reconcile.counts", {
                backEntries: summary.backEntries,
                forms: summary.formsEntered,
                people: summary.people,
              })}
            </p>
            <ul className="m-0 flex flex-col gap-1 ps-5 text-body-dense">
              <li>
                {t("operations.reconcile.withoutReference", {
                  count: summary.entriesWithoutReference,
                })}
              </li>
              <li>{t("operations.reconcile.outsideWindow", { count: summary.outsideWindow })}</li>
              <li>
                {t("operations.reconcile.digital", { count: summary.digitalEntriesInWindow })}
              </li>
            </ul>
            {summary.enteredByYou ? (
              <Notice
                tone="warning"
                icon={<UserX {...iconProps} />}
                title={t("operations.reconcile.enteredByYou")}
              />
            ) : (
              <>
                {summary.blockers.length > 0 ? (
                  <Notice
                    tone="warning"
                    icon={<TriangleAlert {...iconProps} />}
                    title={t("operations.reconcile.blockers")}
                  >
                    <ul className="m-0 flex flex-col gap-1 ps-5">
                      {summary.blockers.map((words) => (
                        <li key={words}>{words}</li>
                      ))}
                    </ul>
                  </Notice>
                ) : null}
                <ReconcileForm {...ref} items={reviewItems(summary)} />
              </>
            )}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
