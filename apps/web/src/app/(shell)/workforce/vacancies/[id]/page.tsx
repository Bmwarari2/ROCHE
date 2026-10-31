import { Card, EmptyState, PageHeader } from "@harbour/ui";
import { Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { addApplication, changeVacancyStatus } from "@/app/actions/workforce";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { WorkforceForm } from "@/components/workforce/WorkforceForm";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { codeLabel, codeOptions, recruitmentShown, stageChip } from "@/lib/workforce";

export const metadata: Metadata = { title: t("workforce.vacancies.one") };

/**
 * One vacancy (WORK-001): its applications by stage, a new application, its status, and once it
 * has closed, the equality monitoring counts (small numbers never shown; workforce.md rule 12).
 */
export default async function VacancyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { me } = await getShellContext();
  const title = t("workforce.vacancies.one");
  if (!recruitmentShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const [vacancies, applications] = await Promise.all([
    api.GET("/v1/workforce/vacancies"),
    api.GET("/v1/workforce/vacancies/{id}/applications", { params: { path: { id } } }),
  ]);
  if (!vacancies.data) failWith(vacancies.error, vacancies.response, `/workforce/vacancies/${id}`);
  const vacancy = vacancies.data.items.find((v) => v.id === id);
  if (!vacancy) notFound();
  if (!applications.data)
    failWith(applications.error, applications.response, `/workforce/vacancies/${id}`);
  const closed = vacancy.status !== "open" && vacancy.status !== "draft";
  const counts = closed
    ? await api.GET("/v1/workforce/vacancies/{id}/equality-monitoring", {
        params: { path: { id } },
      })
    : null;
  const path = `/workforce/vacancies/${id}`;
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={t("workforce.vacancies.title")}
        title={vacancy.title}
        description={codeLabel("workforce.vacancies.status", vacancy.status, t)}
      />
      <section aria-labelledby="applications" className="flex flex-col gap-3">
        <h2 id="applications" className="m-0 text-heading-3 font-semibold">
          {t("workforce.applications.title")}
        </h2>
        {applications.data.items.length === 0 ? (
          <Card>
            <EmptyState
              headingLevel={3}
              icon={<Users size={32} strokeWidth={1.5} aria-hidden="true" />}
              title={t("workforce.applications.empty")}
            />
          </Card>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {applications.data.items.map((application) => (
              <li key={application.id}>
                <Card>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link
                      href={`/workforce/applications/${application.id}`}
                      className="inline-flex min-h-target items-center font-semibold underline"
                    >
                      {application.applicantName ?? t("workforce.applications.redacted")}
                    </Link>
                    <SafetyChip chip={stageChip(application.stage, t)} />
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
      {vacancy.status === "open" ? (
        <Card>
          <WorkforceForm
            headingLevel={2}
            title={t("workforce.applications.new")}
            intro={t("workforce.applications.newIntro")}
            path={path}
            submit={t("workforce.applications.add")}
            done={t("workforce.applications.added")}
            action={addApplication.bind(null, id)}
            fields={[
              {
                kind: "text",
                name: "givenName",
                label: t("workforce.applications.givenName"),
                required: true,
                maxLength: 100,
              },
              {
                kind: "text",
                name: "familyName",
                label: t("workforce.applications.familyName"),
                required: true,
                maxLength: 100,
              },
              {
                kind: "text",
                name: "email",
                label: t("workforce.applications.email"),
                maxLength: 254,
              },
              {
                kind: "text",
                name: "phone",
                label: t("workforce.applications.phone"),
                maxLength: 40,
              },
            ]}
          />
        </Card>
      ) : null}
      <Card>
        <WorkforceForm
          headingLevel={2}
          title={t("workforce.vacancies.changeStatus")}
          path={path}
          submit={t("workforce.vacancies.saveStatus")}
          done={t("workforce.vacancies.statusSaved")}
          action={changeVacancyStatus.bind(null, id, vacancy.version)}
          fields={[
            {
              kind: "select",
              name: "status",
              label: t("workforce.vacancies.fieldStatus"),
              required: true,
              emptyOption: t("workforce.form.choose"),
              options: codeOptions(
                ["draft", "open", "closed", "filled", "withdrawn"],
                "workforce.vacancies.status",
                t,
              ),
            },
          ]}
        />
      </Card>
      {counts?.data ? (
        <section aria-labelledby="monitoring" className="flex flex-col gap-3">
          <h2 id="monitoring" className="m-0 text-heading-3 font-semibold">
            {t("workforce.monitoring.title")}
          </h2>
          <Card>
            <p className="m-0 text-body-dense">
              {counts.data.forms === "fewer_than_min"
                ? t("workforce.monitoring.fewForms", { min: counts.data.minimumShown })
                : t("workforce.monitoring.forms", { count: counts.data.forms })}
            </p>
            <dl className="m-0 mt-3 flex flex-col gap-2">
              {counts.data.questions.map((q) => (
                <div key={q.question} className="flex flex-col">
                  <dt className="font-semibold">
                    {codeLabel("workforce.monitoring.question", q.question, t)}
                  </dt>
                  <dd className="m-0 text-body-dense">
                    {q.counts === null
                      ? t("workforce.monitoring.withheld")
                      : Object.entries(q.counts)
                          .map(([answer, n]) =>
                            t("workforce.monitoring.count", {
                              answer: codeLabel("workforce.monitoring.answer", answer, t),
                              count: n === "fewer_than_min" ? -1 : n,
                              min: counts.data.minimumShown,
                            }),
                          )
                          .join(", ")}
                  </dd>
                </div>
              ))}
            </dl>
          </Card>
        </section>
      ) : null}
    </div>
  );
}
