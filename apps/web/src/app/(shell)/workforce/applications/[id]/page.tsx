import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  closeApplication,
  makeOffer,
  recordInterview,
  respondToOffer,
  shortlistApplication,
} from "@/app/actions/workforce";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { WorkforceForm } from "@/components/workforce/WorkforceForm";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import {
  codeLabel,
  codeOptions,
  present,
  recruitmentShown,
  stageChip,
  ukDate,
} from "@/lib/workforce";

export const metadata: Metadata = { title: t("workforce.applications.one") };

const CLOSING = [
  "criteria_not_met",
  "not_selected_after_interview",
  "position_filled",
  "vacancy_withdrawn",
  "applicant_withdrew",
  "pre_employment_checks_failed",
];

/**
 * One application (workforce.md rule 11; WORK-001): shortlisting against each essential
 * criterion, values-based interviews scored 1 to 4 (the total shown, never deciding), the
 * conditional offer and its response. Each step is offered only at the stage that allows it.
 */
export default async function ApplicationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { me } = await getShellContext();
  const title = t("workforce.applications.one");
  if (!recruitmentShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const found = await api.GET("/v1/workforce/applications/{id}", { params: { path: { id } } });
  if (!found.data) failWith(found.error, found.response, `/workforce/applications/${id}`);
  const detail = found.data;
  const app = detail.application;
  const [vacancies, templates, colleagues] = await Promise.all([
    api.GET("/v1/workforce/vacancies"),
    api.GET("/v1/workforce/job-templates"),
    api.GET("/v1/workforce/colleagues"),
  ]);
  const vacancy = vacancies.data?.items.find((v) => v.id === app.vacancyId);
  const template = templates.data?.items.find((tpl) => tpl.id === vacancy?.jobTemplateId);
  const staff = present(colleagues.data?.items).map((c) => ({ value: c.id, label: c.displayName }));
  const path = `/workforce/applications/${id}`;
  const name = app.applicantName ?? t("workforce.applications.redacted");
  const closedStage = ["accepted", "rejected", "withdrawn", "declined"].includes(app.stage);
  const scoreOptions = ["1", "2", "3", "4"].map((v) => ({ value: v, label: v }));
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader eyebrow={vacancy?.title ?? t("workforce.vacancies.one")} title={name} />
      <Card>
        <div className="flex flex-col gap-2">
          <p className="m-0">
            <SafetyChip chip={stageChip(app.stage, t)} />
          </p>
          {app.stageReason ? (
            <p className="m-0 text-body-dense">
              {codeLabel("workforce.recruitment.reason", app.stageReason, t)}
            </p>
          ) : null}
          {detail.applicant.email ? (
            <p className="m-0 text-body-dense">{detail.applicant.email}</p>
          ) : null}
          {detail.applicant.retainUntil ? (
            <p className="m-0 text-body-dense text-text-secondary">
              {t("workforce.applications.retainUntil", {
                date: ukDate(detail.applicant.retainUntil),
              })}
            </p>
          ) : null}
        </div>
      </Card>
      {detail.interviews.length > 0 ? (
        <section aria-labelledby="interviews" className="flex flex-col gap-3">
          <h2 id="interviews" className="m-0 text-heading-3 font-semibold">
            {t("workforce.interviews.title")}
          </h2>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {detail.interviews.map((i) => (
              <li key={i.id}>
                <Card>
                  <p className="m-0 text-body-dense">
                    {t("workforce.interviews.summary", {
                      date: ukDate(i.heldOn),
                      total: i.total,
                      outOf: i.outOf,
                      recommendation: codeLabel(
                        "workforce.interviews.recommendation",
                        i.recommendation,
                        t,
                      ),
                    })}
                  </p>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {app.stage === "applied" && template ? (
        <Card>
          <WorkforceForm
            headingLevel={2}
            title={t("workforce.applications.shortlist")}
            intro={t("workforce.applications.shortlistIntro")}
            path={path}
            submit={t("workforce.applications.saveShortlist")}
            done={t("workforce.applications.shortlistSaved")}
            action={shortlistApplication.bind(
              null,
              id,
              app.version,
              template.essentialCriteria.length,
            )}
            fields={template.essentialCriteria.map((criterion, i) => ({
              kind: "checkbox" as const,
              name: `criterion${i}`,
              label: t("workforce.applications.criterionMet", { criterion }),
            }))}
          />
        </Card>
      ) : null}
      {(app.stage === "shortlisted" || app.stage === "interviewed") && template ? (
        <Card>
          <WorkforceForm
            headingLevel={2}
            title={t("workforce.interviews.new")}
            intro={t("workforce.interviews.newIntro")}
            path={path}
            submit={t("workforce.interviews.record")}
            done={t("workforce.interviews.recorded")}
            action={recordInterview.bind(
              null,
              id,
              app.version,
              template.valuesQuestions.map((q) => q.key),
            )}
            fields={[
              {
                kind: "date",
                name: "heldOn",
                label: t("workforce.interviews.heldOn"),
                required: true,
              },
              ...[1, 2, 3].map((n) => ({
                kind: "select" as const,
                name: `panel${n}`,
                label: t("workforce.interviews.panelMember", { n }),
                required: n === 1,
                emptyOption: t("workforce.form.choose"),
                options: staff,
              })),
              ...template.valuesQuestions.map((q) => ({
                kind: "select" as const,
                name: `score_${q.key}`,
                label: q.question,
                hint: t("workforce.interviews.scoreHint"),
                required: true,
                emptyOption: t("workforce.form.choose"),
                options: scoreOptions,
              })),
              {
                kind: "select" as const,
                name: "recommendation",
                label: t("workforce.interviews.recommendationLabel"),
                required: true,
                emptyOption: t("workforce.form.choose"),
                options: codeOptions(
                  ["proceed", "do_not_proceed"],
                  "workforce.interviews.recommendation",
                  t,
                ),
              },
              {
                kind: "textarea" as const,
                name: "notes",
                label: t("workforce.interviews.notes"),
                maxLength: 4000,
              },
            ]}
          />
        </Card>
      ) : null}
      {app.stage === "interviewed" ? (
        <Card>
          <WorkforceForm
            headingLevel={2}
            title={t("workforce.offers.new")}
            intro={t("workforce.offers.newIntro")}
            path={path}
            submit={t("workforce.offers.make")}
            done={t("workforce.offers.made")}
            action={makeOffer.bind(null, id, app.version)}
            fields={[
              { kind: "date", name: "proposedStartOn", label: t("workforce.offers.proposedStart") },
              {
                kind: "checkbox",
                name: "previousCareWork",
                label: t("workforce.offers.previousCareWork"),
              },
            ]}
          />
        </Card>
      ) : null}
      {detail.offer && detail.offer.status === "made" ? (
        <Card>
          <WorkforceForm
            headingLevel={2}
            title={t("workforce.offers.response")}
            intro={t("workforce.offers.conditions", {
              conditions: detail.offer.conditions
                .map((c) => t(`workforce.schedule3.${c}`))
                .join(", "),
            })}
            path={path}
            submit={t("workforce.offers.saveResponse")}
            done={t("workforce.offers.responseSaved")}
            action={respondToOffer.bind(null, detail.offer.id, detail.offer.version)}
            fields={[
              {
                kind: "select",
                name: "response",
                label: t("workforce.offers.responseLabel"),
                required: true,
                emptyOption: t("workforce.form.choose"),
                options: codeOptions(
                  ["accepted", "declined", "withdrawn"],
                  "workforce.offers.status",
                  t,
                ),
              },
              {
                kind: "select",
                name: "tenantUserId",
                label: t("workforce.offers.member"),
                hint: t("workforce.offers.memberHint"),
                emptyOption: t("workforce.form.choose"),
                options: staff,
              },
            ]}
          />
        </Card>
      ) : null}
      {!closedStage && app.stage !== "offered" ? (
        <Card>
          <WorkforceForm
            headingLevel={2}
            title={t("workforce.applications.close")}
            path={path}
            submit={t("workforce.applications.closeSubmit")}
            done={t("workforce.applications.closed")}
            destructive
            action={closeApplication.bind(null, id, app.version)}
            fields={[
              {
                kind: "select",
                name: "reason",
                label: t("workforce.applications.reason"),
                required: true,
                emptyOption: t("workforce.form.choose"),
                options: codeOptions(CLOSING, "workforce.recruitment.reason", t),
              },
            ]}
          />
        </Card>
      ) : null}
    </div>
  );
}
