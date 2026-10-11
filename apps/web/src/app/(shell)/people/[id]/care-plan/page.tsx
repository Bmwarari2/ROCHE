import { ButtonLink, Card, EmptyState, StatusChip } from "@harbour/ui";
import { ClipboardList, PencilLine, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ArrivalNotice } from "@/components/care/ArrivalNotice";
import { CarePlanView } from "@/components/care/CarePlanView";
import { NoAccess } from "@/components/care/NoAccess";
import { Notice } from "@/components/care/Notice";
import { PlanStatus } from "@/components/care/PlanStatus";
import { RecordFrame } from "@/components/care/RecordFrame";
import { StartDraftButton } from "@/components/care/StartDraftButton";
import { getShellContext, tenantApi } from "@/lib/api";
import { planVersions } from "@/lib/care-plan";
import { can, tabHref } from "@/lib/care-record";
import { formatDate, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { personNames } from "@/lib/people";
import { getPerson, readOrFail } from "@/lib/person-record";
import { recordMetadata } from "@/lib/record-metadata";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** The page title names the tab, never the person. */
export async function generateMetadata(): Promise<Metadata> {
  return recordMetadata("care-plan");
}

/**
 * The care plan tab (care.md rules 1 and 2; register row CARE-001; hazard HZ-024): the plan in use
 * by need domain, what is due, and every version with its status in word and icon. A draft is
 * never shown as the plan in use.
 */
async function CarePlanTab({
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
  if (!can(me.permissions, "care.plan.read")) return <NoAccess />;
  const path = tabHref(id, "care-plan");
  const api = await tenantApi();
  const list = readOrFail(
    await api.GET("/v1/people/{id}/care-plans", { params: { path: { id } } }),
    path,
  );
  if (!list) return <NoAccess />;
  const versions = planVersions(list.items);
  const active = versions.active
    ? readOrFail(
        await api.GET("/v1/people/{id}/care-plans/{planId}", {
          params: { path: { id, planId: versions.active.id } },
        }),
        path,
      )
    : null;
  const names = personNames(person);
  const canWrite = can(me.permissions, "care.plan.write");
  const published = (await searchParams).published === "1";

  return (
    <>
      <h2 className="m-0 text-eyebrow">{t("care.plan.title")}</h2>
      {published ? <ArrivalNotice>{t("care.plan.published.toast")}</ArrivalNotice> : null}
      {list.due ? (
        <p className="m-0 flex flex-wrap items-center gap-2">
          {list.due.overdue ? (
            <StatusChip status="overdue" label={t("care.plan.due.overdue")} icon={TriangleAlert} />
          ) : null}
          <span>
            {list.due.dueOn
              ? t(`care.plan.due.${list.due.kind}`, { date: formatDate(list.due.dueOn) ?? "" })
              : t("care.plan.due.noDate")}
          </span>
        </p>
      ) : null}
      {versions.draft ? (
        <Notice
          icon={<PencilLine size={20} strokeWidth={1.5} />}
          title={t("care.plan.draftBanner.title")}
          action={
            <ButtonLink href={`${path}/${versions.draft.id}`} variant="secondary">
              {t("care.plan.continueDraft")}
            </ButtonLink>
          }
        >
          {t("care.plan.draftBanner.body")}
        </Notice>
      ) : canWrite ? (
        <StartDraftButton
          personId={id}
          label={active ? t("care.plan.revise") : t("care.plan.start")}
        />
      ) : null}

      <section aria-labelledby="plan-in-use" className="flex flex-col gap-4">
        <h3 id="plan-in-use" className="m-0 text-body font-semibold">
          {t("care.plan.inUse")}
        </h3>
        {active ? (
          <Card>
            <CarePlanView plan={active} name={names.preferred} headingLevel={3} />
          </Card>
        ) : (
          <EmptyState
            headingLevel={4}
            icon={<ClipboardList size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("care.plan.none.title")}
            description={t("care.plan.none.body", { name: names.preferred })}
          />
        )}
      </section>

      {list.items.length > 0 ? (
        <section aria-labelledby="plan-versions" className="flex flex-col gap-3">
          <h3 id="plan-versions" className="m-0 text-body font-semibold">
            {t("care.plan.versions.title")}
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-callout">
              <caption className="hb-visually-hidden">
                {t("care.plan.versions.caption", { name: names.preferred })}
              </caption>
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className="py-2 pe-4 text-start font-semibold">
                    {t("care.plan.versions.version")}
                  </th>
                  <th scope="col" className="py-2 pe-4 text-start font-semibold">
                    {t("care.plan.versions.status")}
                  </th>
                  <th scope="col" className="py-2 pe-4 text-start font-semibold">
                    {t("care.plan.versions.published")}
                  </th>
                  <th scope="col" className="py-2 pe-4 text-start font-semibold">
                    {t("care.plan.versions.reviewDue")}
                  </th>
                  <th scope="col" className="py-2 text-start font-semibold">
                    {t("care.plan.versions.open")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((plan) => (
                  <tr key={plan.id} className="border-b border-border last:border-b-0">
                    <th scope="row" className="py-2 pe-4 text-start font-normal">
                      {plan.publishedVersion
                        ? t("care.plan.version", { version: plan.publishedVersion })
                        : t("care.plan.draftName")}
                    </th>
                    <td className="py-2 pe-4">
                      <PlanStatus status={plan.status} />
                    </td>
                    <td className="py-2 pe-4">{formatDateTime(plan.publishedAt) ?? "–"}</td>
                    <td className="py-2 pe-4">{formatDate(plan.reviewDueOn) ?? "–"}</td>
                    <td className="py-2">
                      <Link href={`${path}/${plan.id}`}>
                        {t("care.plan.versions.view", {
                          status: plan.status,
                          version: plan.publishedVersion ?? 0,
                        })}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </>
  );
}

/** The tab inside the record's frame: the point-of-care header, read again on every tab, and the tabs. */
export default async function CarePlanPage(props: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await props.params;
  return (
    <RecordFrame personId={id} tab="care-plan">
      <CarePlanTab {...props} />
    </RecordFrame>
  );
}
