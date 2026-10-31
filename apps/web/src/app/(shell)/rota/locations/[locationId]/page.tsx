import { Card, EmptyState, PageHeader } from "@harbour/ui";
import { CalendarDays } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { StartRotaForm } from "@/components/rota/RotaForms";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { firstParam } from "@/lib/record-metadata";
import {
  mayManageRota,
  rotaChip,
  rotaHomePage,
  rotaPage,
  rotaShown,
  templatesPage,
} from "@/lib/rota";

export const metadata: Metadata = { title: t("rota.title") };

type Params = Promise<{ locationId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * A home's rotas (SCHED-002), newest first, each with where it stands as an icon and a word; a
 * rota manager starts a new one here and keeps the home's shift templates and patterns.
 */
export default async function RotaHomePage({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { me } = await getShellContext();
  const title = t("rota.title");
  if (!rotaShown(me.permissions)) return <SafetyForbidden title={title} />;
  const { locationId } = await params;
  if (!isUuid(locationId)) notFound();
  const home = me.locations.find((l) => l.id === locationId);
  if (!home) notFound();
  const api = await tenantApi();
  const listed = await api.GET("/v1/locations/{id}/rotas", {
    params: { path: { id: locationId } },
  });
  if (!listed.data) failWith(listed.error, listed.response, rotaHomePage(locationId));
  const done = firstParam((await searchParams).done);
  const manage = mayManageRota(me.permissions);

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader eyebrow={home.name} title={title} description={t("rota.home.description")} />
      {done === "archived" ? (
        <RecordedArrival message={t("rota.done", { done })} param="done" />
      ) : null}
      {manage ? (
        <p className="m-0">
          <Link
            href={templatesPage(locationId)}
            className="inline-flex min-h-target items-center underline"
          >
            {t("rota.home.templatesLink")}
          </Link>
        </p>
      ) : null}
      <Card as="section" title={t("rota.home.list")} headingLevel={2}>
        {listed.data.items.length === 0 ? (
          <EmptyState
            headingLevel={3}
            icon={<CalendarDays size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("rota.home.empty")}
          />
        ) : (
          <ul className="hb-long-list m-0 flex list-none flex-col gap-3 p-0">
            {listed.data.items.map((r) => (
              <li key={r.id} className="flex flex-col gap-2 border-b border-border pb-3">
                <h3 className="m-0 text-body font-semibold">
                  <Link href={rotaPage(r.id)}>
                    {t("rota.item.title", {
                      from: formatDate(r.startsOn) ?? r.startsOn,
                      to: formatDate(r.endsOn) ?? r.endsOn,
                    })}
                  </Link>
                </h3>
                <p className="m-0">
                  <SafetyChip chip={rotaChip(r, t)} />
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {manage ? (
        <Card as="section" title={t("rota.start.title")} headingLevel={2}>
          <StartRotaForm locationId={locationId} path={rotaHomePage(locationId)} />
        </Card>
      ) : null}
    </div>
  );
}
