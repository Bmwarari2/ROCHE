import { Card, EmptyState, PageHeader } from "@harbour/ui";
import { Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { t } from "@/lib/i18n";
import { staffShown, ukDate } from "@/lib/workforce";

export const metadata: Metadata = { title: t("workforce.staff.title") };

/** Members of staff with a staff file (WORK-004, WORK-013): each one's induction and leaving. */
export default async function StaffPage() {
  const { me } = await getShellContext();
  const title = t("workforce.staff.title");
  if (!staffShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const listed = await api.GET("/v1/workforce/staff-files");
  if (!listed.data) failWith(listed.error, listed.response, "/workforce/staff");
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={me.tenant.name}
        title={title}
        description={t("workforce.staff.description")}
      />
      {listed.data.items.length === 0 ? (
        <Card>
          <EmptyState
            headingLevel={2}
            icon={<Users size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("workforce.staff.empty")}
          />
        </Card>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {listed.data.items.map((file) => (
            <li key={file.id}>
              <Card>
                <div className="flex flex-col gap-2">
                  <h2 className="m-0 text-body font-semibold">
                    {file.member?.displayName ?? t("workforce.someone")}
                  </h2>
                  <p className="m-0 text-body-dense text-text-secondary">
                    {file.leftOn
                      ? t("workforce.staff.left", { job: file.jobTitle, date: ukDate(file.leftOn) })
                      : t("workforce.staff.started", {
                          job: file.jobTitle,
                          date: ukDate(file.startsOn) || t("common.notRecorded"),
                        })}
                  </p>
                  <p className="m-0">
                    <SafetyChip
                      chip={
                        file.complete
                          ? {
                              status: "done",
                              icon: "circle-check",
                              label: t("workforce.staff.fileComplete"),
                            }
                          : {
                              status: "due",
                              icon: "clock",
                              label: t("workforce.staff.fileOutstanding"),
                            }
                      }
                    />
                  </p>
                  <p className="m-0 flex flex-wrap gap-4">
                    <Link
                      href={`/workforce/staff/${file.id}/induction`}
                      className="inline-flex min-h-target items-center underline"
                    >
                      {t("workforce.staff.inductionLink", {
                        name: file.member?.displayName ?? t("workforce.someone"),
                      })}
                    </Link>
                    <Link
                      href={`/workforce/staff/${file.id}/leaving`}
                      className="inline-flex min-h-target items-center underline"
                    >
                      {t("workforce.staff.leavingLink", {
                        name: file.member?.displayName ?? t("workforce.someone"),
                      })}
                    </Link>
                  </p>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
