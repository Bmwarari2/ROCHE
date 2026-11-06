import type { RoundTask, RoundView } from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";
import { isChart } from "./charts";
import { formatDateTime } from "./format";
import type { SafetyChip } from "./incidents";
import { staffName } from "./mca";

/**
 * View logic for the round view (care.md rule 8; register row CARE-013; hazards HZ-001, HZ-003,
 * HZ-024). Pure and unit tested. A task's time state is the API's, said in an icon and words; a
 * state the web does not know warns, never reads as calm.
 */

/** The task kind of a DoLS expiry reminder (apps/api/src/services/mca.ts, care.md rule 11). */
export const DOLS_REMINDER_KIND = "care.dols_expiry";

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

/**
 * What the round offers on a task (H-270): start, done and not done only to holders of the
 * permission the task names (`requiredPermission`), as the API checks, never to every care writer
 * with the API refusing afterwards; recording the chart or note it asks for also needs
 * `care.note.write`. The reader's permissions are where any of their roles reaches; the API's
 * scope check stays the last word.
 */
export function roundTaskActions(
  task: Pick<RoundTask, "status" | "evidenceRequired" | "requiredPermission">,
  permissions: readonly string[],
): RoundTaskActions {
  const open = task.status === "open" || task.status === "in_progress";
  const may = open && permissions.includes(task.requiredPermission);
  return {
    start: may && task.status === "open",
    done: may && !task.evidenceRequired,
    recordFirst: may && task.evidenceRequired && permissions.includes("care.note.write"),
    skip: may,
  };
}

/** Who the task is for, in words (H-270): the named member, the role, or anyone who may do it. */
export function taskForLine(
  task: Pick<RoundTask, "assigneeStaff" | "assigneeRoleKey">,
  t: Translator,
): string {
  if (task.assigneeStaff) {
    return t("care.round.forWhom", { who: "person", name: staffName(task.assigneeStaff, t) });
  }
  if (task.assigneeRoleKey) {
    return t("care.round.forWhom", {
      who: "role",
      name: t("care.plan.role", { role: task.assigneeRoleKey }),
    });
  }
  return t("care.round.forWhom", { who: "anyone", name: "" });
}

/** The view limited to one person's stops, when asked for; areas left empty are dropped. */
export function forPerson(view: Pick<RoundView, "areas">, personId: string | null) {
  if (!personId) return view.areas;
  return view.areas
    .map((area) => ({ ...area, stops: area.stops.filter((s) => s.personId === personId) }))
    .filter((area) => area.stops.length > 0);
}

/** Counts of the tasks shown, by time state, for the summary line; a state not known counts too. */
export function roundCounts(
  areas: RoundView["areas"],
): Record<"overdue" | "due" | "upcoming" | "notKnown", number> {
  const counts = { overdue: 0, due: 0, upcoming: 0, notKnown: 0 };
  for (const area of areas) {
    for (const stop of area.stops) {
      for (const task of stop.tasks) {
        if (task.timeState === "overdue" || task.timeState === "escalated") counts.overdue += 1;
        else if (task.timeState === "due") counts.due += 1;
        else if (task.timeState === "upcoming") counts.upcoming += 1;
        else if (task.timeState !== "closed") counts.notKnown += 1;
      }
    }
  }
  return counts;
}

/** "Due 25/10/2026 01:30 BST, at night, for Nell Nurse, Clinical lead": one whole message. */
export function dueLine(
  task: Pick<RoundTask, "dueAt" | "assigneeStaff" | "planAction">,
  t: Translator,
): string {
  return t("care.round.dueLine", {
    dateTime: formatDateTime(task.dueAt) ?? "",
    when: task.planAction?.whenText?.trim() || "none",
    who: task.assigneeStaff ? staffName(task.assigneeStaff, t) : "none",
  });
}

/**
 * Where the record that completes a task is made: the chart it names, the notes, the body map or
 * the activities; the person's record when the web cannot tell which.
 */
export function recordHref(
  task: Pick<RoundTask, "kind" | "evidenceType" | "personId">,
): string | null {
  if (!task.personId) return null;
  const person = `/people/${task.personId}`;
  if (isChart(task.kind)) return `${person}/charts?record=${task.kind}`;
  // A DoLS expiry reminder is dealt with in the person's DoLS register (care.md rule 11, HZ-020).
  if (task.kind === DOLS_REMINDER_KIND) return `${person}/dols`;
  switch (task.evidenceType) {
    case "observation":
      return `${person}/charts`;
    case "care_note":
      return `${person}/notes`;
    case "body_map_mark":
      return `${person}/body-map`;
    case "activity_record":
    case "visit_log":
      return `${person}/activities`;
    default:
      return person;
  }
}

const REFRESH_MS = 5 * 60_000;

/**
 * How long until the round should be read again: the next moment a task's time state can change
 * (its window opening, its due time, its window closing), or five minutes, whichever is sooner, so
 * "Still to come" never silently becomes overdue on a page left open (HZ-003).
 */
export function nextReadIn(areas: RoundView["areas"], now: number = Date.now()): number {
  let next = now + REFRESH_MS;
  for (const area of areas) {
    for (const stop of area.stops) {
      for (const task of stop.tasks) {
        for (const at of [task.windowStart, task.dueAt, task.windowEnd]) {
          const ms = at ? Date.parse(at) : Number.NaN;
          if (ms > now && ms < next) next = ms;
        }
      }
    }
  }
  return Math.max(next - now, 1_000);
}
