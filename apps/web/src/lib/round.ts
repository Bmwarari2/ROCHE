import type { RoundTask, RoundView } from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";
import type { SafetyChip } from "./incidents";

/**
 * View logic for the round view (care.md rule 8; register row CARE-013; hazards HZ-001, HZ-003,
 * HZ-024). Pure and unit tested. A task's time state is the API's, said in an icon and words; a
 * state the web does not know warns, never reads as calm.
 */

/** Who may open the round: anyone who reads care plans (the API's permission). */
export function roundShown(permissions: readonly string[]): boolean {
  return permissions.includes("care.plan.read");
}

const TIME_CHIPS: Record<RoundTask["timeState"], Omit<SafetyChip, "label">> = {
  upcoming: { status: "neutral", icon: "clock" },
  due: { status: "due", icon: "clock" },
  overdue: { status: "overdue", icon: "circle-alert" },
  escalated: { status: "overdue", icon: "triangle-alert" },
  closed: { status: "done", icon: "circle-check" },
};

/** Upcoming, due, overdue, escalated or closed, in an icon and words. */
export function timeStateChip(state: string, t: Translator): SafetyChip {
  const known = TIME_CHIPS[state as RoundTask["timeState"]];
  return {
    ...(known ?? { status: "overdue", icon: "triangle-alert" }),
    label: t("care.round.timeState", { state }),
  };
}

/** What can be done to a task from the round, by its status and what the viewer may write. */
export interface RoundTaskActions {
  readonly start: boolean;
  /** Done straight from the round; a task that needs a record is done by recording it. */
  readonly done: boolean;
  /** Recorded in the chart or note it asks for, which completes it (evidence required). */
  readonly recordFirst: boolean;
  readonly skip: boolean;
}

export function roundTaskActions(
  task: Pick<RoundTask, "status" | "evidenceRequired">,
  canWrite: boolean,
): RoundTaskActions {
  const open = task.status === "open" || task.status === "in_progress";
  const may = canWrite && open;
  return {
    start: may && task.status === "open",
    done: may && !task.evidenceRequired,
    recordFirst: may && task.evidenceRequired,
    skip: may,
  };
}

/** The view limited to one person's stops, when asked for; areas left empty are dropped. */
export function forPerson(view: Pick<RoundView, "areas">, personId: string | null) {
  if (!personId) return view.areas;
  return view.areas
    .map((area) => ({ ...area, stops: area.stops.filter((s) => s.personId === personId) }))
    .filter((area) => area.stops.length > 0);
}

/** Counts of the tasks shown, by time state, for the summary line. */
export function roundCounts(
  areas: RoundView["areas"],
): Record<"overdue" | "due" | "upcoming", number> {
  const counts = { overdue: 0, due: 0, upcoming: 0 };
  for (const area of areas) {
    for (const stop of area.stops) {
      for (const task of stop.tasks) {
        if (task.timeState === "overdue" || task.timeState === "escalated") counts.overdue += 1;
        else if (task.timeState === "due") counts.due += 1;
        else if (task.timeState === "upcoming") counts.upcoming += 1;
      }
    }
  }
  return counts;
}
