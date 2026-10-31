import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { StaffChip } from "@/components/staff/StaffChip";
import { StaffDisclosure } from "@/components/staff/StaffDisclosure";
import { ComplianceItemForm, StaffFileForm } from "@/components/staff/StaffForms";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { firstParam } from "@/lib/record-metadata";
import {
  complianceChip,
  consentChip,
  fileChip,
  RECORDABLE_KINDS,
  STAFF_PAGE,
  STAFF_READ,
  staffDone,
  staffFilesManaged,
  staffFilesShown,
} from "@/lib/staff";

type Params = Promise<{ fileId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = { title: t("staff.file.title") };

/**
 * One staff file (WORK-002, WORK-011): the profile, every Schedule 3 item with where it stands as
 * an icon and a word and why, and the member's privacy notice acknowledgement and image consent.
 * Holders of workforce.staff_file.manage change the profile and record items, never on their own
 * file (the forms are not offered there, and the API refuses it). HR-only documents stay on their
 * own route.
 */
export default async function StaffFilePage({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { fileId } = await params;
  const done = firstParam((await searchParams).done);
  if (!isUuid(fileId)) notFound();
  const { me } = await getShellContext();
  if (!staffFilesShown(me.permissions)) return <SafetyForbidden title={t("staff.title")} />;
  const api = await tenantApi();
  const got = await api.GET("/v1/workforce/staff-files/{id}", {
    params: { path: { id: fileId } },
  });
  if (got.response.status === 404) notFound();
  if (!got.data) failWith(got.error, got.response, `${STAFF_PAGE}/${fileId}`);
  const file = got.data;
  const own = file.member?.id === me.tenantUserId;
  const manage = staffFilesManaged(me.permissions) && !own;
  const privacy =
    file.member && me.permissions.includes(STAFF_READ)
      ? await api.GET("/v1/workforce/members/{id}/staff-privacy", {
          params: { path: { id: file.member.id } },
        })
      : null;

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={t("staff.title")}
        title={file.member?.displayName ?? t("staff.unknownMember")}
        description={file.jobTitle}
      />
      {done && staffDone(done, t) ? (
        <RecordedArrival message={staffDone(done, t) ?? ""} param="done" />
      ) : null}
      <p className="m-0">
        <Link href={STAFF_PAGE} className="inline-flex min-h-target items-center underline">
          {t("staff.back")}
        </Link>
      </p>
      <p className="m-0 flex flex-wrap items-center gap-2">
        <StaffChip chip={fileChip(file.complete, t)} />
        <span className="text-body-dense">
          {t("staff.file.asOf", { date: formatDate(file.asOf) ?? "" })}
        </span>
      </p>
      {own ? <p className="m-0">{t("staff.file.ownNotice")}</p> : null}
      <Card as="section" title={t("staff.items.title")} headingLevel={2}>
        <ul className="m-0 flex list-none flex-col gap-4 p-0">
          {file.items.map((item) => (
            <li key={item.kind} className="flex flex-col gap-2 border-b border-border pb-4">
              <h3 className="m-0 text-body font-semibold">
                {t("staff.item.kind", { kind: item.kind })}
              </h3>
              <p className="m-0 flex flex-wrap items-center gap-2">
                <StaffChip chip={complianceChip(item.status, t)} />
                {item.verifiedOn ? (
                  <span className="text-body-dense">
                    {item.verifiedBy
                      ? t("staff.item.verified", {
                          date: formatDate(item.verifiedOn) ?? "",
                          name: item.verifiedBy.displayName,
                        })
                      : t("staff.item.verifiedOn", { date: formatDate(item.verifiedOn) ?? "" })}
                  </span>
                ) : null}
                {item.expiresOn ? (
                  <span className="text-body-dense">
                    {t("staff.item.expires", { date: formatDate(item.expiresOn) ?? "" })}
                  </span>
                ) : null}
              </p>
              {item.notes.length > 0 ? (
                <ul className="m-0 flex flex-col gap-1 pl-5">
                  {item.notes.map((note) => (
                    <li key={note.code} className="text-body-dense">
                      {t("staff.note", { code: note.code })}
                    </li>
                  ))}
                </ul>
              ) : null}
              {manage && item.required && RECORDABLE_KINDS.includes(item.kind) ? (
                <StaffDisclosure label={t("staff.item.recordOpen", { kind: item.kind })}>
                  <ComplianceItemForm fileId={file.id} item={item} />
                </StaffDisclosure>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>
      {privacy?.data ? (
        <Card as="section" title={t("staff.privacy.title")} headingLevel={2}>
          <div className="flex flex-col gap-3">
            <p className="m-0">
              {privacy.data.currentNoticeVersion
                ? t("staff.privacy.notice", {
                    acknowledged: privacy.data.acknowledged ? "yes" : "no",
                    version: privacy.data.currentNoticeVersion,
                  })
                : t("staff.privacy.noNotice")}
            </p>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {privacy.data.imageConsent.map((c) => (
                <li key={c.purpose} className="flex flex-wrap items-center gap-2">
                  <span>{t("privacy.image.purpose", { purpose: c.purpose })}</span>
                  <StaffChip chip={consentChip(c.decision, t)} />
                </li>
              ))}
            </ul>
          </div>
        </Card>
      ) : null}
      {manage ? (
        <Card as="section" title={t("staff.profile.title")} headingLevel={2}>
          <StaffFileForm
            key={file.version}
            file={file}
            locations={me.locations.map((l) => ({ id: l.id, name: l.name }))}
          />
        </Card>
      ) : null}
    </div>
  );
}
