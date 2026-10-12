import type { ObservationItem } from "@harbour/contracts";
import { StatusChip } from "@harbour/ui";
import { Activity, History, TriangleAlert } from "lucide-react";
import { entryAuthor } from "@/lib/care-record";
import {
  iddsiOutcome,
  iddsiProblem,
  news2Chip,
  news2FromFlags,
  observationSummary,
} from "@/lib/charts";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { EntryBadges } from "./EntryBadges";
import { Workings } from "./Workings";

/**
 * Chart entries, newest first, as the API stored them: what was recorded in words, the NEWS2
 * result for vital signs (score, the RCP's response and monitoring wording, and the workings one
 * tap away), the IDDSI comparison for food and drink, late and corrected flags. A corrected entry
 * is struck through and stays readable. A vital signs entry whose NEWS2 result cannot be read says
 * so, rather than showing nothing (HZ-014).
 */
export function ObservationList({
  items,
  label,
  tenantUserId,
}: {
  readonly items: readonly ObservationItem[];
  readonly label: string;
  readonly tenantUserId: string;
}) {
  return (
    <ol aria-label={label} className="hb-long-list m-0 flex list-none flex-col gap-2 p-0">
      {items.map((item) => {
        const parts = observationSummary(item, t);
        const news2 = item.chart === "vitals" ? news2FromFlags(item.flags) : null;
        const iddsi = iddsiOutcome(item.flags);
        const problem = iddsiProblem(item.flags);
        const summary = parts.join(" · ");
        return (
          <li
            key={item.id}
            className="flex flex-col gap-1 rounded-input border border-border px-4 py-3"
            data-observation={item.chart}
          >
            <p className="m-0 flex flex-wrap items-center gap-2 text-body-dense text-text-secondary">
              <time dateTime={item.occurredAt} className="font-semibold text-text tabular-nums">
                {formatDateTime(item.occurredAt)}
              </time>
              <span>
                {t("care.entry.recordedBy", { who: entryAuthor(item.recordedBy, tenantUserId) })}
              </span>
              <EntryBadges entry={item} />
              {item.superseded ? (
                <StatusChip
                  status="notApplicable"
                  label={t("care.assessments.superseded")}
                  icon={History}
                />
              ) : null}
            </p>
            {item.superseded ? (
              <del className="text-text-secondary">{summary}</del>
            ) : (
              <p className="m-0">{summary}</p>
            )}
            {news2 && !item.superseded ? (
              <div className="flex flex-col gap-1" data-news2-score={news2.score}>
                <p className="m-0 flex flex-wrap items-center gap-2">
                  <span className="font-semibold">
                    {t("care.news2.score", { score: news2.score })}
                  </span>
                  <StatusChip
                    status={news2Chip(news2.band)}
                    label={t("care.news2.clinicalRisk", { risk: news2.clinicalRisk })}
                    icon={Activity}
                  />
                </p>
                <p className="m-0 font-semibold">
                  {t("care.news2.response", { response: news2.response })}
                </p>
                {news2.monitoring ? (
                  <p className="m-0">
                    {t("care.news2.monitoring", { frequency: news2.monitoring })}
                  </p>
                ) : null}
                {news2.workings.rows.length > 0 || news2.workings.unreadable > 0 ? (
                  <details>
                    <summary className="inline-flex min-h-target cursor-pointer items-center text-link">
                      {t("care.news2.showWorkings")}
                    </summary>
                    <Workings workings={news2.workings} />
                  </details>
                ) : null}
              </div>
            ) : null}
            {item.chart === "vitals" && !news2 && !item.superseded ? (
              <p className="m-0 flex items-start gap-2 font-semibold">
                <TriangleAlert
                  size={18}
                  strokeWidth={1.5}
                  aria-hidden="true"
                  className="mt-0.5 shrink-0"
                />
                {t("care.news2.unreadable")}
              </p>
            ) : null}
            {problem === "level_not_recorded" || problem === "reason_missing" ? (
              <p className="m-0 flex items-start gap-2 font-semibold" data-iddsi-problem={problem}>
                <TriangleAlert
                  size={18}
                  strokeWidth={1.5}
                  aria-hidden="true"
                  className="mt-0.5 shrink-0"
                />
                {t(
                  problem === "level_not_recorded"
                    ? "care.charts.iddsiKeptNoLevel"
                    : "care.charts.iddsiKeptNoReason",
                )}
              </p>
            ) : null}
            {(iddsi === "mismatch" || iddsi === "unsafe_mismatch") && problem === null ? (
              <p className="m-0 text-body-dense">
                {t("care.charts.overrideGiven", {
                  reason:
                    typeof item.values.overrideReason === "string"
                      ? item.values.overrideReason
                      : t("common.notRecorded"),
                })}
              </p>
            ) : null}
            {item.correctionReason ? (
              <p className="m-0 text-body-dense text-text-secondary">
                {t("care.timeline.reason", { reason: item.correctionReason })}
              </p>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
