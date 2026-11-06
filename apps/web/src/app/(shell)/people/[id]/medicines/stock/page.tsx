import { Card, EmptyState, StatusChip } from "@harbour/ui";
import { BookLock, Package } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ArrivalNotice } from "@/components/care/ArrivalNotice";
import { NoAccess } from "@/components/care/NoAccess";
import { RecordFrame } from "@/components/care/RecordFrame";
import { OpenItemForm } from "@/components/medicines/stock/PersonStockForms";
import { getShellContext, tenantApi } from "@/lib/api";
import { tabHref } from "@/lib/care-record";
import { cdPageHref } from "@/lib/controlled-drugs";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import {
  balanceChip,
  openableEntries,
  stockItemHref,
  stockManaged,
  stockShown,
} from "@/lib/medicine-stock";
import { medicinesHref } from "@/lib/medicines";
import { getPerson, readOrFail } from "@/lib/person-record";
import { firstParam, recordMetadata } from "@/lib/record-metadata";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata(): Promise<Metadata> {
  return recordMetadata("medicines", t("medicines.stock.personTitle"));
}

const iconProps = { size: 20, strokeWidth: 1.5, "aria-hidden": true } as const;

/**
 * A person's medicines stock (slice 55; MEDS-008; medicines.md section 15 rules 1 to 5): each item
 * with its balance as the API counts it (never added up here), a balance below nought said in an
 * icon and words, and its latest movements; each controlled drug with its register's balance,
 * marked as the register's and never counted here. A stock manager opens an item from the MAR, and
 * each item's page records receipts, counts, returns and disposals.
 */
async function PersonStockTab({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await params;
  const { person } = await getPerson(id);
  if (!person) return null;
  const { me } = await getShellContext();
  if (!stockShown(me.permissions)) return <NoAccess />;
  const manage = stockManaged(me.permissions);
  const api = await tenantApi();
  const [read, record] = await Promise.all([
    api.GET("/v1/people/{id}/medicine-stock", { params: { path: { id } } }),
    manage ? api.GET("/v1/people/{id}/medicines", { params: { path: { id } } }) : null,
  ]);
  const data = readOrFail(read, tabHref(id, "medicines"));
  if (!data) return <NoAccess />;
  const openable = openableEntries(record?.data?.entries ?? [], data.items).map((e) => ({
    id: e.id,
    name: e.product.name,
  }));
  const done = firstParam((await searchParams).done);
  const when = (iso: string) => formatDateTime(iso) ?? "";

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-eyebrow">{t("medicines.stock.personTitle")}</h2>
        <p className="m-0 max-w-prose text-text-secondary">{t("medicines.stock.personIntro")}</p>
      </div>
      {done === "opened" || done === "witnessed" ? (
        <ArrivalNotice>{t("medicines.stock.personArrived", { done })}</ArrivalNotice>
      ) : null}
      <Card as="section" title={t("medicines.stock.items")} headingLevel={3}>
        {data.items.length === 0 ? (
          <EmptyState
            headingLevel={4}
            icon={<Package {...iconProps} />}
            title={t("medicines.stock.noItems")}
          />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {data.items.map((item) => {
              const below = balanceChip(item.balance, t);
              const last = item.movements[0];
              return (
                <li key={item.id} className="flex flex-col gap-1 border-b border-border pb-3">
                  <p className="m-0 flex flex-wrap items-center gap-2">
                    <Link
                      href={stockItemHref(id, item.id)}
                      className="inline-flex min-h-target items-center font-semibold underline"
                    >
                      {item.productName}
                    </Link>
                    <span>
                      {t("medicines.stock.balance", {
                        balance: item.balance,
                        unit: item.unitName,
                      })}
                    </span>
                    {below ? (
                      <StatusChip status={below.status} label={below.label} icon={below.icon} />
                    ) : null}
                  </p>
                  {last ? (
                    <p className="m-0">
                      {t("medicines.stock.lastMovement", {
                        movement: last.movement,
                        change: last.change,
                        at: when(last.recordedAt),
                      })}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      {data.controlledDrugs.length > 0 ? (
        <Card as="section" title={t("medicines.stock.controlledDrugs")} headingLevel={3}>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {data.controlledDrugs.map((cd) => (
              <li key={cd.pageId} className="flex flex-col gap-1 border-b border-border pb-3">
                <p className="m-0 flex flex-wrap items-center gap-2">
                  <BookLock {...iconProps} />
                  <span className="font-semibold">{cd.productName}</span>
                  <span>
                    {t("medicines.stock.balance", { balance: cd.balance, unit: cd.unitName })}
                  </span>
                </p>
                <p className="m-0">{t("medicines.stock.fromRegister")}</p>
                <p className="m-0">
                  <Link
                    href={cdPageHref(id, cd.pageId)}
                    className="inline-flex min-h-target items-center underline"
                  >
                    {t("medicines.stock.openRegister", { product: cd.productName })}
                  </Link>
                </p>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {manage ? (
        <Card as="section" title={t("medicines.stock.open.title")} headingLevel={3}>
          {openable.length === 0 ? (
            <p className="m-0">{t("medicines.stock.open.nothing")}</p>
          ) : (
            <OpenItemForm personId={id} entries={openable} />
          )}
        </Card>
      ) : null}
      <p className="m-0">
        <Link href={medicinesHref(id)} className="inline-flex min-h-target items-center underline">
          {t("medicines.back")}
        </Link>
      </p>
    </>
  );
}

export default async function PersonStockPage(props: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await props.params;
  return (
    <RecordFrame personId={id} tab="medicines">
      <PersonStockTab {...props} />
    </RecordFrame>
  );
}
