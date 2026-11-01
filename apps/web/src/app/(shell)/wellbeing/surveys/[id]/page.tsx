import { Card, PageHeader, StatusChip } from "@harbour/ui";
import { EyeOff } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrivalNotice } from "@/components/care/ArrivalNotice";
import { Notice } from "@/components/care/Notice";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { SurveyMove } from "@/components/scheduling/WellbeingForms";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { formatDate, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import {
  questionView,
  SCALE_POINTS,
  surveyMoves,
  surveyStateChip,
  wellbeingAccess,
} from "@/lib/wellbeing";

export const metadata: Metadata = { title: t("scheduling.wellbeing.surveys.title") };

const DONE = ["written", "open", "close"] as const;

/**
 * A staff survey for its manager (scheduling.md section 16 rules 1 and 4): its questions, opening
 * and closing it, and, once closed, its results: only when enough people answered, each question
 * only when enough answered it, a scale's counts all or none, free text in alphabetical order.
 * There is no breakdown, filter or export.
 */
export default async function SurveyPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ id: string }>;
  readonly searchParams: Promise<{ done?: string | string[] }>;
}) {
  const { id } = await params;
  const { done } = await searchParams;
  const { me } = await getShellContext();
  const title = t("scheduling.wellbeing.surveys.title");
  if (!wellbeingAccess(me.permissions).manage) return <SafetyForbidden title={title} />;
  if (!isUuid(id)) notFound();
  const api = await tenantApi();
  const listed = await api.GET("/v1/pulse-surveys", { params: { query: { view: "manage" } } });
  if (!listed.data) failWith(listed.error, listed.response);
  const survey = listed.data.items.find((s) => s.id === id);
  if (!survey) notFound();
  const results =
    survey.state === "closed"
      ? await api.GET("/v1/pulse-surveys/{id}/results", { params: { path: { id } } })
      : null;
  const arrived = DONE.find((d) => d === done);

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader eyebrow={me.tenant.name} title={survey.title} />
      <p className="m-0">
        <Link href="/wellbeing/surveys" className="inline-flex min-h-target items-center underline">
          {t("scheduling.wellbeing.surveys.back")}
        </Link>
      </p>
      {arrived ? (
        <ArrivalNotice key={arrived}>
          {t("scheduling.wellbeing.survey.arrived", { done: arrived })}
        </ArrivalNotice>
      ) : null}
      <Card as="section" aria-labelledby="about">
        <div className="flex flex-col gap-3">
          <h2 id="about" className="hb-card__title">
            {t("scheduling.wellbeing.survey.about")}
          </h2>
          <div>
            <StatusChip {...surveyStateChip(survey.state, t)} />
          </div>
          <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-[max-content_1fr]">
            <dt className="font-semibold">{t("scheduling.wellbeing.survey.where")}</dt>
            <dd className="m-0">
              {survey.locationId === null
                ? t("scheduling.wellbeing.organisation")
                : (me.locations.find((l) => l.id === survey.locationId)?.name ??
                  t("scheduling.wellbeing.otherHome"))}
            </dd>
            <dt className="font-semibold">{t("scheduling.wellbeing.survey.dates")}</dt>
            <dd className="m-0">
              {t("scheduling.wellbeing.survey.datesValue", {
                opens: formatDate(survey.opensOn) ?? "",
                closes: formatDate(survey.closesOn) ?? "",
              })}
            </dd>
            {survey.closedAt ? (
              <>
                <dt className="font-semibold">{t("scheduling.wellbeing.survey.closedAt")}</dt>
                <dd className="m-0">{formatDateTime(survey.closedAt)}</dd>
              </>
            ) : null}
          </dl>
          <h3 className="m-0 text-heading-sm">{t("scheduling.wellbeing.survey.questions")}</h3>
          <ol className="m-0 pl-5">
            {survey.questions.map((q) => (
              <li key={q.id}>
                {t("scheduling.wellbeing.survey.questionLine", { text: q.text, kind: q.kind })}
              </li>
            ))}
          </ol>
          {surveyMoves(survey.state).map((move) => (
            <SurveyMove key={move} surveyId={survey.id} move={move} version={survey.version} />
          ))}
          {survey.state === "open" ? (
            <p className="m-0">{t("scheduling.wellbeing.survey.noResultsWhileOpen")}</p>
          ) : null}
        </div>
      </Card>

      {results ? (
        <Card as="section" aria-labelledby="results">
          <div className="flex flex-col gap-4">
            <h2 id="results" className="hb-card__title">
              {t("scheduling.wellbeing.results.title")}
            </h2>
            {!results.data ? (
              <p className="m-0">{t("care.errors.unavailable")}</p>
            ) : !results.data.visible ? (
              <Notice
                tone="info"
                icon={<EyeOff size={20} strokeWidth={1.5} aria-hidden="true" />}
                title={results.data.message}
              >
                <p className="m-0">{t("scheduling.wellbeing.results.whyHidden")}</p>
              </Notice>
            ) : (
              <>
                <p className="m-0">{results.data.message}</p>
                <ol className="m-0 flex list-none flex-col gap-5 p-0">
                  {(results.data.questions ?? []).map((q, index) => {
                    const view = questionView(q, results.data?.minGroupSize ?? null);
                    return (
                      <li key={q.id} className="flex flex-col gap-2">
                        <h3 className="m-0 text-heading-sm">
                          {t("scheduling.wellbeing.answer.legend", { n: index + 1, text: q.text })}
                        </h3>
                        {view.kind === "hidden" ? (
                          <p className="m-0 flex items-center gap-2">
                            <EyeOff size={16} strokeWidth={1.5} aria-hidden="true" />
                            {t("scheduling.wellbeing.results.questionHidden", {
                              size: results.data?.minGroupSize ?? 0,
                            })}
                          </p>
                        ) : view.kind === "scale" ? (
                          <>
                            {view.answered !== null ? (
                              <p className="m-0">
                                {t("scheduling.wellbeing.results.answered", {
                                  count: view.answered,
                                })}
                              </p>
                            ) : null}
                            {view.counts ? (
                              <table className="border-collapse text-left">
                                <caption className="sr-only">
                                  {t("scheduling.wellbeing.results.countsCaption", {
                                    text: q.text,
                                  })}
                                </caption>
                                <thead>
                                  <tr>
                                    <th scope="col" className="p-2">
                                      {t("scheduling.wellbeing.results.point")}
                                    </th>
                                    <th scope="col" className="p-2">
                                      {t("scheduling.wellbeing.results.people")}
                                    </th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {SCALE_POINTS.map((point, i) => (
                                    <tr key={point} className="border-t border-border-subtle">
                                      <th scope="row" className="p-2 font-normal">
                                        {t("scheduling.wellbeing.answer.point", { point })}
                                      </th>
                                      <td className="p-2">{view.counts?.[i]}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            ) : (
                              <p className="m-0 flex items-center gap-2">
                                <EyeOff size={16} strokeWidth={1.5} aria-hidden="true" />
                                {t("scheduling.wellbeing.results.countsHidden", {
                                  size: results.data?.minGroupSize ?? 0,
                                })}
                              </p>
                            )}
                          </>
                        ) : (
                          <>
                            {view.answered !== null ? (
                              <p className="m-0">
                                {t("scheduling.wellbeing.results.answered", {
                                  count: view.answered,
                                })}
                              </p>
                            ) : null}
                            <p className="m-0 text-body-dense text-text-secondary">
                              {t("scheduling.wellbeing.results.textOrder")}
                            </p>
                            <ul className="m-0 flex flex-col gap-2 pl-5">
                              {view.texts.map((text, i) => (
                                // biome-ignore lint/suspicious/noArrayIndexKey: answers have no id by design, and two may read the same.
                                <li key={i} className="whitespace-pre-wrap">
                                  {text}
                                </li>
                              ))}
                            </ul>
                          </>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </>
            )}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
