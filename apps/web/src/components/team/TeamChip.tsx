import { StatusChip } from "@harbour/ui";
import { Ban, CircleCheck, Clock, type LucideIcon, Mail, Pause, TimerOff } from "lucide-react";
import type { TeamChip as Chip, ChipIcon } from "@/lib/team";

const ICONS: Record<ChipIcon, LucideIcon> = {
  clock: Clock,
  "circle-check": CircleCheck,
  "timer-off": TimerOff,
  ban: Ban,
  mail: Mail,
  pause: Pause,
};

/** A member's or an invitation's state: an icon and a word, never colour alone. */
export function TeamChip({ chip }: { readonly chip: Chip }) {
  return <StatusChip status={chip.status} label={chip.label} icon={ICONS[chip.icon]} />;
}
