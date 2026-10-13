import { Card } from "@harbour/ui";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import {
  BestInterestsCard,
  CapacityCard,
  ConsentCard,
  ConsentDecisions,
  DolsCard,
} from "@/components/care/McaRecords";
import { NoAccess } from "@/components/care/NoAccess";
import { RecordFrame } from "@/components/care/RecordFrame";
import { getShellContext, tenantApi } from "@/lib/api";
import { can, entryChains, tabHref } from "@/lib/care-record";
import { t } from "@/lib/i18n";
import { renewedIds } from "@/lib/mca";
import { personNames } from "@/lib/people";
import { getPerson, readOrFail } from "@/lib/person-record";
import { recordMetadata } from "@/lib/record-metadata";
import { ukToday } from "@/lib/uk-time";

type Params = Promise<{ id: string }>;
type Part = "dols" | "capacity" | "bestInterests" | "consents";

/** The page title names the tab, never the person. */
export async function generateMetadata(): Promise<Metadata> {
  return recordMetadata("capacity");
}

/** A titled part of the tab, or the words that say nothing is recorded there. */
function Part({
  part,
  empty,
  children,
}: {
  readonly part: Part;
  readonly empty: boolean;
  readonly children: ReactNode;
}) {
  return (
    <section aria-labelledby={`mca-${part}`} className="flex flex-col gap-3">
      <h3 id={`mca-${part}`} className="m-0 text-body font-semibold">
        {t("care.mca.section", { section: part })}
      </h3>
      {empty ? (
        <p className="m-0 text-text-secondary">{t("care.mca.empty", { part })}</p>
      ) : (
        children
      )}
    </section>
  );
}

/**
 * The consent, capacity and DoLS tab (register rows CARE-021 and CARE-022; hazards HZ-020 and
 * HZ-026): whether a valid consent is in place now for each decision, with the capacity found for
 * it, and the DoLS register with each authorisation's clock in words and dates. The capacity
 * assessments, best-interests decisions and consent records, and the forms, follow
 * (docs/plans/STATUS.md).
 */
async function CapacityTab({ params }: { readonly params: Params }) {
  const { id } = await params;
  const { person } = await getPerson(id);
  if (!person) return null;
  const { me } = await getShellContext();
  if (!can(me.permissions, "care.plan.read")) return <NoAccess />;
  const api = await tenantApi();
  const path = tabHref(id, "capacity");
  const query = { params: { path: { id } } };
  const [consents, dols, capacity, bestInterests] = await Promise.all([
    api.GET("/v1/people/{id}/consents", query).then((r) => readOrFail(r, path)),
    api.GET("/v1/people/{id}/dols", query).then((r) => readOrFail(r, path)),
    // Read to show the date and review date of the capacity finding for each decision.
    api.GET("/v1/people/{id}/capacity-assessments", query).then((r) => readOrFail(r, path)),
    api.GET("/v1/people/{id}/best-interests", query).then((r) => readOrFail(r, path)),
  ]);
  if (!consents || !dols || !capacity || !bestInterests) return <NoAccess />;
  const today = ukToday();
  const name = personNames(person).preferred;
  const renewed = renewedIds(dols.items);

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-eyebrow">{t("care.mca.title")}</h2>
        <p className="m-0 max-w-prose text-text-secondary">{t("care.mca.description", { name })}</p>
      </div>
      <Card as="section" title={t("care.mca.section", { section: "decisions" })} headingLevel={3}>
        <div className="flex flex-col gap-3">
          <p className="m-0 max-w-prose text-body-dense text-text-secondary">
            {t("care.mca.decisionsHint")}
          </p>
          <ConsentDecisions
            decisions={consents.decisions}
            records={consents.items}
            assessments={capacity.items}
            personName={name}
          />
        </div>
      </Card>
      <Part part="dols" empty={dols.items.length === 0}>
        {dols.items.map((item) => (
          <DolsCard key={item.id} item={item} renewed={renewed.has(item.id)} personId={id} />
        ))}
      </Part>
      <Part part="capacity" empty={capacity.items.length === 0}>
        {entryChains(capacity.items).map((chain) => (
          <CapacityCard key={chain.current.id} chain={chain} today={today} />
        ))}
      </Part>
      <Part part="bestInterests" empty={bestInterests.items.length === 0}>
        {entryChains(bestInterests.items).map((chain) => (
          <BestInterestsCard
            key={chain.current.id}
            chain={chain}
            assessments={capacity.items}
            today={today}
          />
        ))}
      </Part>
      <Part part="consents" empty={consents.items.length === 0}>
        {consents.items.map((item) => (
          <ConsentCard
            key={item.id}
            item={item}
            decisions={consents.decisions}
            assessments={capacity.items}
            bestInterests={bestInterests.items}
            personId={id}
            personName={name}
          />
        ))}
      </Part>
    </>
  );
}

/** The tab inside the record's frame: the point-of-care header, read again on every tab, and the tabs. */
export default async function CapacityPage(props: { readonly params: Params }) {
  const { id } = await props.params;
  return (
    <RecordFrame personId={id} tab="capacity">
      <CapacityTab {...props} />
    </RecordFrame>
  );
}
