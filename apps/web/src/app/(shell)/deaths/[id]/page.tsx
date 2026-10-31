import { Card, PageHeader } from "@harbour/ui";
import { ExternalLink, ShieldAlert, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Notice } from "@/components/care/Notice";
import { PersonNeeds } from "@/components/safety/PersonNeeds";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import {
  CloseDeathForm,
  DeathReviewForm,
  DeathStepForm,
  JudgementForm,
} from "@/components/safety-events/DeathForms";
import { SiloStatus } from "@/components/safety-events/SiloStatus";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import {
  canManageDeaths,
  deathStatusChip,
  deathStepChip,
  deathsShown,
  isNotificationStep,
  notificationHref,
  recordableHere,
  reviewChip,
  stepsToShow,
} from "@/lib/deaths";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { personNames } from "@/lib/people";
import { getPerson } from "@/lib/person-record";

export const metadata: Metadata = { title: t("deaths.recordTitle") };

/**
 * One death record (SAFE-014; HZ-013). The clinician's judgement comes first: until it is recorded
 * the steps assume the safer answer, so the police steps are listed and the page says why. The
 * regulator's notification, the medical examiner information and LeDeR are completed in the
 * notification centre and only linked here. Then the mortality review, the history and closing.
 */
export default async function DeathPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { me } = await getShellContext();
  const title = t("deaths.recordTitle");
  if (!deathsShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const { data, error, response } = await api.GET("/v1/deaths/{id}", {
    params: { path: { id } },
  });
  if (!data) {
    if (problemCode(error) === "missing_permission") return <SafetyForbidden title={title} />;
    if (response.status === 404) notFound();
    return failWith(error, response, `/deaths/${id}`);
  }
  const person = (await getPerson(data.personId)).person;
  const manage = canManageDeaths(me.permissions) && data.status === "open";
  const judgementMissing = data.missingFacts.length > 0;
  const steps = stepsToShow(data);
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <SiloStatus />
      <PageHeader title={t("deaths.itemTitle", { when: formatDateTime(data.diedAt) ?? "" })} />
      <p className="m-0 flex flex-wrap gap-2">
        <SafetyChip chip={deathStatusChip(data.status, t)} />
        <SafetyChip chip={reviewChip(data.review, t)} />
      </p>
      <Card as="section" headingLevel={2} title={t("deaths.person")}>
        {person ? (
          <div className="flex flex-col gap-2">
            <p className="m-0 font-semibold">{personNames(person).full}</p>
            <PersonNeeds person={person} />
            {data.learningDisabilityOrAutism ? (
              <p className="m-0">{t("deaths.learningDisability")}</p>
            ) : null}
          </div>
        ) : (
          <p className="m-0">{t("deaths.personHidden")}</p>
        )}
      </Card>

      {judgementMissing ? (
        <Notice
          tone="warning"
          icon={<ShieldAlert size={20} strokeWidth={1.5} aria-hidden="true" />}
          title={t("deaths.judgement.missing")}
        />
      ) : null}
      <Card as="section" headingLevel={2} title={t("deaths.judgement.title")}>
        <div className="flex flex-col gap-3">
          {judgementMissing ? null : (
            <p className="m-0">
              {t("deaths.judgement.recorded", {
                expected: data.expected ? "yes" : "no",
                unnatural: data.possiblyUnnatural ? "yes" : "no",
                by: data.judgedBy ?? "",
              })}
            </p>
          )}
          {manage ? (
            <JudgementForm
              id={data.id}
              version={data.version}
              expected={data.expected}
              possiblyUnnatural={data.possiblyUnnatural}
              judgedBy={data.judgedBy}
            />
          ) : null}
        </div>
      </Card>

      <section className="flex flex-col gap-3" aria-labelledby="death-steps">
        <h2 id="death-steps" className="m-0 text-heading">
          {t("deaths.steps.title")}
        </h2>
        {steps
          .filter((s) => s.step !== "mortality_review")
          .map((s) => {
            const href = notificationHref(s.notificationId);
            return (
              <Card
                key={s.step}
                as="article"
                headingLevel={3}
                title={t("deaths.step.name", { step: s.step })}
              >
                <div className="flex flex-col gap-3">
                  <p className="m-0 flex flex-wrap items-center gap-2">
                    <SafetyChip chip={deathStepChip(s.state, t)} />
                    {s.at ? (
                      <span className="text-body-dense">
                        {t("deaths.step.recordedAt", { when: formatDateTime(s.at) ?? "" })}
                      </span>
                    ) : null}
                  </p>
                  {s.reason ? <p className="m-0 whitespace-pre-wrap">{s.reason}</p> : null}
                  {isNotificationStep(s.step) ? (
                    <div className="flex flex-col gap-1">
                      <p className="m-0">{t("deaths.step.inNotificationCentre")}</p>
                      {href ? (
                        <Link
                          href={href}
                          className="inline-flex min-h-target items-center gap-1 underline"
                        >
                          <ExternalLink size={16} strokeWidth={1.5} aria-hidden="true" />
                          {t("deaths.step.openNotification", {
                            status: s.notificationStatus ?? "none",
                          })}
                        </Link>
                      ) : (
                        <p className="m-0">{t("deaths.step.noNotification")}</p>
                      )}
                    </div>
                  ) : null}
                  {manage && recordableHere(s.step) && s.state !== "done" ? (
                    <DeathStepForm id={data.id} step={s.step} />
                  ) : null}
                </div>
              </Card>
            );
          })}
      </section>

      <Card as="section" headingLevel={2} title={t("deaths.review.title")}>
        <div className="flex flex-col gap-3">
          <p className="m-0">
            {t("deaths.reviewDue", { when: formatDateTime(data.review.dueAt) ?? "" })}
          </p>
          {data.review.reviewedAt ? (
            <p className="m-0">
              {t("deaths.review.reviewedAt", {
                when: formatDateTime(data.review.reviewedAt) ?? "",
              })}
            </p>
          ) : null}
          {manage ? (
            <DeathReviewForm
              id={data.id}
              version={data.version}
              findings={data.review.findings}
              lessons={data.review.lessons}
            />
          ) : (
            <>
              {data.review.findings ? (
                <p className="m-0 whitespace-pre-wrap">{data.review.findings}</p>
              ) : null}
              {data.review.lessons ? (
                <p className="m-0 whitespace-pre-wrap">{data.review.lessons}</p>
              ) : null}
            </>
          )}
        </div>
      </Card>

      <Card as="section" headingLevel={2} title={t("deaths.history.title")}>
        {data.history.length === 0 ? (
          <p className="m-0">{t("deaths.history.empty")}</p>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-3 p-0">
            {data.history.map((h) => (
              <li key={h.id} className="flex flex-col gap-1">
                <p className="m-0 font-semibold">
                  {t("deaths.history.entry", {
                    step: t("deaths.step.name", { step: h.step }),
                    outcome: h.outcome,
                  })}
                </p>
                <p className="m-0 text-body-dense">
                  {t("deaths.history.when", {
                    at: formatDateTime(h.at) ?? "",
                    recorded: formatDateTime(h.recordedAt) ?? "",
                  })}
                </p>
                {h.reference ? (
                  <p className="m-0 text-body-dense">
                    {t("deaths.history.reference", { reference: h.reference })}
                  </p>
                ) : null}
                {h.note ? <p className="m-0 whitespace-pre-wrap">{h.note}</p> : null}
              </li>
            ))}
          </ol>
        )}
      </Card>

      {manage ? (
        <Card as="section" headingLevel={2} title={t("deaths.close.title")}>
          <div className="flex flex-col gap-3">
            {data.closeProblems.length > 0 ? (
              <>
                <Notice
                  tone="warning"
                  icon={<TriangleAlert size={20} strokeWidth={1.5} aria-hidden="true" />}
                  title={t("deaths.close.blocked")}
                />
                <ul className="m-0 flex flex-col gap-1 pl-5">
                  {data.closeProblems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </>
            ) : (
              <CloseDeathForm id={data.id} version={data.version} />
            )}
          </div>
        </Card>
      ) : null}
      {data.closedAt ? (
        <p className="m-0">{t("deaths.closedAt", { when: formatDateTime(data.closedAt) ?? "" })}</p>
      ) : null}
      {data.withdrawnReason ? (
        <p className="m-0">{t("deaths.withdrawn", { reason: data.withdrawnReason })}</p>
      ) : null}
    </div>
  );
}
