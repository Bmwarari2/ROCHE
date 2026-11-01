import type { DsarCase } from "@harbour/contracts";
import { StatusChip } from "@harbour/ui";
import { CircleAlert, CircleCheck, Clock, PauseCircle, UserCheck } from "lucide-react";
import { clockView } from "@/lib/dsar";
import { t } from "@/lib/i18n";

const ICONS = {
  awaiting_identity: UserCheck,
  running: Clock,
  paused: PauseCircle,
  due_soon: Clock,
  overdue: CircleAlert,
  closed: CircleCheck,
} as const;

/** A request's clock as an icon and a word, with the sentence beside it when asked. */
export function ClockChip({
  clock,
  respondedOn,
  withWords = false,
}: {
  readonly clock: DsarCase["clock"];
  readonly respondedOn: string | null;
  readonly withWords?: boolean;
}) {
  const view = clockView(clock, respondedOn, t);
  const Icon = clock ? ICONS[clock.state] : CircleAlert;
  const late = clock?.state === "closed" && clock.late === true;
  return (
    <span className="flex flex-wrap items-center gap-2">
      <StatusChip status={view.status} label={view.label} icon={late ? CircleAlert : Icon} />
      {withWords ? <span>{view.words}</span> : null}
    </span>
  );
}
