import { Card, EmptyState, StatusChip } from "@harbour/ui";
import { BookOpen, Clock } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { NoAccess } from "@/components/care/NoAccess";
import { RecordFrame } from "@/components/care/RecordFrame";
import { OpenPageForm } from "@/components/cd/CdForms";
import { getShellContext, tenantApi } from "@/lib/api";
import { can, tabHref } from "@/lib/care-record";
import {
  CD_RECORDER,
  cdPageHref,
  cdShown,
  countOverdue,
  stockCheckChip,
} from "@/lib/controlled-drugs";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { getPerson, readOrFail } from "@/lib/person-record";
import { recordMetadata } from "@/lib/record-metadata";

type Params = Promise<{ id: string }>;

export async function generateMetadata(): Promise<Metadata> {
  return recordMetadata("controlled-drugs");
}

/**
 * The person's controlled drugs register (MEDS-005; medicines.md section 15 rule 1): one row per
 * page (drug, form and strength), with the balance as the API reports it, the last count's result
 * in words and when the next is due. A recorder opens a page for a medicine on the MAR.
 */
async function ControlledDrugsTab({ params }: { readonly params: Params }) {
  const { id } = await params;
  const { person } = await getPerson(id);
  if (!person) return null;
  const { me } = await getShellContext();
  if (!cdShown(me.permissions)) return <NoAccess />;
  const api = await tenantApi();
  const data = readOrFail(
    await api.GET("/v1/people/{id}/controlled-drugs", { params: { path: { id } } }),
    tabHref(id, "controlled-drugs"),
  );
  if (!data) return <NoAccess />;
  const recorder = can(me.permissions, CD_RECORDER);
  // The MAR's medicines, to open a page for one; the API refuses one that is not a controlled drug.
  const mar = recorder
    ? await api.GET("/v1/people/{id}/medicines", { params: { path: { id } } }).catch(() => null)
    : null;
  const opened = new Set(data.pages.map((p) => p.vmpId));
  const toOpen = (mar?.data?.entries ?? [])
    .filter((e) => !opened.has(e.product.vmpId))
    .map((e) => ({ id: e.id, label: e.product.name }));

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-eyebrow">{t("cd.title")}</h2>
        <p className="m-0 max-w-prose text-text-secondary">{t("cd.intro")}</p>
      </div>
      <Card as="section" title={t("cd.pagesTitle")} headingLevel={3}>
        {data.pages.length === 0 ? (
          <EmptyState
            headingLevel={4}
            icon={<BookOpen size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("cd.empty")}
          />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-4 p-0">
            {data.pages.map((p) => {
              const overdue = countOverdue(p.nextStockCheckDueAt);
              const last = p.lastStockCheck;
              return (
                <li key={p.id} className="flex flex-col gap-2 border-b border-border pb-4">
                  <h4 className="m-0 text-body font-semibold">
                    <Link
                      href={cdPageHref(id, p.id)}
                      className="inline-flex min-h-target items-center underline"
                    >
                      {p.productName}
                    </Link>
                  </h4>
                  <p className="m-0 text-title">
                    {t("cd.balance", { balance: p.balance, unit: p.unit.name })}
                  </p>
                  <p className="m-0 flex flex-wrap items-center gap-2">
                    {last ? (
                      <StatusChip {...stockCheckChip(last)} />
                    ) : (
                      <StatusChip status="notRecorded" label={t("cd.neverCounted")} />
                    )}
                    {p.nextStockCheckDueAt ? (
                      <StatusChip
                        status={overdue ? "overdue" : "due"}
                        icon={Clock}
                        label={t("cd.nextCount", {
                          overdue: String(overdue),
                          when: formatDateTime(p.nextStockCheckDueAt) ?? "",
                        })}
                      />
                    ) : null}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      {recorder && toOpen.length > 0 ? (
        <Card as="section" title={t("cd.open.title")} headingLevel={3}>
          <OpenPageForm personId={id} entries={toOpen} />
        </Card>
      ) : null}
    </>
  );
}

export default async function ControlledDrugsPage(props: { readonly params: Params }) {
  const { id } = await props.params;
  return (
    <RecordFrame personId={id} tab="controlled-drugs">
      <ControlledDrugsTab {...props} />
    </RecordFrame>
  );
}
