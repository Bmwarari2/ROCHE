import { ButtonLink, Card, EmptyState, PageHeader, StatusChip } from "@harbour/ui";
import { PackagePlus, Refrigerator, Thermometer, Warehouse } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrivalNotice } from "@/components/care/ArrivalNotice";
import { AddStorageForm, CycleForm } from "@/components/medicines/stock/LocationStockForms";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { formatDate, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import {
  locationStockHref,
  newOrderHref,
  orderChip,
  orderHref,
  stockManaged,
  stockShown,
  storageHref,
} from "@/lib/medicine-stock";
import { firstParam } from "@/lib/record-metadata";

type Params = Promise<{ locationId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = { title: t("medicines.stock.title") };

const iconProps = { size: 20, strokeWidth: 1.5, "aria-hidden": true } as const;

/**
 * A location's medicines stock (slice 55; MEDS-008; medicines.md section 15 rules 6 to 8): the
 * 28-day ordering cycle (its length from the rate table), the orders by cycle with each one's step
 * as an icon and a word, and the fridges and medicines rooms, each opening its temperature
 * readings. Reading needs any of the API's readers; changing needs `medicines.stock.manage`.
 */
export default async function MedicinesStockPage({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { locationId } = await params;
  if (!isUuid(locationId)) notFound();
  const { me } = await getShellContext();
  const title = t("medicines.stock.title");
  if (!stockShown(me.permissions)) return <SafetyForbidden title={title} />;
  const location = me.locations.find((l) => l.id === locationId);
  if (!location) notFound();
  const api = await tenantApi();
  const path = { params: { path: { id: locationId } } };
  const [cycle, orders, storage] = await Promise.all([
    api.GET("/v1/locations/{id}/medicine-cycle", path),
    api.GET("/v1/locations/{id}/medicine-orders", path),
    api.GET("/v1/locations/{id}/medicine-storage", path),
  ]);
  for (const read of [cycle, orders, storage]) {
    if (problemCode(read.error) === "not_found") notFound();
    if (problemCode(read.error) === "missing_permission") return <SafetyForbidden title={title} />;
  }
  if (!cycle.data) failWith(cycle.error, cycle.response, locationStockHref(locationId));
  if (!orders.data) failWith(orders.error, orders.response, locationStockHref(locationId));
  if (!storage.data) failWith(storage.error, storage.response, locationStockHref(locationId));
  const manage = stockManaged(me.permissions);
  const done = firstParam((await searchParams).done);
  const day = (iso: string | null) => formatDate(iso) ?? "";

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader eyebrow={location.name} title={title} description={t("medicines.stock.intro")} />
      <p className="m-0">
        <Link
          href={`${locationStockHref(locationId)}/homely-remedies`}
          className="inline-flex min-h-target items-center underline"
        >
          {t("medicines.links.homelyProtocols")}
        </Link>
      </p>
      {done === "cycle" || done === "storage" ? (
        <ArrivalNotice>{t("medicines.stock.arrived", { done })}</ArrivalNotice>
      ) : null}

      <Card as="section" title={t("medicines.stock.cycle.title")} headingLevel={2}>
        <div className="flex flex-col gap-4">
          {cycle.data.anchorOn ? (
            <dl className="m-0 grid gap-x-6 gap-y-1 sm:grid-cols-[max-content_1fr]">
              <dt className="font-semibold">{t("medicines.stock.cycle.length")}</dt>
              <dd className="m-0">
                {t("medicines.stock.cycle.days", { days: cycle.data.cycleDays })}
              </dd>
              <dt className="font-semibold">{t("medicines.stock.cycle.anchor")}</dt>
              <dd className="m-0">{day(cycle.data.anchorOn)}</dd>
              <dt className="font-semibold">{t("medicines.stock.cycle.next")}</dt>
              <dd className="m-0">{day(cycle.data.nextCycleStartsOn)}</dd>
            </dl>
          ) : (
            <p className="m-0">
              {t("medicines.stock.cycle.notSet", { days: cycle.data.cycleDays })}
            </p>
          )}
          {manage ? (
            <CycleForm
              locationId={locationId}
              anchorOn={cycle.data.anchorOn}
              version={cycle.data.version}
            />
          ) : null}
        </div>
      </Card>

      <Card
        as="section"
        title={t("medicines.stock.order.title")}
        headingLevel={2}
        actions={
          manage ? (
            <ButtonLink
              href={newOrderHref(locationId)}
              variant="secondary"
              icon={<PackagePlus {...iconProps} />}
            >
              {t("medicines.stock.order.start")}
            </ButtonLink>
          ) : null
        }
      >
        {orders.data.items.length === 0 ? (
          <EmptyState
            headingLevel={3}
            icon={<PackagePlus {...iconProps} />}
            title={t("medicines.stock.order.none")}
          />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {orders.data.items.map((order) => {
              const chip = orderChip(order.status, t);
              return (
                <li key={order.id} className="flex flex-col gap-1 border-b border-border pb-3">
                  <p className="m-0 flex flex-wrap items-center gap-2">
                    <StatusChip status={chip.status} label={chip.label} icon={chip.icon} />
                    <Link
                      href={orderHref(locationId, order.id)}
                      className="inline-flex min-h-target items-center font-semibold underline"
                    >
                      {t("medicines.stock.order.forCycle", { date: day(order.cycleStartsOn) })}
                    </Link>
                  </p>
                  <p className="m-0">
                    {t("medicines.stock.order.lines", { count: order.lines.length })}
                  </p>
                  {order.submittedAt ? (
                    <p className="m-0">
                      {t("medicines.stock.order.submittedAt", {
                        at: formatDateTime(order.submittedAt) ?? "",
                        via: order.sentVia ?? "manual",
                      })}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card as="section" title={t("medicines.stock.storage.title")} headingLevel={2}>
        <div className="flex flex-col gap-4">
          {storage.data.items.length === 0 ? (
            <EmptyState
              headingLevel={3}
              icon={<Thermometer {...iconProps} />}
              title={t("medicines.stock.storage.none")}
            />
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {storage.data.items.map((s) => (
                <li key={s.id} className="flex items-center gap-2">
                  {s.kind === "fridge" ? (
                    <Refrigerator {...iconProps} />
                  ) : (
                    <Warehouse {...iconProps} />
                  )}
                  <Link
                    href={storageHref(locationId, s.id)}
                    className="inline-flex min-h-target items-center underline"
                  >
                    {t("medicines.stock.storage.open", { name: s.name, kind: s.kind })}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {manage ? (
            <div className="flex flex-col gap-2">
              <h3 className="m-0 text-body font-semibold">{t("medicines.stock.storage.add")}</h3>
              <AddStorageForm locationId={locationId} />
            </div>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
