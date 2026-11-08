import { Card, PageHeader } from "@harbour/ui";
import { Info } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { endLineManager, setLineManager } from "@/app/actions/reporting-lines";
import { Notice } from "@/components/care/Notice";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { WorkforceForm } from "@/components/workforce/WorkforceForm";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import {
  lineManagerHref,
  maintainsReportingLines,
  periodChip,
  staffOptions,
} from "@/lib/reporting-lines";
import { ukToday } from "@/lib/uk-time";
import { staffShown, ukDate } from "@/lib/workforce";

export const metadata: Metadata = { title: t("workforce.lineManager.title") };

/**
 * A member's line manager (ADR-0137): who it is now and since when, and the lines before, each
 * marked current or ended in words. HR (organisation-wide `workforce.staff_file.manage`) names,
 * changes or ends it against the version loaded; anyone else who may open the staff file sees it
 * read only. A current line widens what the manager may read about the member, never what they
 * may sign off or record (HZ-119).
 */
export default async function LineManagerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { me } = await getShellContext();
  const title = t("workforce.lineManager.title");
  if (!staffShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const path = lineManagerHref(id);
  const files = await api.GET("/v1/workforce/staff-files");
  if (!files.data) failWith(files.error, files.response, path);
  const file = files.data.items.find((f) => f.id === id);
  const memberId = file?.member?.id;
  if (!file || !memberId) notFound();
  const name = file.member?.displayName ?? t("workforce.someone");
  const maintains = maintainsReportingLines(me);
  const [lines, staff] = await Promise.all([
    api.GET("/v1/workforce/members/{memberId}/line-manager", {
      params: { path: { memberId } },
    }),
    maintains ? api.GET("/v1/workforce/staff-members") : null,
  ]);
  if (!lines.data) failWith(lines.error, lines.response, path);
  const { current } = lines.data;
  const history = lines.data.history.filter((l) => l !== null);
  const options = staffOptions(staff?.data?.items ?? [], [memberId]);
  const today = ukToday();

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={t("workforce.staff.title")}
        title={t("workforce.lineManager.heading", { name })}
        description={t("workforce.lineManager.description")}
      />
      <Card as="section" title={t("workforce.lineManager.now")} headingLevel={2}>
        {current ? (
          <div className="flex flex-col gap-2">
            <p className="m-0 font-semibold">{current.managerName}</p>
            <p className="m-0 flex flex-wrap items-center gap-2">
              <SafetyChip chip={periodChip(null, t)} />
              <span>{t("workforce.lineManager.since", { date: ukDate(current.validFrom) })}</span>
            </p>
          </div>
        ) : (
          <p className="m-0">{t("workforce.lineManager.none")}</p>
        )}
      </Card>
      {maintains ? (
        <Card>
          <WorkforceForm
            headingLevel={2}
            title={t(current ? "workforce.lineManager.change" : "workforce.lineManager.name")}
            intro={t("workforce.lineManager.nameIntro")}
            path={path}
            submit={t(
              current ? "workforce.lineManager.changeSubmit" : "workforce.lineManager.nameSubmit",
            )}
            done="workforce.lineManager.saved"
            action={setLineManager.bind(null, memberId, current?.version ?? null)}
            fields={[
              {
                kind: "select",
                name: "managerId",
                label: t("workforce.lineManager.managerLabel"),
                required: true,
                emptyOption: t("workforce.form.choose"),
                options,
              },
              {
                kind: "date",
                name: "from",
                label: t("workforce.lineManager.fromLabel"),
                hint: t("workforce.lineManager.fromHint"),
                required: true,
                defaultValue: today,
              },
            ]}
          />
          {current ? (
            <div className="mt-6 border-t border-border pt-6">
              <WorkforceForm
                headingLevel={2}
                title={t("workforce.lineManager.end")}
                intro={t("workforce.lineManager.endIntro", { manager: current.managerName })}
                path={path}
                submit={t("workforce.lineManager.endSubmit")}
                done="workforce.lineManager.ended"
                destructive
                action={endLineManager.bind(null, memberId, current.version)}
                fields={[
                  {
                    kind: "date",
                    name: "from",
                    label: t("workforce.lineManager.endFromLabel"),
                    hint: t("workforce.lineManager.endFromHint"),
                    required: true,
                    defaultValue: today,
                  },
                ]}
              />
            </div>
          ) : null}
        </Card>
      ) : (
        <Notice
          icon={<Info size={20} strokeWidth={1.5} aria-hidden="true" />}
          title={t("workforce.lineManager.readOnly")}
        />
      )}
      <Card as="section" title={t("workforce.lineManager.before")} headingLevel={2}>
        {history.length === 0 ? (
          <p className="m-0">{t("workforce.lineManager.noHistory")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {history.map((line) => (
              <li
                key={line.id}
                className="flex flex-col gap-1 border-b border-border pb-3 last:border-0"
              >
                <p className="m-0 flex flex-wrap items-center gap-2">
                  <SafetyChip chip={periodChip(line.validTo, t)} />
                  <span className="font-semibold">{line.managerName}</span>
                </p>
                <p className="m-0 text-body-dense">
                  {line.validTo
                    ? t("workforce.lineManager.period", {
                        from: ukDate(line.validFrom),
                        to: ukDate(line.validTo),
                      })
                    : t("workforce.lineManager.periodOpen", { from: ukDate(line.validFrom) })}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <p className="m-0">
        <Link href="/workforce/staff" className="inline-flex min-h-target items-center underline">
          {t("workforce.lineManager.back")}
        </Link>
      </p>
    </div>
  );
}
