import type { TaskItem } from "@harbour/contracts";
import { StatusChip } from "@harbour/ui";
import {
  CircleSlash,
  DoorOpen,
  Link2Off,
  ListChecks,
  RotateCcw,
  ShieldAlert,
  Undo2,
} from "lucide-react";
import { t } from "@/lib/i18n";

export type TaskOutcome =
  | "completed"
  | "task_cancelled"
  | "task_already_closed"
  | "not_linked"
  | "medicines_conflict";

/**
 * Flags on an entry about a person who has left, died or gone away, and about the round it named
 * (people.md rule 3, care.md rule 13; hazards HZ-004 and HZ-006): recorded after the person left;
 * its round had been cancelled; the round was already recorded; it was not linked to its round
 * (both for the nurse in charge to review); or a medicines entry that could not complete its task,
 * which tells the user to tell the nurse in charge now. An icon and words, never colour alone.
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
      {outcome === "medicines_conflict" ? (
        <StatusChip status="overdue" label={t("care.entry.medicinesConflict")} icon={ShieldAlert} />
      ) : null}
    </>
  );
}

/**
 * Flags on a task the people lifecycle stopped and brought back (people.md rule 2; HZ-003,
 * HZ-006): evidence that arrived after it was cancelled (it stays cancelled); caught up once after
 * a late return or correction, with a fresh window; or done because an entry answered it while it
 * was stopped. Read from structured flags, never from the reason's wording.
 */
export function TaskEvidenceBadge({
  task,
}: {
  readonly task: Pick<TaskItem, "evidenceAfterClose"> &
    Partial<Pick<TaskItem, "catchUp" | "restoredDone">>;
}) {
  if (!task.evidenceAfterClose && !task.catchUp && !task.restoredDone) return null;
  return (
    <>
      {task.evidenceAfterClose ? (
        <StatusChip status="info" label={t("care.task.evidenceAfterClose")} icon={DoorOpen} />
      ) : null}
      {task.catchUp ? (
        <StatusChip status="due" label={t("care.task.catchUp")} icon={RotateCcw} />
      ) : null}
      {task.restoredDone ? (
        <StatusChip status="done" label={t("care.task.restoredDone")} icon={Undo2} />
      ) : null}
    </>
  );
}
