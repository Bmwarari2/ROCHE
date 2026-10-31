import { Card, EmptyState } from "@harbour/ui";
import { Inbox } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ClockChip } from "@/components/data-rights/ClockChip";
import { DataRightsFrame } from "@/components/data-rights/DataRightsFrame";
import { NewRequestForm } from "@/components/data-rights/DsarForms";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { dataRightsShown, REQUESTS_PAGE } from "@/lib/data-rights";
import { requestPage } from "@/lib/dsar";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { personNames } from "@/lib/people";

export const metadata: Metadata = { title: t("dataRights.requests.title") };

/**
 * Data subject requests (PLAT-022; platform.md, the DSAR workbench): every request, newest first,
 * with its clock as an icon, a word and a sentence, and the form to record a new one. Offered only
 * to holders of quality.dsar.manage across the organisation; the API checks it again.
 */
export default async function RequestsPage() {
  const { me } = await getShellContext();
  const title = t("dataRights.requests.title");
  if (!dataRightsShown(me))
    return <SafetyForbidden title={title} hint={t("dataRights.orgWideOnly")} />;
  const api = await tenantApi();
  const [cases, people, members] = await Promise.all([
    api.GET("/v1/dsar-cases"),
    api.GET("/v1/people"),
    api.GET("/v1/members"),
  ]);
  if (!cases.data) failWith(cases.error, cases.response, REQUESTS_PAGE);
  const subjects = (people.data?.items ?? []).map((p) => ({ id: p.id, name: personNames(p).full }));
  const staff = (members.data?.items ?? []).map((m) => ({ id: m.id, name: m.displayName }));
  return (
    <DataRightsFrame
      tab="requests"
      title={title}
      eyebrow={me.tenant.name}
      description={t("dataRights.requests.description")}
    >
      <Card as="section" title={t("dataRights.requests.list")} headingLevel={2}>
        {cases.data.items.length === 0 ? (
          <EmptyState
            icon={<Inbox size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("dataRights.requests.empty")}
          />
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y divide-border p-0">
            {cases.data.items.map((c) => (
              <li key={c.id} className="flex flex-col gap-1 py-3">
                <h3 className="m-0 text-body font-semibold">
                  <Link
                    href={requestPage(c.id)}
                    className="inline-flex min-h-target items-center underline"
                    aria-label={t("dataRights.requests.open", {
                      name: c.subject.name,
                      kind: c.requestKind,
                      date: formatDate(c.receivedOn) ?? "",
                    })}
                  >
                    {c.subject.name}
                  </Link>
                </h3>
                <p className="m-0 text-text-secondary">
                  {t("dataRights.request.kind", { kind: c.requestKind })} ·{" "}
                  {t("dataRights.request.subjectKind", { kind: c.subject.kind })} ·{" "}
                  {t("dataRights.requests.received", { date: formatDate(c.receivedOn) ?? "" })}
                </p>
                <ClockChip clock={c.clock} respondedOn={null} withWords />
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card as="section" title={t("dataRights.new.title")} headingLevel={2}>
        <NewRequestForm people={subjects} staff={staff} />
      </Card>
    </DataRightsFrame>
  );
}
