import { StatusChip } from "@harbour/ui";
import { CalendarClock, CircleAlert, CirclePause, Clock } from "lucide-react";
import { t } from "@/lib/i18n";
import { type ReviewState, reviewChip } from "@/lib/reviews";

const icons = { overdue: CircleAlert, due: Clock, upcoming: CalendarClock, paused: CirclePause };

/** A review's state as an icon and a word, never colour alone (HZ-008). */
export function ReviewChip({ state }: { readonly state: ReviewState }) {
  const chip = reviewChip(state, t);
  return <StatusChip status={chip.status} label={chip.label} icon={icons[chip.icon]} />;
}
