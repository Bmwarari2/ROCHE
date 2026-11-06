import { Card, EmptyState, PageHeader } from "@harbour/ui";
import { FolderOpen } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { StaffChip } from "@/components/staff/StaffChip";
import { StaffFileForm } from "@/components/staff/StaffForms";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import {
  choosableMembers,
  fileChip,
  SPONSOR_PAGE,
  STAFF_PAGE,
  sponsorShown,
  staffFilesManaged,
  staffFilesShown,
} from "@/lib/staff";

export const metadata: Metadata = { title: t("staff.title") };

/**
 * Staff files (WORK-002, WORK-011): every staff profile with whether its Schedule 3 file is
 * complete, as an icon and a word, and what is outstanding; a new file for holders of
 * workforce.staff_file.manage, never for oneself. The API checks every permission again.
 */
export default async function StaffFilesPage() {
  const { me } = await getShellContext();
  const title = t("staff.title");
  if (!staffFilesShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const listed = await api.GET("/v1/workforce/staff-files");
  if (!listed.data) failWith(listed.error, listed.response, STAFF_PAGE);
  const files = listed.data.items;
  const manage = staffFilesManaged(me.permissions);
  const members = manage ? await api.GET("/v1/workforce/staff-members") : null;
  const choosable = choosableMembers(
    members?.data?.items ?? [],
    me.tenantUserId,
    files.flatMap((f) => (f.member ? [f.member.id] : [])),
  );

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader eyebrow={me.tenant.name} title={title} description={t("staff.description")} />
      {sponsorShown(me.permissions) ? (
        <p className="m-0">
          <Link href={SPONSOR_PAGE} className="inline-flex min-h-target items-center underline">
            {t("sponsor.title")}
          </Link>
        </p>
      ) : null}
      <Card as="section" title={t("staff.list.title")} headingLevel={2}>
        {files.length === 0 ? (
          <EmptyState
            headingLevel={3}
            icon={<FolderOpen size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("staff.list.empty")}
          />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {files.map((f) => (
              <li key={f.id} className="flex flex-col gap-1 border-b border-border pb-3">
                <h3 className="m-0 text-body font-semibold">
                  <Link
                    href={`${STAFF_PAGE}/${f.id}`}
                    className="inline-flex min-h-target items-center underline"
                  >
                    {f.member?.displayName ?? t("staff.unknownMember")}
                  </Link>
                </h3>
                <p className="m-0 text-body-dense">
                  {f.startsOn
                    ? t("staff.list.jobStarts", {
                        job: f.jobTitle,
                        date: formatDate(f.startsOn) ?? "",
                      })
                    : f.jobTitle}
                </p>
                <p className="m-0 flex flex-wrap items-center gap-2">
                  <StaffChip chip={fileChip(f.complete, t)} />
                  {f.outstanding.length > 0 ? (
                    <span className="text-body-dense">
                      {t("staff.list.outstanding", { count: f.outstanding.length })}
                    </span>
                  ) : null}
                  {f.dueSoon.length > 0 ? (
                    <span className="text-body-dense">
                      {t("staff.list.dueSoon", { count: f.dueSoon.length })}
                    </span>
                  ) : null}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {manage ? (
        <Card as="section" title={t("staff.create.title")} headingLevel={2}>
          {choosable.length === 0 ? (
            <p className="m-0">{t("staff.create.noneToChoose")}</p>
          ) : (
            <StaffFileForm
              members={choosable}
              locations={me.locations.map((l) => ({ id: l.id, name: l.name }))}
            />
          )}
        </Card>
      ) : null}
    </div>
  );
}
