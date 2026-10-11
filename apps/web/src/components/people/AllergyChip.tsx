import { StatusChip } from "@harbour/ui";
import { CircleCheck, TriangleAlert } from "lucide-react";
import type { AllergySummary, AllergyTone } from "@/lib/people";

const toneClass: Record<Exclude<AllergyTone, "warning">, string> = {
  danger: "hb-status-chip--overdue",
  neutral: "hb-status-chip--neutral",
};

/**
 * Allergy status in the status-chip style: an icon and words, never colour alone. Allergies not
 * recorded use the shared `notRecorded` chip (a question mark, never "no allergies"; HZ-007),
 * linked to where they are recorded when that page is given.
 */
export function AllergyChip({
  summary,
  recordHref,
}: {
  readonly summary: AllergySummary;
  readonly recordHref?: string;
}) {
  if (summary.tone === "warning") {
    return (
      <StatusChip
        status="notRecorded"
        label={summary.label}
        data-allergy-tone="warning"
        {...(recordHref ? { href: recordHref } : {})}
      />
    );
  }
  const Icon = summary.icon === "circle-check" ? CircleCheck : TriangleAlert;
  return (
    <span className={`hb-status-chip ${toneClass[summary.tone]}`} data-allergy-tone={summary.tone}>
      <Icon size={14} strokeWidth={1.5} aria-hidden="true" className="hb-status-chip__icon" />
      <span className="hb-status-chip__label">{summary.label}</span>
    </span>
  );
}
