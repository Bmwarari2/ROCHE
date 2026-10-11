import type { CarePlanSummary } from "@harbour/contracts";
import { StatusChip } from "@harbour/ui";
import { CircleCheck, History, PencilLine } from "lucide-react";
import { planStatusChip } from "@/lib/care-plan";
import { t } from "@/lib/i18n";

const icons = { "circle-check": CircleCheck, "pencil-line": PencilLine, history: History };

/** A care plan version's status in word and icon (HZ-024): only "In use" means in use. */
export function PlanStatus({ status }: { readonly status: CarePlanSummary["status"] }) {
  const chip = planStatusChip(status, t);
  return (
    <span data-plan-status={status}>
      <StatusChip status={chip.status} label={chip.label} icon={icons[chip.icon]} />
    </span>
  );
}
