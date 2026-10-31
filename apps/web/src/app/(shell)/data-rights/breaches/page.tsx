import { Card, EmptyState, StatusChip } from "@harbour/ui";
import { ShieldAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { RecordBreachForm } from "@/components/breaches/BreachForms";
import { DataRightsFrame } from "@/components/data-rights/DataRightsFrame";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { breachChip, breachClockWords, breachPath } from "@/lib/breaches";
import { BREACHES_PAGE, dataRightsShown } from "@/lib/data-rights";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: t("dataRights.breaches.title") };

/**
 * The breach register (PLAT-022; platform.md rules 18 to 24): every breach, reportable or not,
 * newest awareness first, each with its state and its ICO clock in words, the clock worked out by
 * the API from the rate table. Entries Thapsus opened with a processor notice say so. A form
 * records a new one. Only someone handling data protection for the whole organisation sees it.
 */
export default async function BreachesPage() {
  const { me } = await getShellContext();
  const title = t("dataRights.breaches.title");
  if (!dataRightsShown(me)) {
    return <SafetyForbidden title={title} hint={t("dataRights.orgWideOnly")} />;
  }
  const api = await tenantApi();
  const listed = await api.GET("/v1/data-protection/breaches");
  if (!listed.data) failWith(listed.error, listed.response, BREACHES_PAGE);
  const { items, truncated, reportHours } = listed.data;

  return (
    <DataRightsFrame
      tab="breaches"
      title={title}
      eyebrow={me.tenant.name}
      description={t("dataRights.breach.description", { hours: reportHours })}
    >
      <Card as="section" title={t("dataRights.breach.list.title")} headingLevel={2}>
        {items.length === 0 ? (
          <EmptyState
            icon={<ShieldAlert size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("dataRights.breach.list.empty")}
          />
        ) : (
          <div className="flex flex-col gap-4">
            {truncated ? (
              <p className="m-0" role="note">
                {t("dataRights.breach.list.truncated", { count: items.length })}
              </p>
            ) : null}
            <ul className="m-0 flex list-none flex-col divide-y divide-border p-0">
              {items.map((breach) => {
                const clock = breachClockWords(breach, t);
                const chip = breachChip(breach, t);
                return (
                  <li key={breach.id} className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0">
                    <Link
                      href={breachPath(breach.id)}
                      className="inline-flex min-h-target items-center font-semibold underline"
                    >
                      {breach.summary}
                    </Link>
                    <p className="m-0 text-body-dense">
                      {t("dataRights.breach.awareAt", { at: formatDateTime(breach.awareAt) ?? "" })}
                    </p>
                    {breach.source === "processor_notice" ? (
                      <p className="m-0 text-body-dense">{t("dataRights.breach.fromThapsus")}</p>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusChip status={chip.status} label={chip.label} />
                      <StatusChip status={clock.status} label={clock.label} />
                    </div>
                    <p className="m-0">{clock.words}</p>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </Card>
      <Card as="section" title={t("dataRights.breach.record.title")} headingLevel={2}>
        <div className="flex flex-col gap-4">
          <p className="m-0">{t("dataRights.breach.record.intro", { hours: reportHours })}</p>
          <RecordBreachForm />
        </div>
      </Card>
    </DataRightsFrame>
  );
}
