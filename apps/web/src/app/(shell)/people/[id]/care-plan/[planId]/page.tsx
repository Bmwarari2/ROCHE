import { ButtonLink, Card } from "@harbour/ui";
import { History, PencilLine } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CarePlanView } from "@/components/care/CarePlanView";
import { NoAccess } from "@/components/care/NoAccess";
import { Notice } from "@/components/care/Notice";
import { PlanStatus } from "@/components/care/PlanStatus";
import { PublishPlan } from "@/components/care/PublishPlan";
import { ReadOnlyNotice } from "@/components/care/ReadOnlyNotice";
import { RecordFrame } from "@/components/care/RecordFrame";
import { SectionEditor } from "@/components/care/SectionEditor";
import { getShellContext, problemCode, tenantApi } from "@/lib/api";
import { PCSP_DOMAINS, planVersions } from "@/lib/care-plan";
import { can, tabHref, writeAccess } from "@/lib/care-record";
import { isUuid } from "@/lib/context-cookies";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { personNames } from "@/lib/people";
import { getPerson, readOrFail } from "@/lib/person-record";
import { recordMetadata } from "@/lib/record-metadata";

type Params = Promise<{ id: string; planId: string }>;

/** The page title names the tab and that this is one version of the plan, never the person. */
export async function generateMetadata(): Promise<Metadata> {
  return recordMetadata("care-plan", t("care.title.planVersion"));
}

/**
 * One version of a care plan. A draft is labelled as not in use, with the plan in use one tap
 * away, and can be edited and published by staff who write care plans; a superseded version is
 * labelled as no longer in use (HZ-024).
 */
async function CarePlanVersionTab({ params }: { readonly params: Params }) {
  const { id, planId } = await params;
  const { person } = await getPerson(id);
  if (!person) return null;
  if (!isUuid(planId)) notFound();
  const { me } = await getShellContext();
  if (!can(me.permissions, "care.plan.read")) return <NoAccess />;
  const path = tabHref(id, "care-plan");
  const api = await tenantApi();
  const result = await api.GET("/v1/people/{id}/care-plans/{planId}", {
    params: { path: { id, planId } },
  });
  if (problemCode(result.error) === "not_found") notFound();
  const plan = readOrFail(result, path);
  if (!plan) return <NoAccess />;
  const list = readOrFail(
    await api.GET("/v1/people/{id}/care-plans", { params: { path: { id } } }),
    path,
  );
  const active = list ? planVersions(list.items).active : null;
  const names = personNames(person);
  // Edit or publish a draft only where care.plan.write reaches the person (review round 3).
  const { canWrite, readOnlyNotice } = writeAccess(person, me.permissions, "care.plan.write");

  const inUseLink =
    active && active.id !== plan.id ? (
      <ButtonLink href={`${path}/${active.id}`} variant="secondary">
        {t("care.plan.viewInUse")}
      </ButtonLink>
    ) : null;

  return (
    <>
      <p className="m-0 text-body-dense">
        <Link href={path}>{t("care.plan.title")}</Link>
      </p>
      <h2 className="m-0 text-eyebrow">{t("care.plan.title")}</h2>

      {plan.status === "draft" ? (
        <Notice
          icon={<PencilLine size={20} strokeWidth={1.5} />}
          title={t("care.plan.draftBanner.title")}
          action={inUseLink}
        >
          {t("care.plan.draftBanner.body")}
          {active ? null : <span className="block">{t("care.plan.noInUse")}</span>}
        </Notice>
      ) : null}
      {plan.status === "superseded" ? (
        <Notice
          tone="warning"
          icon={<History size={20} strokeWidth={1.5} />}
          title={t("care.plan.supersededBanner.title")}
          action={inUseLink}
        >
          {t("care.plan.supersededBanner.body", {
            date: formatDateTime(plan.supersededAt) ?? "",
          })}
        </Notice>
      ) : null}

      {plan.status === "draft" && readOnlyNotice ? (
        <ReadOnlyNotice text={t(readOnlyNotice)} />
      ) : null}
      {plan.status === "draft" && canWrite ? (
        <section aria-labelledby="edit-draft" className="flex flex-col gap-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex max-w-prose flex-col gap-1">
              <div className="flex flex-wrap items-center gap-3">
                <h3 id="edit-draft" className="m-0 text-intro font-semibold">
                  {t("care.plan.edit.title")}
                </h3>
                <PlanStatus status={plan.status} />
              </div>
              <p className="m-0 text-text-secondary">
                {t("care.plan.edit.description", { name: names.preferred })}
              </p>
              <p className="m-0 text-body-dense">
                {t("care.plan.edit.written", {
                  count: plan.sections.filter((s) => s.need?.trim() || s.outcome?.trim()).length,
                })}
              </p>
            </div>
            <PublishPlan
              personId={id}
              planId={plan.id}
              version={plan.version}
              name={names.preferred}
            />
          </div>
          <div className="flex flex-col gap-3">
            {PCSP_DOMAINS.map((domain) => (
              <SectionEditor
                key={domain}
                personId={id}
                planId={plan.id}
                domain={domain}
                section={plan.sections.find((s) => s.domain === domain) ?? null}
                name={names.preferred}
              />
            ))}
          </div>
        </section>
      ) : (
        <Card>
          {plan.status === "draft" ? (
            <p className="m-0 mb-4 text-text-secondary">{t("care.plan.readOnlyDraft")}</p>
          ) : null}
          <CarePlanView plan={plan} name={names.preferred} headingLevel={3} />
        </Card>
      )}
    </>
  );
}

/** The tab inside the record's frame: the point-of-care header, read again on every tab, and the tabs. */
export default async function CarePlanVersionPage(props: { readonly params: Params }) {
  const { id } = await props.params;
  return (
    <RecordFrame personId={id} tab="care-plan">
      <CarePlanVersionTab {...props} />
    </RecordFrame>
  );
}
