import { type TaskStatus, type TaskTimeState, taskTimeState } from "../platform/tasks";

/**
 * The round view (master prompt 10.1, "round view by corridor or run"): the tasks of a shift laid
 * out the way staff walk the building, by floor or area, then room, then due time. Unfinished tasks
 * from before the window stay on the round until they are done or skipped with a reason.
 */

export interface RoundPerson {
  readonly personId: string;
  /** The room's floor or corridor; people without one are listed last. */
  readonly area: string | null;
  readonly roomLabel: string | null;
}

export interface RoundTask {
  readonly id: string;
  readonly personId: string | null;
  readonly title: string;
  readonly status: TaskStatus;
  readonly dueAt: Date;
  readonly windowStart: Date | null;
  readonly windowEnd: Date | null;
}

export interface RoundEntry {
  readonly id: string;
  readonly title: string;
  readonly dueAt: Date;
  readonly state: TaskTimeState;
}

export interface RoundStop {
  readonly personId: string | null;
  readonly roomLabel: string | null;
  readonly tasks: readonly RoundEntry[];
}

export interface RoundArea {
  readonly area: string | null;
  readonly stops: readonly RoundStop[];
}

const collator = new Intl.Collator("en-GB", { numeric: true, sensitivity: "base" });

function compareNullable(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return collator.compare(a, b);
}

/**
 * Open tasks due before `to` (this round's and unfinished ones from earlier), plus later tasks
 * whose window is already open, grouped by area and room. Rooms sort naturally (Room 2 before Room 10). Tasks not tied to a person (for
 * example a fridge temperature check) form their own stop at the end of the area-less group.
 */
export function roundView(
  tasks: readonly RoundTask[],
  people: readonly RoundPerson[],
  window: { readonly from: Date; readonly to: Date },
  now: Date,
  escalateAfterMinutes: number,
): RoundArea[] {
  const byPerson = new Map(people.map((p) => [p.personId, p]));
  const stops = new Map<
    string,
    {
      area: string | null;
      stop: { personId: string | null; roomLabel: string | null; tasks: RoundEntry[] };
    }
  >();

  for (const t of tasks) {
    const state = taskTimeState(t, now, escalateAfterMinutes);
    if (state === "closed") continue;
    // Due before the round ends (including unfinished tasks from earlier rounds, whatever their
    // state), or due later but already inside its window: nothing open and actionable is hidden.
    const dueBeforeEnd = t.dueAt.getTime() < window.to.getTime();
    const windowOpen = (t.windowStart ?? t.dueAt).getTime() <= now.getTime();
    if (!dueBeforeEnd && !windowOpen) continue;
    const person = t.personId ? byPerson.get(t.personId) : undefined;
    const key = t.personId ?? "-";
    const entry = stops.get(key) ?? {
      area: person?.area ?? null,
      stop: { personId: t.personId, roomLabel: person?.roomLabel ?? null, tasks: [] },
    };
    entry.stop.tasks.push({ id: t.id, title: t.title, dueAt: t.dueAt, state });
    stops.set(key, entry);
  }

  const areas = new Map<string | null, RoundStop[]>();
  for (const { area, stop } of stops.values()) {
    stop.tasks.sort(
      (a, b) => a.dueAt.getTime() - b.dueAt.getTime() || collator.compare(a.title, b.title),
    );
    areas.set(area, [...(areas.get(area) ?? []), stop]);
  }
  return [...areas.entries()]
    .sort(([a], [b]) => compareNullable(a, b))
    .map(([area, list]) => ({
      area,
      stops: list.sort(
        (a, b) =>
          (a.personId === null ? 1 : 0) - (b.personId === null ? 1 : 0) ||
          compareNullable(a.roomLabel, b.roomLabel),
      ),
    }));
}
