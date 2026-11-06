import { Card, PageHeader, StatusChip } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrivalNotice } from "@/components/care/ArrivalNotice";
import { CancelOrderForm, SubmitOrderForm } from "@/components/medicines/stock/LocationStockForms";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { formatDate, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import {
  locationStockHref,
  mayCancelOrder,
  maySubmitOrder,
  orderChip,
  orderHref,
  stockManaged,
  stockShown,
} from "@/lib/medicine-stock";
import { personNames } from "@/lib/people";
import { firstParam } from "@/lib/record-metadata";

type Params = Promise<{ locationId: string; orderId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = { title: t("medicines.stock.order.pageTitle") };

/**
 * One medicines order (slice 55; MEDS-008; medicines.md section 15 rule 7): its cycle, its step as
 * an icon and a word, how and when it was sent, and each line (the person, the medicine, the
 * quantity and unit, and how much has been received). A draft is submitted by hand or through the
 * pharmacy; an order not yet received can be cancelled. Lines are received on the person's stock.
 */
export default async function MedicineOrderPage({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { locationId, orderId } = await params;
  if (!isUuid(locationId) || !isUuid(orderId)) notFound();
  const { me } = await getShellContext();
  const title = t("medicines.stock.order.pageTitle");
  if (!stockShown(me.permissions)) return <SafetyForbidden title={title} />;
  const location = me.locations.find((l) => l.id === locationId);
  if (!location) notFound();
  const api = await tenantApi();
  const [read, people] = await Promise.all([
    api.GET("/v1/medicine-orders/{id}", { params: { path: { id: orderId } } }),
    api.GET("/v1/people", { params: { query: { locationId } } }),
  ]);
  if (problemCode(read.error) === "not_found") notFound();
  if (problemCode(read.error) === "missing_permission") return <SafetyForbidden title={title} />;
  if (!read.data) failWith(read.error, read.response, orderHref(locationId, orderId));
  const order = read.data;
  const names = new Map((people.data?.items ?? []).map((p) => [p.id, personNames(p).full]));
  const chip = orderChip(order.status, t);
  const manage = stockManaged(me.permissions);
  const done = firstParam((await searchParams).done);

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={location.name}
        title={t("medicines.stock.order.forCycle", {
          date: formatDate(order.cycleStartsOn) ?? "",
        })}
      />
      {done === "created" || done === "submitted" || done === "cancelled" ? (
        <ArrivalNotice>{t("medicines.stock.order.arrived", { done })}</ArrivalNotice>
      ) : null}
      <Card as="section" title={t("medicines.stock.order.details")} headingLevel={2}>
        <div className="flex flex-col gap-2">
          <p className="m-0">
            <StatusChip status={chip.status} label={chip.label} icon={chip.icon} />
          </p>
          {order.submittedAt ? (
            <p className="m-0">
              {t("medicines.stock.order.submittedAt", {
                at: formatDateTime(order.submittedAt) ?? "",
                via: order.sentVia ?? "manual",
              })}
            </p>
          ) : null}
          {order.pharmacyReference ? (
            <p className="m-0">
              {t("medicines.stock.order.reference", { reference: order.pharmacyReference })}
            </p>
          ) : null}
        </div>
      </Card>
      <Card as="section" title={t("medicines.stock.order.linesTitle")} headingLevel={2}>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className="py-2 pr-4">
                  {t("medicines.stock.order.person")}
                </th>
                <th scope="col" className="py-2 pr-4">
                  {t("medicines.stock.order.medicine")}
                </th>
                <th scope="col" className="py-2 pr-4">
                  {t("medicines.stock.order.ordered")}
                </th>
                <th scope="col" className="py-2">
                  {t("medicines.stock.order.received")}
                </th>
              </tr>
            </thead>
            <tbody>
              {order.lines.map((line) => (
                <tr key={line.id} className="border-b border-border">
                  <td className="py-2 pr-4">
                    {names.get(line.personId) ?? t("medicines.stock.order.someone")}
                  </td>
                  <td className="py-2 pr-4">{line.productName}</td>
                  <td className="py-2 pr-4">{line.quantity}</td>
                  <td className="py-2">
                    {line.received > line.quantity
                      ? t("medicines.stock.order.overReceived", { received: line.received })
                      : line.received}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {manage && maySubmitOrder(order.status) ? (
        <Card as="section" title={t("medicines.stock.order.submitTitle")} headingLevel={2}>
          <SubmitOrderForm locationId={locationId} orderId={order.id} version={order.version} />
        </Card>
      ) : null}
      {manage && mayCancelOrder(order.status) ? (
        <Card as="section" title={t("medicines.stock.order.cancelTitle")} headingLevel={2}>
          <CancelOrderForm locationId={locationId} orderId={order.id} version={order.version} />
        </Card>
      ) : null}
      <p className="m-0">
        <Link
          href={locationStockHref(locationId)}
          className="inline-flex min-h-target items-center underline"
        >
          {t("medicines.stock.back")}
        </Link>
      </p>
    </div>
  );
}
