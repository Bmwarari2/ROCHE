import type { AssessmentItem } from "@harbour/contracts";
import { StatusChip } from "@harbour/ui";
import { ClipboardCheck } from "lucide-react";
import { bandChip, bandLabel, fallsDetails, triggerTexts } from "@/lib/assessments";
import { readWorkings } from "@/lib/charts";
import { formatDate, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { EntryBadges } from "./EntryBadges";
import { Workings } from "./Workings";

/**
 * One validated tool result exactly as the API calculated and stored it (hazards HZ-012 and
 * HZ-014): the score and band in words, the workings, what the result raised and when the tool is
 * next due. The falls questions give no score, in NICE's words.
 */
export function AssessmentResult({
  item,
  headingLevel = 3,
}: {
  readonly item: AssessmentItem;
  readonly headingLevel?: 3 | 4;
}) {
  const Heading = `h${headingLevel}` as const;
  const band = bandLabel(item, t);
  const falls = item.toolKey === "ng249_falls" ? fallsDetails(item) : null;
  const triggers = triggerTexts(item, t);
  return (
    <section
      aria-label={t("care.assessments.toolFull", { tool: item.toolKey })}
      className="flex flex-col gap-3"
      data-assessment={item.toolKey}
    >
      <div className="flex flex-wrap items-center gap-3">
        <Heading className="m-0 text-body font-semibold">
          {t("care.assessments.toolFull", { tool: item.toolKey })}
        </Heading>
        <EntryBadges entry={item} />
      </div>
      <p className="m-0 text-callout text-text-secondary">
        {t("care.assessments.completed", { dateTime: formatDateTime(item.occurredAt) ?? "" })}
      </p>
      {item.score !== null ? (
        <p className="m-0 flex flex-wrap items-center gap-3">
          <span className="text-intro font-semibold">
            {t("care.assessments.score", { score: item.score })}
          </span>
          {band ? <StatusChip status={bandChip(item)} label={band} icon={ClipboardCheck} /> : null}
        </p>
      ) : (
        <p className="m-0 text-callout">{t("care.assessments.noScore")}</p>
      )}
      {falls?.recommendation ? (
        <p className="m-0 font-semibold">
          {t("care.assessments.falls.recommendation", { code: falls.recommendation })}
        </p>
      ) : null}
      {falls?.reason ? (
        <p className="m-0">{t("care.assessments.falls.reason", { reason: falls.reason })}</p>
      ) : null}
      <Workings workings={readWorkings(item.workings)} />
      <div className="flex flex-col gap-1">
        <p className="m-0 text-callout font-semibold">{t("care.assessments.triggers.title")}</p>
        {triggers.length === 0 ? (
          <p className="m-0 text-callout">{t("care.assessments.triggers.none")}</p>
        ) : (
          <ul className="m-0 flex flex-col gap-1 ps-5 text-callout">
            {triggers.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        )}
      </div>
      <p className="m-0 flex flex-wrap gap-x-4 text-callout text-text-secondary">
        {item.nextDueOn ? (
          <span>{t("care.assessments.nextDue", { date: formatDate(item.nextDueOn) ?? "" })}</span>
        ) : null}
        <span>{t("care.assessments.toolVersion", { version: item.toolVersion })}</span>
      </p>
      <p className="m-0 text-callout text-text-secondary">{t("care.assessments.calculatedBy")}</p>
    </section>
  );
}
