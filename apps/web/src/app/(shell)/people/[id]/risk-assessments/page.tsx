import { Button, Card, SelectField } from "@harbour/ui";
import type { Metadata } from "next";
import { ArrivalNotice } from "@/components/care/ArrivalNotice";
import { NoAccess } from "@/components/care/NoAccess";
import { ReadOnlyNotice } from "@/components/care/ReadOnlyNotice";
import { RecordFrame } from "@/components/care/RecordFrame";
import { RiskCard } from "@/components/care/RiskCard";
import { RiskForm } from "@/components/care/RiskForm";
import { getShellContext, tenantApi } from "@/lib/api";
import { can, tabHref, writeAccess } from "@/lib/care-record";
import { t } from "@/lib/i18n";
import { personNames } from "@/lib/people";
import { getPerson, readOrFail } from "@/lib/person-record";
import { recordMetadata } from "@/lib/record-metadata";
import { ukToday } from "@/lib/uk-time";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/** The page title names the tab, never the person. */
export async function generateMetadata(): Promise<Metadata> {
  return recordMetadata("risk-assessments");
}

/**
 * The risk assessments tab (register row CARE-002; hazards HZ-024 and HZ-025): the templates, a
 * form for a new assessment or a review, and the assessments in use and closed.
 */
async function RiskAssessmentsTab({
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
  const path = tabHref(id, "risk-assessments");
  const api = await tenantApi();
  const [templates, list] = await Promise.all([
    api.GET("/v1/care/risk-templates").then((r) => readOrFail(r, path)),
    api
      .GET("/v1/people/{id}/risk-assessments", {
        params: { path: { id }, query: { status: "all" } },
      })
      .then((r) => readOrFail(r, path)),
  ]);
  if (!templates || !list) return <NoAccess />;
  const query = await searchParams;
  const names = personNames(person);
  const today = ukToday();
  // Add, review or close a risk only where care.plan.write reaches the person (round 3).
  const { canWrite, readOnlyNotice } = writeAccess(person, me.permissions, "care.plan.write");
  const templateFor = (key: string) => templates.items.find((template) => template.key === key);
  const reviewing = list.items.find(
    (item) => item.id === first(query.review) && item.status === "active",
  );
  const starting = reviewing ? undefined : templateFor(first(query.template) ?? "");
  const formTemplate = reviewing ? templateFor(reviewing.templateKey) : starting;
  const active = list.items.filter((item) => item.status === "active");
  const closed = list.items.filter((item) => item.status === "closed");

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-eyebrow">{t("care.risk.title")}</h2>
        <p className="m-0 max-w-prose text-text-secondary">
          {t("care.risk.description", { name: names.preferred })}
        </p>
      </div>

      {first(query.saved) ? <ArrivalNotice>{t("care.risk.form.saved")}</ArrivalNotice> : null}
      {first(query.closed) ? <ArrivalNotice>{t("care.risk.close.arrived")}</ArrivalNotice> : null}

      {readOnlyNotice ? <ReadOnlyNotice text={t(readOnlyNotice)} /> : null}
      {canWrite && !formTemplate ? (
        <Card as="section" title={t("care.risk.add")} headingLevel={3}>
          <form method="get" action={path} className="flex flex-wrap items-end gap-3">
            <SelectField
              name="template"
              label={t("care.risk.template")}
              emptyOption={t("care.risk.templateEmpty")}
              required
              options={templates.items.map((template) => ({
                value: template.key,
                label: template.title,
              }))}
              className="w-full max-w-64"
            />
            <Button type="submit" variant="secondary">
              {t("care.risk.start")}
            </Button>
          </form>
        </Card>
      ) : null}

      {canWrite && formTemplate ? (
        <Card
          as="section"
          title={reviewing ? t("care.risk.review.title") : formTemplate.title}
          description={reviewing ? formTemplate.title : undefined}
          headingLevel={3}
        >
          <RiskForm
            personId={id}
            template={formTemplate}
            matrix={templates.matrix}
            name={names.preferred}
            today={today}
            {...(reviewing ? { existing: reviewing } : {})}
          />
        </Card>
      ) : null}

      <section aria-labelledby="risks-in-use" className="flex flex-col gap-3">
        <h3 id="risks-in-use" className="m-0 text-body font-semibold">
          {t("care.risk.active.title")}
        </h3>
        {active.length === 0 ? (
          <p className="m-0 text-text-secondary">{t("care.risk.empty")}</p>
        ) : (
          active.map((item) => (
            <RiskCard
              key={item.id}
              item={item}
              template={templateFor(item.templateKey)}
              personId={id}
              name={names.preferred}
              today={today}
              canWrite={canWrite}
            />
          ))
        )}
      </section>
      {closed.length > 0 ? (
        <section aria-labelledby="risks-closed" className="flex flex-col gap-3">
          <h3 id="risks-closed" className="m-0 text-body font-semibold">
            {t("care.risk.closed.title")}
          </h3>
          {closed.map((item) => (
            <RiskCard
              key={item.id}
              item={item}
              template={templateFor(item.templateKey)}
              personId={id}
              name={names.preferred}
              today={today}
              canWrite={false}
            />
          ))}
        </section>
      ) : null}
    </>
  );
}

/** The tab inside the record's frame: the point-of-care header, read again on every tab, and the tabs. */
export default async function RiskAssessmentsPage(props: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await props.params;
  return (
    <RecordFrame personId={id} tab="risk-assessments">
      <RiskAssessmentsTab {...props} />
    </RecordFrame>
  );
}
