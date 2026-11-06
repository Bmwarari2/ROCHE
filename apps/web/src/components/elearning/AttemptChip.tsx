import { StatusChip } from "@harbour/ui";
import { CircleAlert, CircleCheck, CircleMinus, Clock, type LucideIcon } from "lucide-react";
import type { attemptChip } from "@/lib/elearning";

const ICONS: Record<ReturnType<typeof attemptChip>["icon"], LucideIcon> = {
  "circle-check": CircleCheck,
  clock: Clock,
  "circle-alert": CircleAlert,
  "circle-minus": CircleMinus,
};

/** An attempt's state: an icon and a word, never colour alone. */
export function AttemptChip({ chip }: { readonly chip: ReturnType<typeof attemptChip> }) {
  return <StatusChip status={chip.status} label={chip.label} icon={ICONS[chip.icon]} />;
}
