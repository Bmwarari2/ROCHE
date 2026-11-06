import { ButtonLink, Card, EmptyState, StatusChip } from "@harbour/ui";
import { ClipboardList, Pill, Plus, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { NoAccess } from "@/components/care/NoAccess";
import { Notice } from "@/components/care/Notice";
import { RecordFrame } from "@/components/care/RecordFrame";
import { StartReconciliationForm } from "@/components/medicines/ReconciliationForms";
import { getShellContext, tenantApi } from "@/lib/api";
import { can, tabHref } from "@/lib/care-record";
import { formatDate, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import {
  entryChip,
  entryHref,
  MEDICINES_WRITER,
  medicinesHref,
  medicinesShown,
  reconciliationHref,
} from "@/lib/medicines";
import { getPerson, readOrFail } from "@/lib/person-record";
import { recordMetadata } from "@/lib/record-metadata";

type Params = Promise<{ id: string }>;

export async function generateMetadata(): Promise<Metadata> {
  return recordMetadata("medicines");
}

/**
 * The medicines record (MEDS-001; medicines.md section 13 rule 1): every entry in force or
 * scheduled, one per medicine, with its product, route, the dose and schedule in the domain's own
 * words (never rewritten), its dates, and its state as an icon and a word. An entry not yet
 * checked always says so, with the API's notice. Reconciliations due are shown first.
 */
async function MedicinesTab({ params }: { readonly params: Params }) {
  const { id } = await params;
  const { person } = await getPerson(id);
  if (!person) return null;
  const { me } = await getShellContext();
  if (!medicinesShown(me.permissions)) return <NoAccess />;
  const api = await tenantApi();
  const data = readOrFail(
    await api.GET("/v1/people/{id}/medicines", { params: { path: { id } } }),
    tabHref(id, "medicines"),
  );
  if (!data) return <NoAccess />;
  const writer = can(me.permissions, MEDICINES_WRITER);
  const when = (iso: string | null) => formatDateTime(iso) ?? "";

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-eyebrow">{t("medicines.title")}</h2>
          <p className="m-0 max-w-prose text-text-secondary">{t("medicines.intro")}</p>
        </div>
        {writer ? (
          <ButtonLink
            href={`${medicinesHref(id)}/new`}
            icon={<Plus size={18} strokeWidth={1.5} aria-hidden="true" />}
          >
            {t("medicines.add")}
          </ButtonLink>
        ) : null}
      </div>
      {data.openReconciliationId ? (
        <Notice
          icon={<ClipboardList size={20} strokeWidth={1.5} aria-hidden="true" />}
          title={t("medicines.rec.openNotice")}
          action={
            <Link
              href={reconciliationHref(id, data.openReconciliationId)}
              className="inline-flex min-h-target items-center underline"
            >
              {t("medicines.rec.openLink")}
            </Link>
          }
        />
      ) : null}
      {data.outstandingReconciliations.length > 0 ? (
        <Card as="section" title={t("medicines.rec.dueTitle")} headingLevel={3}>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {data.outstandingReconciliations.map((o) => (
              <li key={o.eventId} className="flex flex-col gap-2">
                <p className="m-0 flex items-start gap-2">
                  <TriangleAlert
                    size={20}
                    strokeWidth={1.5}
                    aria-hidden="true"
                    className="shrink-0"
                  />
                  <span>
                    <span className="font-semibold">
                      {t("medicines.rec.due", { kind: o.kind, when: when(o.at) })}
                    </span>{" "}
                    {o.notice}
                  </span>
                </p>
                {writer && !data.openReconciliationId ? (
                  <StartReconciliationForm
                    personId={id}
                    trigger={o.kind}
                    eventId={o.eventId}
                    label={t("medicines.rec.start", { kind: o.kind })}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      <Card as="section" title={t("medicines.listTitle")} headingLevel={3}>
        {data.entries.length === 0 ? (
          <EmptyState
            headingLevel={4}
            icon={<Pill size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("medicines.empty")}
          />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-4 p-0">
            {data.entries.map((entry) => {
              const chip = entryChip(entry.state, t);
              return (
                <li key={entry.id} className="flex flex-col gap-2 border-b border-border pb-4">
                  <h4 className="m-0 text-body font-semibold">
                    <Link
                      href={entryHref(id, entry.id)}
                      className="inline-flex min-h-target items-center underline"
                    >
                      {entry.product.name}
                    </Link>
                  </h4>
                  <p className="m-0 flex flex-wrap items-center gap-2">
                    <StatusChip status={chip.status} label={chip.label} icon={chip.icon} />
                    <span className="text-body-dense">{entry.status.words}</span>
                  </p>
                  {entry.status.notice ? (
                    <p className="m-0 font-semibold">{entry.status.notice}</p>
                  ) : null}
                  <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-1 text-body-dense sm:grid-cols-[max-content_1fr]">
                    <dt className="font-semibold">{t("medicines.field.dose")}</dt>
                    <dd className="m-0">{entry.directionsInWords}</dd>
                    <dt className="font-semibold">{t("medicines.field.route")}</dt>
                    <dd className="m-0">{entry.route.name}</dd>
                    <dt className="font-semibold">{t("medicines.field.starts")}</dt>
                    <dd className="m-0">{when(entry.startsAt)}</dd>
                    {entry.stopsAt ? (
                      <>
                        <dt className="font-semibold">{t("medicines.field.stops")}</dt>
                        <dd className="m-0">{when(entry.stopsAt)}</dd>
                      </>
                    ) : null}
                    {entry.reviewOn ? (
                      <>
                        <dt className="font-semibold">{t("medicines.field.review")}</dt>
                        <dd className="m-0">{formatDate(entry.reviewOn)}</dd>
                      </>
                    ) : null}
                    {entry.specialInstructions ? (
                      <>
                        <dt className="font-semibold">{t("medicines.field.instructions")}</dt>
                        <dd className="m-0 whitespace-pre-wrap">{entry.specialInstructions}</dd>
                      </>
                    ) : null}
                  </dl>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      {writer && !data.openReconciliationId ? (
        <Card as="section" title={t("medicines.rec.changeTitle")} headingLevel={3}>
          <div className="flex flex-col gap-3">
            <p className="m-0 max-w-prose">{t("medicines.rec.changeAbout")}</p>
            <StartReconciliationForm
              personId={id}
              trigger="change"
              eventId={null}
              label={t("medicines.rec.start", { kind: "change" })}
            />
          </div>
        </Card>
      ) : null}
    </>
  );
}

export default async function MedicinesPage(props: { readonly params: Params }) {
  const { id } = await props.params;
  return (
    <RecordFrame personId={id} tab="medicines">
      <MedicinesTab {...props} />
    </RecordFrame>
  );
}
