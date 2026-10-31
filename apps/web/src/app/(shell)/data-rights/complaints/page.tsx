import { Card, EmptyState, StatusChip } from "@harbour/ui";
import { MessageSquareWarning } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { DataRightsFrame } from "@/components/data-rights/DataRightsFrame";
import { RecordComplaintForm } from "@/components/dp-complaints/ComplaintForms";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { COMPLAINTS_PAGE, dataRightsShown } from "@/lib/data-rights";
import { acknowledgementWords, complaintPath, updateWords } from "@/lib/dp-complaints";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: t("dataRights.complaints.title") };

/**
 * Data protection complaints (PLAT-022; platform.md rule 25; data-protection-complaints.md):
 * open first, each with its acknowledgement clock and the next update due in words, the clocks
 * worked out by the API from the rate table. A form records a new one. Only someone handling data
 * protection for the whole organisation sees it.
 */
export default async function ComplaintsPage() {
  const { me } = await getShellContext();
  const title = t("dataRights.complaints.title");
  if (!dataRightsShown(me)) {
    return <SafetyForbidden title={title} hint={t("dataRights.orgWideOnly")} />;
  }
  const api = await tenantApi();
  const listed = await api.GET("/v1/data-protection/complaints");
  if (!listed.data) failWith(listed.error, listed.response, COMPLAINTS_PAGE);
  const { items, truncated } = listed.data;

  return (
    <DataRightsFrame
      tab="complaints"
      title={title}
      eyebrow={me.tenant.name}
      description={t("dataRights.complaint.description")}
    >
      <Card as="section" title={t("dataRights.complaint.list.title")} headingLevel={2}>
        {items.length === 0 ? (
          <EmptyState
            icon={<MessageSquareWarning size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("dataRights.complaint.list.empty")}
          />
        ) : (
          <div className="flex flex-col gap-4">
            {truncated ? (
              <p className="m-0" role="note">
                {t("dataRights.complaint.list.truncated", { count: items.length })}
              </p>
            ) : null}
            <ul className="m-0 flex list-none flex-col divide-y divide-border p-0">
              {items.map((complaint) => {
                const ack = acknowledgementWords(complaint, t);
                const update = updateWords(complaint, t);
                return (
                  <li key={complaint.id} className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0">
                    <Link
                      href={complaintPath(complaint.id)}
                      className="inline-flex min-h-target items-center font-semibold underline"
                    >
                      {t("dataRights.complaint.list.item", {
                        name: complaint.complainantName,
                        about: t("dataRights.complaint.about", { about: complaint.about }),
                      })}
                    </Link>
                    <p className="m-0 text-body-dense">
                      {t("dataRights.complaint.list.received", {
                        date: formatDate(complaint.receivedOn) ?? "",
                        channel: t("dataRights.complaint.channel", { channel: complaint.channel }),
                      })}
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusChip status={ack.status} label={ack.label} />
                      <StatusChip status={update.status} label={update.label} />
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </Card>
      <Card as="section" title={t("dataRights.complaint.record.title")} headingLevel={2}>
        <div className="flex flex-col gap-4">
          <p className="m-0">{t("dataRights.complaint.record.intro")}</p>
          <RecordComplaintForm />
        </div>
      </Card>
    </DataRightsFrame>
  );
}
