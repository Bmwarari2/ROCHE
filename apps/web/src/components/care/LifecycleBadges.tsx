import type { TaskItem } from "@harbour/contracts";
import { StatusChip } from "@harbour/ui";
import { CircleSlash, DoorOpen, Link2Off, ListChecks } from "lucide-react";
import { t } from "@/lib/i18n";

export type TaskOutcome = "completed" | "task_cancelled" | "task_already_closed" | "not_linked";

/**
 * Flags on an entry about a person who has left, died or gone away, and about the round it named
 * (people.md rule 3; hazards HZ-004 and HZ-006): recorded after the person left; its round had
 * been cancelled; the round was already recorded; or it was not linked to its round. The last two
 * are with the nurse in charge to review. An icon and words, never colour alone.
 */
export function EntryLifecycleBadges({
  entry,
}: {
  readonly entry: { readonly recordedAfterExit: boolean; readonly taskOutcome: TaskOutcome | null };
}) {
  const outcome = entry.taskOutcome;
  if (!entry.recordedAfterExit && (outcome === null || outcome === "completed")) return null;
  return (
    <>
      {entry.recordedAfterExit ? (
        <StatusChip status="info" label={t("care.entry.recordedAfterExit")} icon={DoorOpen} />
      ) : null}
      {outcome === "task_cancelled" ? (
        <StatusChip status="neutral" label={t("care.entry.taskCancelled")} icon={CircleSlash} />
      ) : null}
      {outcome === "task_already_closed" ? (
        <StatusChip status="due" label={t("care.entry.taskAlreadyClosed")} icon={ListChecks} />
      ) : null}
      {outcome === "not_linked" ? (
        <StatusChip status="due" label={t("care.entry.notLinked")} icon={Link2Off} />
      ) : null}
    </>
  );
}

/**
 * A task whose evidence arrived after it was cancelled (an entry recorded offline before the
 * person went to hospital): it stays cancelled, and says so (HZ-006).
 */
export function TaskEvidenceBadge({
  task,
}: {
  readonly task: Pick<TaskItem, "evidenceAfterClose">;
}) {
  if (!task.evidenceAfterClose) return null;
  return <StatusChip status="info" label={t("care.task.evidenceAfterClose")} icon={DoorOpen} />;
}
