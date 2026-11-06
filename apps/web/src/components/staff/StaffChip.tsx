import { StatusChip } from "@harbour/ui";
import { Ban, CircleAlert, CircleCheck, CircleMinus, Clock, type LucideIcon } from "lucide-react";
import type { StaffChip as Chip, StaffChipIcon } from "@/lib/staff";

const ICONS: Record<StaffChipIcon, LucideIcon> = {
  "circle-check": CircleCheck,
  clock: Clock,
  "circle-alert": CircleAlert,
  "circle-minus": CircleMinus,
  ban: Ban,
};

/** A staff file, item, visa, report or consent state: an icon and a word, never colour alone. */
export function StaffChip({ chip }: { readonly chip: Chip }) {
  return <StatusChip status={chip.status} label={chip.label} icon={ICONS[chip.icon]} />;
}
