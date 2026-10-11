import type { RiskAssessmentItem } from "@harbour/contracts";
import { ButtonLink, Card, StatusChip } from "@harbour/ui";
import { CircleAlert, Clock, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { type RiskTemplate, reviewOverdue, riskChip } from "@/lib/risk";
import { CloseRisk } from "./CloseRisk";

/**
 * One risk assessment as the API stored it: the rating it worked out from the assessor's two
 * judgements, before and after the controls, measurements against the MHRA figures, the controls
 * and the positive risk statement, and when it is due for review.
 */
export function RiskCard({
  item,
  template,
  personId,
  name,
  today,
  canWrite,
}: {
  readonly item: RiskAssessmentItem;
  readonly template: RiskTemplate | undefined;
  readonly personId: string;
  readonly name: string;
  readonly today: string;
  readonly canWrite: boolean;
}) {
  const questionText = (key: string) =>
    template?.questions.find((question) => question.key === key)?.text ?? key;
  const overdue = reviewOverdue(item, today);
  return (
    <Card as="article" title={template?.title ?? item.templateKey} headingLevel={4}>
      <div className="flex flex-col gap-3" data-risk={item.templateKey}>
        <div className="flex flex-wrap items-center gap-2">
          {item.riskRating !== null ? (
            <StatusChip
              status={riskChip(item.riskBand)}
              label={t("care.risk.rating", {
                rating: item.riskRating,
                band: item.riskBand ?? "none",
              })}
              icon={ShieldAlert}
            />
          ) : (
            <span className="text-callout">{t("care.risk.notRated")}</span>
          )}
          {item.residualRating !== null ? (
            <StatusChip
              status={riskChip(item.residualBand)}
              label={t("care.risk.residual", {
                rating: item.residualRating,
                band: item.residualBand ?? "none",
              })}
              icon={ShieldAlert}
            />
          ) : null}
          {overdue ? (
            <StatusChip status="overdue" label={t("care.risk.reviewOverdue")} icon={Clock} />
          ) : null}
        </div>
        <dl className="m-0 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-callout font-semibold">{t("care.risk.hazard")}</dt>
            <dd className="m-0">{item.hazard}</dd>
          </div>
          <div>
            <dt className="text-callout font-semibold">{t("care.risk.whoAtRisk")}</dt>
            <dd className="m-0">{item.whoAtRisk}</dd>
          </div>
        </dl>
        {item.outsideLimits ? (
          <p className="m-0 flex items-start gap-2 font-semibold">
            <CircleAlert
              size={18}
              strokeWidth={1.5}
              aria-hidden="true"
              className="mt-0.5 shrink-0"
            />
            {t("care.risk.outsideLimits")}
          </p>
        ) : null}
        {item.findings.length > 0 ? (
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-callout">
            {item.findings.map((finding) => (
              <li key={finding.questionKey} className="flex flex-wrap items-center gap-2">
                <StatusChip
                  status={finding.withinLimit ? "done" : "overdue"}
                  label={
                    finding.withinLimit ? t("care.risk.withinLimit") : t("care.risk.outsideLimit")
                  }
                />
                <span>
                  {t("care.risk.finding", {
                    question: questionText(finding.questionKey),
                    value: finding.valueMm,
                    rule: finding.rule,
                    limit: finding.limitMm,
                  })}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <div>
          <p className="m-0 text-callout font-semibold">{t("care.risk.controls")}</p>
          {item.controls.length === 0 ? (
            <p className="m-0 text-text-secondary">{t("care.risk.noControls")}</p>
          ) : (
            <ul className="m-0 ps-5">
              {item.controls.map((control) => (
                <li key={control}>{control}</li>
              ))}
            </ul>
          )}
        </div>
        {item.positiveRiskStatement ? (
          <div>
            <p className="m-0 text-callout font-semibold">{t("care.risk.positiveRisk")}</p>
            <p className="m-0 whitespace-pre-line">{item.positiveRiskStatement}</p>
          </div>
        ) : null}
        {item.personViews ? (
          <div>
            <p className="m-0 text-callout font-semibold">{t("care.risk.personViews", { name })}</p>
            <p className="m-0 whitespace-pre-line">{item.personViews}</p>
          </div>
        ) : null}
        <p className="m-0 flex flex-wrap gap-x-4 text-callout text-text-secondary">
          <span>{t("care.risk.assessedOn", { date: formatDate(item.assessedOn) ?? "" })}</span>
          <span>{t("care.risk.reviewDue", { date: formatDate(item.reviewDueOn) ?? "" })}</span>
        </p>
        {item.status === "closed" && item.closedReason ? (
          <p className="m-0">{t("care.risk.closedReason", { reason: item.closedReason })}</p>
        ) : null}
        <div className="flex flex-wrap items-start gap-3">
          {canWrite && item.status === "active" ? (
            <>
              <ButtonLink
                href={`/people/${personId}/risk-assessments?review=${item.id}`}
                variant="secondary"
              >
                {t("care.risk.review.open")}
              </ButtonLink>
              <CloseRisk personId={personId} riskId={item.id} version={item.version} />
            </>
          ) : null}
        </div>
        <p className="m-0 text-callout">
          <Link href={`/people/${personId}/history/risk_assessment/${item.id}`}>
            {t("care.risk.historyLink")}
          </Link>
        </p>
      </div>
    </Card>
  );
}
