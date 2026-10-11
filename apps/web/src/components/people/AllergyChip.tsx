import { CircleCheck, CircleHelp, TriangleAlert } from "lucide-react";
import type { AllergySummary, AllergyTone } from "@/lib/people";

const toneClass: Record<AllergyTone, string> = {
  danger: "hb-status-chip--overdue",
  warning: "hb-status-chip--due",
  neutral: "hb-status-chip--neutral",
};

const icons = {
  "triangle-alert": TriangleAlert,
  "circle-help": CircleHelp,
  "circle-check": CircleCheck,
} as const;

/** Allergy status in the status-chip style: an icon and words, never colour alone. */
export function AllergyChip({ summary }: { readonly summary: AllergySummary }) {
  const Icon = icons[summary.icon];
  return (
    <span className={`hb-status-chip ${toneClass[summary.tone]}`} data-allergy-tone={summary.tone}>
      <Icon size={14} strokeWidth={1.5} aria-hidden="true" className="hb-status-chip__icon" />
      <span className="hb-status-chip__label">{summary.label}</span>
    </span>
  );
}
