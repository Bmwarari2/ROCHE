import { Card } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { PlanStatus } from "@/components/care/PlanStatus";
import { RecordFrame } from "@/components/care/RecordFrame";
import { VersionList } from "@/components/care/VersionList";
import { getShellContext, tenantApi } from "@/lib/api";
import { can, tabHref } from "@/lib/care-record";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { personNames } from "@/lib/people";
import { getPerson, readOrFail } from "@/lib/person-record";
import { recordMetadata } from "@/lib/record-metadata";

type Params = Promise<{ id: string }>;

/** The page title names the tab, never the person. */
export async function generateMetadata(): Promise<Metadata> {
  return recordMetadata("history");
}

/**
 * The history tab: earlier versions of the person's details, and a way into the history of every
 * care plan version, risk assessment and advance care record. Notes, chart entries and marks keep
 * their corrections in their own tabs.
 */
async function HistoryTab({ params }: { readonly params: Params }) {
  const { id } = await params;
  const { person } = await getPerson(id);
  if (!person) return null;
  const { me } = await getShellContext();
  const path = tabHref(id, "history");
  const api = await tenantApi();
  const readPlan = can(me.permissions, "care.plan.read");
  const [personHistory, plans, risks, advance] = await Promise.all([
    api
      .GET("/v1/people/{id}/history", { params: { path: { id } } })
      .then((r) => readOrFail(r, path)),
    readPlan
      ? api
          .GET("/v1/people/{id}/care-plans", { params: { path: { id } } })
          .then((r) => readOrFail(r, path))
      : null,
    readPlan
      ? api
          .GET("/v1/people/{id}/risk-assessments", {
            params: { path: { id }, query: { status: "all" } },
          })
          .then((r) => readOrFail(r, path))
      : null,
    readPlan
      ? api
          .GET("/v1/people/{id}/advance-care", {
            params: { path: { id }, query: { includeInactive: "true" } },
          })
          .then((r) => readOrFail(r, path))
      : null,
  ]);
  const names = personNames(person);
  const historyLink = (table: string, recordId: string, record: string) => (
    <Link href={`${path}/${table}/${recordId}`}>{t("care.history.view", { record })}</Link>
  );

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-eyebrow">{t("care.history.title")}</h2>
        <p className="m-0 max-w-prose text-text-secondary">
          {t("care.history.description", { name: names.preferred })}
        </p>
      </div>
      {readPlan ? (
        <Card as="section" title={t("care.history.records.title")} headingLevel={3}>
          <div className="flex flex-col gap-6">
            <section aria-labelledby="history-plans" className="flex flex-col gap-2">
              <h4 id="history-plans" className="m-0 text-body font-semibold">
                {t("care.history.records.carePlans")}
              </h4>
              {plans && plans.items.length > 0 ? (
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {plans.items.map((plan) => {
                    const name = plan.publishedVersion
                      ? t("care.plan.version", { version: plan.publishedVersion })
                      : t("care.plan.draftName");
                    return (
                      <li key={plan.id} className="flex flex-wrap items-center gap-3">
                        <span className="font-semibold">{name}</span>
                        <PlanStatus status={plan.status} />
                        {historyLink("care_plan", plan.id, name)}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="m-0 text-text-secondary">{t("care.history.records.none")}</p>
              )}
            </section>
            <section aria-labelledby="history-risks" className="flex flex-col gap-2">
              <h4 id="history-risks" className="m-0 text-body font-semibold">
                {t("care.history.records.risks")}
              </h4>
              {risks && risks.items.length > 0 ? (
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {risks.items.map((risk) => (
                    <li key={risk.id} className="flex flex-wrap items-center gap-3">
                      <span className="font-semibold">{risk.hazard}</span>
                      <span className="text-callout text-text-secondary">
                        {t("care.risk.assessedOn", { date: formatDate(risk.assessedOn) ?? "" })}
                      </span>
                      {historyLink("risk_assessment", risk.id, risk.hazard)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="m-0 text-text-secondary">{t("care.history.records.none")}</p>
              )}
            </section>
            <section aria-labelledby="history-advance" className="flex flex-col gap-2">
              <h4 id="history-advance" className="m-0 text-body font-semibold">
                {t("care.history.records.advance")}
              </h4>
              {advance && advance.items.length > 0 ? (
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {advance.items.map((record) => {
                    const name = t("care.advance.kind", { kind: record.kind });
                    return (
                      <li key={record.id} className="flex flex-wrap items-center gap-3">
                        <span className="font-semibold">{name}</span>
                        <span className="text-callout text-text-secondary">
                          {t("care.advance.status", { status: record.status })}
                        </span>
                        {historyLink("advance_care_record", record.id, name)}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="m-0 text-text-secondary">{t("care.history.records.none")}</p>
              )}
            </section>
          </div>
        </Card>
      ) : null}
      {personHistory ? (
        <section aria-labelledby="history-person" className="flex flex-col gap-3">
          <h3 id="history-person" className="m-0 text-body font-semibold">
            {t("care.history.person.title")}
          </h3>
          <VersionList
            history={personHistory}
            tenantUserId={me.tenantUserId}
            label={t("care.history.person.title")}
          />
        </section>
      ) : null}
    </>
  );
}

/** The tab inside the record's frame: the point-of-care header, read again on every tab, and the tabs. */
export default async function HistoryPage(props: { readonly params: Params }) {
  const { id } = await props.params;
  return (
    <RecordFrame personId={id} tab="history">
      <HistoryTab {...props} />
    </RecordFrame>
  );
}
