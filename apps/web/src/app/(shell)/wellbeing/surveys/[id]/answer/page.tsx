import { Card, PageHeader } from "@harbour/ui";
import { ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Notice } from "@/components/care/Notice";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { AnswerForm } from "@/components/scheduling/WellbeingForms";
import { getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { wellbeingAccess } from "@/lib/wellbeing";

export const metadata: Metadata = { title: t("scheduling.wellbeing.answer.title") };

/**
 * Answer a survey anonymously (scheduling.md section 16 rules 2 to 4). The page says plainly what
 * is recorded (that you took part; your answers, with the week the survey closed) and what is not
 * (your name, the time, anything linking the answers to you), and that results show only once the
 * survey has closed and enough people answered.
 */
export default async function AnswerSurveyPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { me } = await getShellContext();
  const title = t("scheduling.wellbeing.answer.title");
  if (!wellbeingAccess(me.permissions).self) return <SafetyForbidden title={title} />;
  const listed = isUuid(id)
    ? await (await tenantApi()).GET("/v1/pulse-surveys", { params: { query: { view: "answer" } } })
    : null;
  const survey = listed?.data?.items.find((s) => s.id === id);

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={me.tenant.name}
        title={survey?.title ?? title}
        description={
          survey
            ? t("scheduling.wellbeing.answer.closes", { closes: formatDate(survey.closesOn) ?? "" })
            : undefined
        }
      />
      <p className="m-0">
        <Link href="/wellbeing" className="inline-flex min-h-target items-center underline">
          {t("scheduling.wellbeing.back")}
        </Link>
      </p>
      {survey?.state !== "open" ? (
        <Card>
          <p className="m-0">{t("scheduling.wellbeing.answer.notOpen")}</p>
        </Card>
      ) : survey.answered ? (
        <Card>
          <p className="m-0">{t("scheduling.wellbeing.answer.already")}</p>
        </Card>
      ) : (
        <>
          <Notice
            tone="info"
            icon={<ShieldCheck size={20} strokeWidth={1.5} aria-hidden="true" />}
            title={t("scheduling.wellbeing.answer.privacyTitle")}
          >
            <div className="flex flex-col gap-2">
              <p className="m-0 font-semibold">{t("scheduling.wellbeing.answer.recordedTitle")}</p>
              <ul className="m-0 pl-5">
                <li>{t("scheduling.wellbeing.answer.recordedTookPart")}</li>
                <li>{t("scheduling.wellbeing.answer.recordedAnswers")}</li>
              </ul>
              <p className="m-0 font-semibold">
                {t("scheduling.wellbeing.answer.notRecordedTitle")}
              </p>
              <ul className="m-0 pl-5">
                <li>{t("scheduling.wellbeing.answer.notRecordedName")}</li>
                <li>{t("scheduling.wellbeing.answer.notRecordedTime")}</li>
                <li>{t("scheduling.wellbeing.answer.notRecordedLink")}</li>
              </ul>
              <p className="m-0">{t("scheduling.wellbeing.answer.resultsWhen")}</p>
              <p className="m-0">{t("scheduling.wellbeing.answer.freeTextCare")}</p>
            </div>
          </Notice>
          <Card as="section" aria-labelledby="questions">
            <div className="flex flex-col gap-4">
              <h2 id="questions" className="hb-card__title">
                {t("scheduling.wellbeing.answer.questions")}
              </h2>
              <p className="m-0">{t("scheduling.wellbeing.answer.optional")}</p>
              <AnswerForm surveyId={survey.id} questions={survey.questions} />
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
