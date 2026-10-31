/**
 * What the detail pane of a tablet split view shows (MOB-013), decided from what the reader chose
 * and what the phone holds now, never from a position in a list (HZ-001). Pure, so every case of a
 * list re-sorting, sync removing a row or a person leaving is unit-tested.
 */

/** A person chosen beside the round, with the name and task title as the round showed them. */
export interface RoundChoice {
  readonly personId: string;
  /** The person's name as the round card showed it when chosen; the pane's heading uses it. */
  readonly personName: string;
  /** The task the record was opened to answer, or null for "Show record". */
  readonly task: string | null;
  readonly taskTitle: string | null;
}

/** What the round needs to know of each task on it. */
export interface RoundEntry {
  readonly id: string;
  readonly personId: string | null;
  readonly person: string | null;
}

export type RoundPane =
  | { readonly kind: "none" }
  | {
      readonly kind: "person";
      readonly personId: string;
      /** The heading's name: the round's current name for the person, which re-reads as sync renames. */
      readonly personName: string;
      /** The task still open on the round, or null. */
      readonly task: string | null;
      /** The title of a task chosen for evidence that is no longer on the round, to say so in words. */
      readonly taskGone: string | null;
    };

/**
 * The person stays in the pane only while the round still has a task about them; a task chosen for
 * evidence that has left the round is dropped and said in words, never silently.
 */
export function roundPane(choice: RoundChoice | null, entries: readonly RoundEntry[]): RoundPane {
  if (!choice) return { kind: "none" };
  const theirs = entries.filter((e) => e.personId === choice.personId);
  if (theirs.length === 0) return { kind: "none" };
  const taskOpen = choice.task !== null && theirs.some((e) => e.id === choice.task);
  return {
    kind: "person",
    personId: choice.personId,
    personName: theirs[0]?.person ?? choice.personName,
    task: taskOpen ? choice.task : null,
    taskGone: choice.task !== null && !taskOpen ? (choice.taskTitle ?? "") : null,
  };
}

/** The person chosen on People: shown only while they are in the list, found by id. */
export function chosenPerson<P extends { readonly id: string }>(
  people: readonly P[],
  chosen: string | null | undefined,
): P | null {
  if (!chosen) return null;
  return people.find((p) => p.id === chosen) ?? null;
}

export type HomePane<H> =
  | { readonly kind: "home"; readonly home: H; readonly chosen: boolean }
  | { readonly kind: "choose" }
  | { readonly kind: "gone" };

/**
 * The home whose handover is read beside the list. With one home it is shown without a choice;
 * with more, only the home the reader chose, so a sync that adds or re-orders homes never swaps
 * the handover (and its acknowledgement) under the reader. A chosen home that leaves the phone
 * says so rather than falling back to another.
 */
export function homePane<H extends { readonly location: { readonly id: string } }>(
  homes: readonly H[],
  chosen: string | null,
): HomePane<H> {
  if (chosen !== null) {
    const home = homes.find((h) => h.location.id === chosen);
    return home ? { kind: "home", home, chosen: true } : { kind: "gone" };
  }
  const only = homes.length === 1 ? homes[0] : undefined;
  return only ? { kind: "home", home: only, chosen: false } : { kind: "choose" };
}
