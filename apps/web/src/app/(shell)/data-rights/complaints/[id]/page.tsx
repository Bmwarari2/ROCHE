import { Card, StatusChip } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DataRightsFrame } from "@/components/data-rights/DataRightsFrame";
import { CloseComplaintForm, ComplaintDateForm } from "@/components/dp-complaints/ComplaintForms";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { COMPLAINTS_PAGE, dataRightsShown } from "@/lib/data-rights";
import {
  acknowledgementWords,
  complaintForms,
  complaintPath,
  updateWords,
} from "@/lib/dp-complaints";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { firstParam } from "@/lib/record-metadata";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = { title: t("dataRights.complaint.detail.title") };

const DONE = new Set(["recorded", "acknowledged", "contacted", "closed"]);

function Row({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-body-dense font-semibold">{label}</dt>
      <dd className="m-0 whitespace-pre-wrap break-words">{value}</dd>
    </div>
  );
}

/**
 * One data protection complaint (PLAT-022; platform.md rule 25): its clocks in words, what it is
 * about, and the forms that apply while it is open: the day it was acknowledged, a day the
 * complainant was told how it is going, and closing with the outcome and confirmation that the
 * outcome told them they can complain to the ICO. The API checks every rule again.
 */
export default async function ComplaintPage({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { me } = await getShellContext();
  const listTitle = t("dataRights.complaints.title");
  if (!dataRightsShown(me)) {
    return <SafetyForbidden title={listTitle} hint={t("dataRights.orgWideOnly")} />;
  }
  const path = complaintPath(id);
  const api = await tenantApi();
  const read = await api.GET("/v1/data-protection/complaints/{id}", { params: { path: { id } } });
  if (read.response.status === 404) notFound();
  if (!read.data) failWith(read.error, read.response, path);
  const complaint = read.data;
  const forms = complaintForms(complaint);
  const ack = acknowledgementWords(complaint, t);
  const update = updateWords(complaint, t);
  const done = firstParam((await searchParams).done);

  return (
    <DataRightsFrame
      tab="complaints"
      title={t("dataRights.complaint.detail.title")}
      eyebrow={me.tenant.name}
    >
      <nav aria-label={t("common.breadcrumb")} className="text-body-dense">
        <Link href={COMPLAINTS_PAGE} className="inline-flex min-h-target items-center underline">
          {listTitle}
        </Link>
      </nav>
      {done && DONE.has(done) ? (
        <RecordedArrival message={t("dataRights.complaint.done", { done })} param="done" />
      ) : null}

      <Card as="section" title={t("dataRights.complaint.detail.standing")} headingLevel={2}>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip
              status={complaint.status === "closed" ? "done" : "info"}
              label={t("dataRights.complaint.status", { status: complaint.status })}
            />
            <StatusChip status={ack.status} label={ack.label} />
            <StatusChip status={update.status} label={update.label} />
          </div>
          {complaint.clock.acknowledgement !== "not_applicable" ? (
            <p className="m-0 text-body-dense">
              {t("dataRights.complaint.ack.targetToo", {
                date: formatDate(complaint.clock.acknowledgeTargetOn) ?? "",
              })}
            </p>
          ) : null}
          <dl className="m-0 flex flex-col gap-3">
            <Row
              label={t("dataRights.complaint.record.received")}
              value={formatDate(complaint.receivedOn) ?? ""}
            />
            <Row
              label={t("dataRights.complaint.record.channel")}
              value={t("dataRights.complaint.channel", { channel: complaint.channel })}
            />
            <Row label={t("dataRights.complaint.record.name")} value={complaint.complainantName} />
            <Row
              label={t("dataRights.complaint.record.kind")}
              value={t("dataRights.complaint.kind", { kind: complaint.complainantKind })}
            />
            {complaint.complainantContact ? (
              <Row
                label={t("dataRights.complaint.record.contact")}
                value={complaint.complainantContact}
              />
            ) : null}
            <Row
              label={t("dataRights.complaint.record.about")}
              value={t("dataRights.complaint.about", { about: complaint.about })}
            />
            <Row label={t("dataRights.complaint.record.summary")} value={complaint.summary} />
            {complaint.lastContactOn ? (
              <Row
                label={t("dataRights.complaint.detail.lastContact")}
                value={formatDate(complaint.lastContactOn) ?? ""}
              />
            ) : null}
          </dl>
        </div>
      </Card>

      {forms.acknowledge ? (
        <Card
          as="section"
          title={t("dataRights.complaint.date.title", { which: "acknowledge" })}
          headingLevel={2}
        >
          <ComplaintDateForm
            key={complaint.version}
            id={complaint.id}
            version={complaint.version}
            which="acknowledge"
          />
        </Card>
      ) : null}

      {forms.contact ? (
        <Card
          as="section"
          title={t("dataRights.complaint.date.title", { which: "contact" })}
          headingLevel={2}
        >
          <ComplaintDateForm
            key={complaint.version}
            id={complaint.id}
            version={complaint.version}
            which="contact"
          />
        </Card>
      ) : null}

      {complaint.status === "closed" || forms.close ? (
        <Card as="section" title={t("dataRights.complaint.close.title")} headingLevel={2}>
          {complaint.status === "closed" ? (
            <dl className="m-0 flex flex-col gap-3">
              <Row
                label={t("dataRights.complaint.close.day")}
                value={formatDate(complaint.closedOn) ?? ""}
              />
              <Row
                label={t("dataRights.complaint.close.outcome")}
                value={complaint.outcome ?? ""}
              />
              <Row
                label={t("dataRights.complaint.close.icoRightLabel")}
                value={t("dataRights.complaint.close.icoRightAnswer", {
                  answer: complaint.icoRightStated ? "yes" : "no",
                })}
              />
            </dl>
          ) : (
            <CloseComplaintForm
              key={complaint.version}
              id={complaint.id}
              version={complaint.version}
            />
          )}
        </Card>
      ) : null}
    </DataRightsFrame>
  );
}
