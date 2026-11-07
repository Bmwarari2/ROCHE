import { Card } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { NoAccess } from "@/components/care/NoAccess";
import { RecordFrame } from "@/components/care/RecordFrame";
import { WitnessDisposalForm } from "@/components/medicines/stock/PersonStockForms";
import { getShellContext, tenantApi } from "@/lib/api";
import { tabHref } from "@/lib/care-record";
import { isUuid } from "@/lib/context-cookies";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { findDisposal, personStockHref, stockManaged } from "@/lib/medicine-stock";
import { getPerson, readOrFail } from "@/lib/person-record";
import { recordMetadata } from "@/lib/record-metadata";

type Params = Promise<{ id: string; disposalId: string }>;

export async function generateMetadata(): Promise<Metadata> {
  return recordMetadata("medicines", t("medicines.stock.witness.title"));
}

/**
 * Confirming a disposal as its witness (slice 55; MEDS-008; medicines.md section 15 rule 5): the
 * member named as the witness, in their own session, sees what was disposed of (the medicine, the
 * quantity, when) and confirms it once. Only this closes the witness task. The API refuses anyone
 * else, the recorder included, in its own words.
 */
async function WitnessTab({ params }: { readonly params: Params }) {
  const { id, disposalId } = await params;
  if (!isUuid(disposalId)) notFound();
  const { person } = await getPerson(id);
  if (!person) return null;
  const { me } = await getShellContext();
  // The permissions that reach this person, as the API decides (security review m2).
  const reaching = person.access?.reaching ?? me.permissions;
  if (!stockManaged(reaching)) return <NoAccess />;
  const api = await tenantApi();
  const data = readOrFail(
    await api.GET("/v1/people/{id}/medicine-stock", { params: { path: { id } } }),
    tabHref(id, "medicines"),
  );
  if (!data) return <NoAccess />;
  const found = findDisposal(data, disposalId);

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-eyebrow">{t("medicines.stock.witness.title")}</h2>
        <p className="m-0 max-w-prose text-text-secondary">{t("medicines.stock.witness.intro")}</p>
      </div>
      <Card as="section" title={t("medicines.stock.witness.what")} headingLevel={3}>
        <div className="flex flex-col gap-4">
          {found ? (
            <dl className="m-0 grid gap-x-6 gap-y-1 sm:grid-cols-[max-content_1fr]">
              <dt className="font-semibold">{t("medicines.stock.order.medicine")}</dt>
              <dd className="m-0">{found.item.productName}</dd>
              <dt className="font-semibold">{t("medicines.stock.witness.quantity")}</dt>
              <dd className="m-0">
                {t("medicines.stock.balance", {
                  balance: Math.abs(found.movement.change),
                  unit: found.item.unitName,
                })}
              </dd>
              <dt className="font-semibold">{t("medicines.stock.witness.when")}</dt>
              <dd className="m-0">{formatDateTime(found.movement.recordedAt) ?? ""}</dd>
            </dl>
          ) : (
            <p className="m-0">{t("medicines.stock.witness.notListed")}</p>
          )}
          {/* A witness signs only for a disposal on screen, of this person (security review M1). */}
          {!found ? null : found.movement.recordedBy === me.tenantUserId ? (
            <p className="m-0">{t("medicines.stock.witness.youRecorded")}</p>
          ) : (
            <WitnessDisposalForm personId={id} disposalId={disposalId} />
          )}
        </div>
      </Card>
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

export default async function WitnessDisposalPage(props: { readonly params: Params }) {
  const { id } = await props.params;
  return (
    <RecordFrame personId={id} tab="medicines">
      <WitnessTab {...props} />
    </RecordFrame>
  );
}
