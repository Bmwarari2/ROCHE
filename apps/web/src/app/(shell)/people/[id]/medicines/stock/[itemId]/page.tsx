import { Card, StatusChip } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrivalNotice } from "@/components/care/ArrivalNotice";
import { NoAccess } from "@/components/care/NoAccess";
import { RecordFrame } from "@/components/care/RecordFrame";
import {
  CountForm,
  DisposalForm,
  ReceiptForm,
  ReturnForm,
} from "@/components/medicines/stock/PersonStockForms";
import { getShellContext, tenantApi } from "@/lib/api";
import { can, tabHref } from "@/lib/care-record";
import { isUuid } from "@/lib/context-cookies";
import { formatDate, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import {
  balanceChip,
  disposalWitnessHref,
  orderLineChoices,
  personStockHref,
  stockManaged,
  stockShown,
} from "@/lib/medicine-stock";
import { getPerson, readOrFail } from "@/lib/person-record";
import { firstParam, recordMetadata } from "@/lib/record-metadata";

type Params = Promise<{ id: string; itemId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata(): Promise<Metadata> {
  return recordMetadata("medicines", t("medicines.stock.itemTitle"));
}

const DONE = ["received", "returned", "counted", "disposed", "disposed_awaiting"] as const;

/**
 * One stock item (slice 55; MEDS-008; medicines.md section 15 rules 2, 4 and 5): its balance as
 * the API counts it, its latest movements with who recorded each and the balance after, and, for a
 * stock manager, the forms for a receipt (naming the open order line it fills), a return to the
 * pharmacy, a count and a disposal with its witness. A disposal movement links to the page where
 * its named witness confirms it.
 */
async function StockItemTab({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id, itemId } = await params;
  if (!isUuid(itemId)) notFound();
  const { person } = await getPerson(id);
  if (!person) return null;
  const { me } = await getShellContext();
  if (!stockShown(me.permissions)) return <NoAccess />;
  const manage = stockManaged(me.permissions);
  const api = await tenantApi();
  const [read, orders, members] = await Promise.all([
    api.GET("/v1/people/{id}/medicine-stock", { params: { path: { id } } }),
    manage
      ? api.GET("/v1/locations/{id}/medicine-orders", {
          params: { path: { id: person.locationId } },
        })
      : null,
    manage && can(me.permissions, "platform.user.manage")
      ? api.GET("/v1/members", { params: { query: { locationId: person.locationId } } })
      : null,
  ]);
  const data = readOrFail(read, tabHref(id, "medicines"));
  if (!data) return <NoAccess />;
  const item = data.items.find((i) => i.id === itemId);
  if (!item) notFound();
  const lines = orderLineChoices(orders?.data?.items ?? [], id, item.medicationId).map((l) => ({
    id: l.id,
    label: t("medicines.stock.receipt.lineOption", {
      date: formatDate(l.cycleStartsOn) ?? "",
      quantity: l.quantity,
      received: l.received,
    }),
  }));
  const witnesses = members?.data
    ? members.data.items
        .filter((m) => m.state === "active")
        .map((m) => ({ id: m.id, name: m.displayName }))
    : null;
  const below = balanceChip(item.balance, t);
  const query = await searchParams;
  const done = firstParam(query.done);
  // Each arrival starts the forms afresh, without the last one's answers or its "recorded".
  const at = firstParam(query.at) ?? "first";
  const when = (iso: string) => formatDateTime(iso) ?? "";
  const names = new Map((witnesses ?? []).map((w) => [w.id, w.name]));
  const who = (memberId: string) =>
    memberId === me.tenantUserId
      ? t("medicines.stock.you")
      : (names.get(memberId) ?? t("medicines.stock.aMember"));

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-eyebrow">{item.productName}</h2>
        <p className="m-0 flex flex-wrap items-center gap-2">
          <span className="font-semibold">
            {t("medicines.stock.balance", { balance: item.balance, unit: item.unitName })}
          </span>
          {below ? (
            <StatusChip status={below.status} label={below.label} icon={below.icon} />
          ) : null}
        </p>
      </div>
      {done && (DONE as readonly string[]).includes(done) ? (
        <ArrivalNotice key={at}>{t("medicines.stock.itemArrived", { done })}</ArrivalNotice>
      ) : null}
      <Card as="section" title={t("medicines.stock.movements")} headingLevel={3}>
        {item.movements.length === 0 ? (
          <p className="m-0">{t("medicines.stock.noMovements")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {item.movements.map((m) => (
              <li key={m.id} className="flex flex-col gap-1 border-b border-border pb-3">
                <p className="m-0 font-semibold">
                  {t("medicines.stock.movementLine", {
                    movement: m.movement,
                    change: m.change,
                    unit: item.unitName,
                  })}
                </p>
                <p className="m-0">
                  {t("medicines.stock.balanceAfter", {
                    balance: m.balanceAfter,
                    unit: item.unitName,
                  })}
                </p>
                <p className="m-0">
                  {t("medicines.stock.recordedBy", {
                    who: who(m.recordedBy),
                    at: when(m.recordedAt),
                  })}
                </p>
                {m.disposalId && manage && m.recordedBy !== me.tenantUserId ? (
                  <p className="m-0">
                    <Link
                      href={disposalWitnessHref(id, m.disposalId)}
                      className="inline-flex min-h-target items-center underline"
                    >
                      {t("medicines.stock.witness.open")}
                    </Link>
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {manage ? (
        <>
          <Card as="section" title={t("medicines.stock.receipt.title")} headingLevel={3}>
            <ReceiptForm
              key={at}
              personId={id}
              itemId={item.id}
              unitName={item.unitName}
              lines={lines}
            />
          </Card>
          <Card as="section" title={t("medicines.stock.count.title")} headingLevel={3}>
            <CountForm
              key={at}
              personId={id}
              itemId={item.id}
              unitName={item.unitName}
              balance={item.balance}
            />
          </Card>
          <Card as="section" title={t("medicines.stock.return.title")} headingLevel={3}>
            <ReturnForm key={at} personId={id} itemId={item.id} unitName={item.unitName} />
          </Card>
          <Card as="section" title={t("medicines.stock.disposal.title")} headingLevel={3}>
            <DisposalForm
              key={at}
              personId={id}
              itemId={item.id}
              unitName={item.unitName}
              me={me.tenantUserId}
              witnesses={witnesses}
            />
          </Card>
        </>
      ) : null}
      <p className="m-0">
        <Link
          href={personStockHref(id)}
          className="inline-flex min-h-target items-center underline"
        >
          {t("medicines.stock.backToPerson")}
        </Link>
      </p>
    </>
  );
}

export default async function StockItemPage(props: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await props.params;
  return (
    <RecordFrame personId={id} tab="medicines">
      <StockItemTab {...props} />
    </RecordFrame>
  );
}
