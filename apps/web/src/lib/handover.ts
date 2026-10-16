import type {
  HandoverDetail,
  HandoverItem,
  HandoverNoteItem,
  HandoverSummary,
} from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";
import { formatDateTime } from "./format";
import type { SafetyChip } from "./incidents";

/**
 * View logic for the shift handover screens (care.md rule 14; register row COMMS-006; hazards
 * HZ-001 and HZ-008). Pure and unit tested. Items are references to records, never their text:
 * each says what it is in words with an icon and links to its record. Every state is the API's;
 * one the web does not know warns, never reads as calm.
 */

/** Who may open the handover screens. */
export function handoverShown(permissions: readonly string[]): boolean {
  return permissions.includes("care.handover.manage");
}

/** The handover of the shift running now, if it has been compiled. */
export function currentHandover<S extends Pick<HandoverSummary, "shift">>(
  list: readonly S[],
  now: Date = new Date(),
): S | null {
  const at = now.getTime();
  return list.find((h) => Date.parse(h.shift.start) <= at && at < Date.parse(h.shift.end)) ?? null;
}

/** "Day shift, 16/10/2026 08:00 to 16/10/2026 20:00". */
export function shiftTitle(summary: Pick<HandoverSummary, "shift">, t: Translator): string {
  return t("care.handover.shiftTitle", {
    name: summary.shift.name,
    from: formatDateTime(summary.shift.start) ?? "",
    to: formatDateTime(summary.shift.end) ?? "",
  });
}

/** Open for notes, or locked, and whether the incoming shift has acknowledged it in time. */
export function handoverChips(
  summary: Pick<HandoverSummary, "open" | "unacknowledged">,
  t: Translator,
): SafetyChip[] {
  const chips: SafetyChip[] = [
    summary.open
      ? { status: "info", icon: "file-pen", label: t("care.handover.state", { state: "open" }) }
      : {
          status: "notApplicable",
          icon: "circle-minus",
          label: t("care.handover.state", { state: "locked" }),
        },
  ];
  if (summary.unacknowledged === true) {
    chips.push({
      status: "overdue",
      icon: "circle-alert",
      label: t("care.handover.unacknowledged"),
    });
  }
  return chips;
}

/** Where the reader stands: acknowledged, or with items still to read. */
export function youChip(
  you: Pick<HandoverDetail["you"], "acknowledged" | "unseenKeys">,
  t: Translator,
): SafetyChip {
  if (you.unseenKeys.length > 0) {
    return {
      status: "due",
      icon: "clock",
      label: t("care.handover.youUnseen", { count: you.unseenKeys.length }),
    };
  }
  return you.acknowledged
    ? { status: "done", icon: "circle-check", label: t("care.handover.youAcknowledged") }
    : { status: "due", icon: "clock", label: t("care.handover.youToAcknowledge") };
}

const URGENT = new Set<string>(["fall", "news2", "incident", "alert"]);
const TASKS = new Set<string>([
  "overdue_task",
  "skipped_task",
  "unfinished_task",
  "must_follow_up",
]);

/** What an item is, in words with an icon; the most urgent kinds stand out by icon and word. */
export function itemKindChip(kind: string, t: Translator): SafetyChip {
  const label = t("care.handover.kind", { kind });
  if (URGENT.has(kind)) return { status: "overdue", icon: "triangle-alert", label };
  if (TASKS.has(kind)) return { status: "due", icon: "clock", label };
  if (kind === "body_map_mark" || kind === "flagged_note" || kind === "refusal") {
    return { status: "info", icon: "search", label };
  }
  return { status: "overdue", icon: "circle-alert", label };
}

/** The record an item comes from, as a page of the web record; null when it has none here. */
export function itemSourceHref(
  item: Pick<HandoverItem, "sourceType" | "sourceId" | "personId">,
): string | null {
  const person = item.personId ? `/people/${item.personId}` : null;
  switch (item.sourceType) {
    case "incident":
      return `/incidents/${item.sourceId}`;
    case "observation":
      return person ? `${person}/charts` : null;
    case "body_map_mark":
      return person ? `${person}/body-map` : null;
    case "care_note":
      return person ? `${person}/notes` : null;
    case "notification":
      return "/notifications";
    case "task":
      return person;
    default:
      return null;
  }
}

export interface HandoverGroup {
  /** The person the items are about; null for items about no one person. */
  readonly personId: string | null;
  readonly items: readonly {
    readonly item: HandoverItem;
    readonly notes: readonly HandoverNoteItem[];
  }[];
}

/**
 * The items by person, in the order the API compiled them (most urgent first), each with its
 * notes; the notes on the whole handover are returned apart.
 */
export function groupHandover(detail: Pick<HandoverDetail, "items" | "notes">): {
  readonly groups: HandoverGroup[];
  readonly generalNotes: HandoverNoteItem[];
} {
  const notesByItem = new Map<string, HandoverNoteItem[]>();
  const generalNotes: HandoverNoteItem[] = [];
  for (const note of detail.notes) {
    if (note.itemKey === null) generalNotes.push(note);
    else notesByItem.set(note.itemKey, [...(notesByItem.get(note.itemKey) ?? []), note]);
  }
  const groups = new Map<
    string,
    { personId: string | null; items: HandoverGroup["items"][number][] }
  >();
  for (const item of detail.items) {
    const key = item.personId ?? "";
    const group = groups.get(key) ?? { personId: item.personId, items: [] };
    group.items.push({ item, notes: notesByItem.get(item.key) ?? [] });
    groups.set(key, group);
  }
  return { groups: [...groups.values()], generalNotes };
}
