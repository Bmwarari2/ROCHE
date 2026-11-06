import { ButtonLink, Card, EmptyState, PageHeader, StatusChip } from "@harbour/ui";
import { Ban, Pencil, Pill, Plus } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArrivalNotice } from "@/components/care/ArrivalNotice";
import { ProtocolSummary } from "@/components/medicines/homely/ProtocolSummary";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { formatDateTime } from "@/lib/format";
import {
  changeProtocolHref,
  homelyShown,
  mayManageProtocols,
  newProtocolHref,
  protocolChip,
  protocolsHref,
  withdrawProtocolHref,
} from "@/lib/homely-remedies";
import { t } from "@/lib/i18n";
import { firstParam } from "@/lib/record-metadata";

type Params = Promise<{ locationId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = { title: t("medicines.homely.title") };

const iconProps = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;
const DONE = new Set(["added", "changed", "withdrawn"]);

/**
 * A home's homely remedy protocols (slice 55; MEDS-007; medicines.md section 15.3; HZ-120): each
 * with its state as an icon and the API's words (in use, review overdue, withdrawn), the figures the
 * home agreed with the GP or pharmacist, and why it was last changed or withdrawn. A medicines
 * manager adds, changes and withdraws them; anyone who reads medicines sees them. Harbour
 * recommends no remedy.
 */
export default async function HomelyRemediesPage({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { locationId } = await params;
  if (!isUuid(locationId)) notFound();
  const { me } = await getShellContext();
  const title = t("medicines.homely.title");
  if (!homelyShown(me.permissions)) return <SafetyForbidden title={title} />;
  const location = me.locations.find((l) => l.id === locationId);
  if (!location) notFound();
  const api = await tenantApi();
  const read = await api.GET("/v1/locations/{id}/homely-remedies", {
    params: { path: { id: locationId } },
  });
  if (problemCode(read.error) === "not_found") notFound();
  if (problemCode(read.error) === "missing_permission") return <SafetyForbidden title={title} />;
  if (!read.data) failWith(read.error, read.response, protocolsHref(locationId));
  const manage = mayManageProtocols(me.permissions);
  const done = firstParam((await searchParams).done);

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader eyebrow={location.name} title={title} description={t("medicines.homely.intro")} />
      {done && DONE.has(done) ? (
        <ArrivalNotice>{t("medicines.homely.done", { done })}</ArrivalNotice>
      ) : null}
      {manage ? (
        <p className="m-0">
          <ButtonLink href={newProtocolHref(locationId)} icon={<Plus {...iconProps} />}>
            {t("medicines.homely.add")}
          </ButtonLink>
        </p>
      ) : null}
      {read.data.items.length === 0 ? (
        <EmptyState
          icon={<Pill size={20} strokeWidth={1.5} aria-hidden="true" />}
          title={t("medicines.homely.none")}
          description={t("medicines.homely.noneAbout")}
        />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-4 p-0">
          {read.data.items.map((protocol) => {
            const chip = protocolChip(protocol);
            return (
              <li key={protocol.id}>
                <Card as="article" title={protocol.productName} headingLevel={2}>
                  <div className="flex flex-col gap-3">
                    <p className="m-0">
                      <StatusChip status={chip.status} label={chip.label} icon={chip.icon} />
                    </p>
                    <ProtocolSummary protocol={protocol} staff />
                    {protocol.withdrawnAt ? (
                      <p className="m-0">
                        {t("medicines.homely.withdrawnOn", {
                          at: formatDateTime(protocol.withdrawnAt) ?? "",
                          reason: protocol.withdrawnReason ?? "",
                        })}
                      </p>
                    ) : protocol.changeReason ? (
                      <p className="m-0">
                        {t("medicines.homely.changeReason", { reason: protocol.changeReason })}
                      </p>
                    ) : null}
                    {manage && protocol.status !== "withdrawn" ? (
                      <div className="flex flex-wrap gap-2">
                        <ButtonLink
                          href={changeProtocolHref(locationId, protocol.id)}
                          variant="secondary"
                          icon={<Pencil {...iconProps} />}
                        >
                          {t("medicines.homely.changeLink", { product: protocol.productName })}
                        </ButtonLink>
                        <ButtonLink
                          href={withdrawProtocolHref(locationId, protocol.id)}
                          variant="secondary"
                          icon={<Ban {...iconProps} />}
                        >
                          {t("medicines.homely.withdrawLink", { product: protocol.productName })}
                        </ButtonLink>
                      </div>
                    ) : null}
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
