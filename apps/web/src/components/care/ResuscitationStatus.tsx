import type { ResuscitationStatus as Status } from "@harbour/contracts";
import { CircleHelp, HeartOff, HeartPulse, TriangleAlert } from "lucide-react";
import type { HeaderTone } from "@/lib/care-record";
import { resuscitationSummary } from "@/lib/care-record";
import { t } from "@/lib/i18n";

const toneClass: Record<HeaderTone, string> = {
  danger: "hb-status-chip--overdue",
  warning: "hb-status-chip--due",
  info: "hb-status-chip--info",
  neutral: "hb-status-chip--neutral",
};

const icons = {
  "heart-off": HeartOff,
  "heart-pulse": HeartPulse,
  "circle-help": CircleHelp,
  "triangle-alert": TriangleAlert,
} as const;

/**
 * The resuscitation decision in force, as the point-of-care header shows it (hazard HZ-015): a
 * word and an icon with where it comes from. "Not recorded" is a warning, never blank; records
 * that disagree say to check the documents; an overdue review never hides the decision; a status
 * that could not be read (null) says to check the paper record.
 */
export function ResuscitationStatus({ status }: { readonly status: Status | null }) {
  const summary = resuscitationSummary(status, t);
  const Icon = icons[summary.icon];
  return (
    <div className="flex flex-col gap-1" data-resuscitation={status?.status ?? "unreadable"}>
      <span className={`hb-status-chip ${toneClass[summary.tone]} self-start`}>
        <Icon size={14} strokeWidth={1.5} aria-hidden="true" className="hb-status-chip__icon" />
        <span className="hb-status-chip__label">{summary.label}</span>
      </span>
      <span className="text-body-dense text-text-secondary">{summary.detail}</span>
      {summary.reviewText ? (
        <span
          className={
            summary.reviewOverdue
              ? "text-body-dense font-semibold"
              : "text-body-dense text-text-secondary"
          }
        >
          {summary.reviewText}
        </span>
      ) : null}
    </div>
  );
}
