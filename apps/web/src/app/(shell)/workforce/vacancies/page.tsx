import { buttonClassName, Card, EmptyState, PageHeader } from "@harbour/ui";
import { Briefcase } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { createVacancy } from "@/app/actions/workforce";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { WorkforceForm } from "@/components/workforce/WorkforceForm";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { t } from "@/lib/i18n";
import { codeLabel, recruitmentShown, ukDate } from "@/lib/workforce";

export const metadata: Metadata = { title: t("workforce.vacancies.title") };

/**
 * Vacancies and their applications (workforce.md section 2b; WORK-001). Applicants are people who
 * may never be employed: their names show only to holders of workforce.recruitment.manage.
 */
export default async function VacanciesPage() {
  const { me } = await getShellContext();
  const title = t("workforce.vacancies.title");
  if (!recruitmentShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const [vacancies, templates] = await Promise.all([
    api.GET("/v1/workforce/vacancies"),
    api.GET("/v1/workforce/job-templates"),
  ]);
  if (!vacancies.data) failWith(vacancies.error, vacancies.response, "/workforce/vacancies");
  if (!templates.data) failWith(templates.error, templates.response, "/workforce/vacancies");
  const live = templates.data.items.filter((tpl) => !tpl.archived);
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={me.tenant.name}
        title={title}
        description={t("workforce.vacancies.description")}
        primaryAction={
          <Link
            href="/workforce/job-templates"
            className={buttonClassName({ variant: "secondary" })}
          >
            {t("workforce.templates.title")}
          </Link>
        }
      />
      {vacancies.data.items.length === 0 ? (
        <Card>
          <EmptyState
            headingLevel={2}
            icon={<Briefcase size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("workforce.vacancies.empty")}
          />
        </Card>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {vacancies.data.items.map((vacancy) => (
            <li key={vacancy.id}>
              <Card>
                <div className="flex flex-col gap-2">
                  <h2 className="m-0 text-body font-semibold">
                    <Link
                      href={`/workforce/vacancies/${vacancy.id}`}
                      className="inline-flex min-h-target items-center underline"
                    >
                      {vacancy.title}
                    </Link>
                  </h2>
                  <p className="m-0 text-body-dense text-text-secondary">
                    {t("workforce.vacancies.summary", {
                      opens: ukDate(vacancy.opensOn),
                      applications: Object.values(vacancy.counts).reduce((a, b) => a + b, 0),
                    })}
                  </p>
                  <p className="m-0">
                    <SafetyChip
                      chip={{
                        status: vacancy.status === "open" ? "info" : "neutral",
                        icon: vacancy.status === "open" ? "clock" : "circle-minus",
                        label: codeLabel("workforce.vacancies.status", vacancy.status, t),
                      }}
                    />
                  </p>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <Card>
        {live.length === 0 ? (
          <p className="m-0 text-body-dense">{t("workforce.vacancies.needTemplate")}</p>
        ) : (
          <WorkforceForm
            headingLevel={2}
            title={t("workforce.vacancies.new")}
            path="/workforce/vacancies"
            submit={t("workforce.vacancies.create")}
            done={t("workforce.vacancies.created")}
            action={createVacancy}
            fields={[
              {
                kind: "select",
                name: "jobTemplateId",
                label: t("workforce.vacancies.fieldTemplate"),
                required: true,
                emptyOption: t("workforce.form.choose"),
                options: live.map((tpl) => ({ value: tpl.id, label: tpl.title })),
              },
              {
                kind: "text",
                name: "title",
                label: t("workforce.vacancies.fieldTitle"),
                required: true,
                maxLength: 120,
              },
              {
                kind: "select",
                name: "locationId",
                label: t("workforce.vacancies.fieldLocation"),
                emptyOption: t("workforce.vacancies.anyLocation"),
                options: me.locations.map((l) => ({ value: l.id, label: l.name })),
              },
              {
                kind: "text",
                name: "positions",
                label: t("workforce.vacancies.fieldPositions"),
                inputMode: "numeric",
                maxLength: 2,
              },
              {
                kind: "date",
                name: "opensOn",
                label: t("workforce.vacancies.fieldOpens"),
                required: true,
              },
              { kind: "date", name: "closesOn", label: t("workforce.vacancies.fieldCloses") },
              { kind: "checkbox", name: "open", label: t("workforce.vacancies.fieldOpenNow") },
            ]}
          />
        )}
      </Card>
    </div>
  );
}
