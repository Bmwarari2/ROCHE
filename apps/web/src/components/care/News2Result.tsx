import { StatusChip } from "@harbour/ui";
import { Activity } from "lucide-react";
import type { Ref } from "react";
import { TOOL_SOURCES } from "@/lib/assessments";
import { type News2Flags, news2Chip } from "@/lib/charts";
import { t } from "@/lib/i18n";
import { Workings } from "./Workings";

/**
 * A NEWS2 result as the API calculated and stored it (hazard HZ-014): the score, the RCP's
 * clinical risk, response and monitoring wording, and the workings. Nothing is calculated here.
 */
export function News2Result({
  news2,
  headingLevel = 3,
  ref,
}: {
  readonly news2: News2Flags;
  readonly headingLevel?: 2 | 3 | 4;
  /** Set to move focus here once vital signs are saved, so the result is read out. */
  readonly ref?: Ref<HTMLElement>;
}) {
  const Heading = `h${headingLevel}` as const;
  return (
    <section
      ref={ref}
      tabIndex={ref ? -1 : undefined}
      aria-label={t("care.news2.title")}
      className="flex flex-col gap-3 rounded-input border border-border p-4"
      data-news2-score={news2.score}
    >
      <div className="flex flex-wrap items-center gap-3">
        <Heading className="m-0 text-body font-semibold">
          {t("care.news2.score", { score: news2.score })}
        </Heading>
        <StatusChip
          status={news2Chip(news2.band)}
          label={t("care.news2.clinicalRisk", { risk: news2.clinicalRisk })}
          icon={Activity}
        />
      </div>
      <p className="m-0 font-semibold">{t("care.news2.response", { response: news2.response })}</p>
      {news2.monitoring ? (
        <p className="m-0">{t("care.news2.monitoring", { frequency: news2.monitoring })}</p>
      ) : null}
      {news2.redScore ? <p className="m-0">{t("care.news2.redScore")}</p> : null}
      <p className="m-0 text-body-dense text-text-secondary">
        {news2.spo2Scale === null
          ? t("care.news2.scaleUnknown")
          : t("care.news2.scale", { scale: news2.spo2Scale })}
      </p>
      <Workings workings={news2.workings} />
      <p className="m-0 text-body-dense text-text-secondary">
        <a href={TOOL_SOURCES.news2} rel="noreferrer">
          {t("care.assessments.source", { tool: "news2" })}
        </a>
      </p>
      <p className="m-0 text-body-dense text-text-secondary">{t("care.news2.source")}</p>
    </section>
  );
}
