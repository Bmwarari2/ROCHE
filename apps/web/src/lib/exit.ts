import type { ExitOut, PersonStatus } from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";
import type { StatusChipStatus } from "@harbour/ui";

/**
 * The record's Leaving tab (people.md, "Web: leaving the service"; register row PEOP-010): which
 * actions the discharge, transfer or death workflow offers for the person's status, the exit's
 * state and the permissions reaching the person. Pure and unit tested. The web app only offers
 * what the API would take; the API checks every rule, permission, step-up and separation of
 * duties again, and nothing is offered once the record is archived.
 */

export type ExitEntry = ExitOut["checklist"][number];

export type ExitAction =
  /** Plan a discharge or transfer before the person leaves. */
  | "plan"
  /** Record a discharge or transfer (the person has left). */
  | "recordDischarge"
  | "recordDeath"
  /** Cancel a planned discharge or transfer, with a reason. */
  | "cancelPlan"
  /** Tick, or mark not required, a people, care, medicines or safety item. */
  | "items"
  /** Confirm residents' money, the deposit or the DWP (finance.ledger.approve, step-up). */
  | "financeItems"
  /** Return property and keys (people.property.manage). */
  | "returns"
  | "awaitReturns"
  | "close"
  | "archive";

const LIVE: readonly PersonStatus[] = ["active", "on_leave", "in_hospital"];
const LEFT: readonly PersonStatus[] = ["discharged", "deceased"];

/** An exit still being worked on: neither closed nor cancelled. */
export function exitOpen(exit: Pick<ExitOut, "state"> | null): boolean {
  return exit !== null && exit.state !== "closed" && exit.state !== "cancelled";
}

/** True when nothing can be added to the record: archived, or closed without admission. */
export function recordClosed(status: PersonStatus): boolean {
  return status === "archived" || status === "not_admitted";
}

/**
 * The actions the tab offers. `may(permission)` says whether the permission reaches this person
 * (`writeAccess`). An action whose checks are not yet met (awaiting returns before the checklist
 * is done) is left out here; the page says what is outstanding instead.
 */
export function exitActions(
  status: PersonStatus,
  exit: ExitOut | null,
  may: (permission: string) => boolean,
): ReadonlySet<ExitAction> {
  const actions = new Set<ExitAction>();
  if (recordClosed(status)) return actions;
  const admissions = may("people.admission.manage");
  const movements = may("people.movement.record");
  const open = exitOpen(exit);

  if (LIVE.includes(status)) {
    const planned = exit?.state === "planned";
    if (admissions && !open) actions.add("plan");
    if (admissions && (!open || planned)) actions.add("recordDischarge");
    if (movements && (!open || planned)) actions.add("recordDeath");
    if (admissions && planned) actions.add("cancelPlan");
  }

  if (open && exit && (LIVE.includes(status) ? exit.state === "planned" : LEFT.includes(status))) {
    if (admissions || movements) actions.add("items");
    if (may("finance.ledger.approve")) actions.add("financeItems");
  }

  if (LEFT.includes(status) && exit) {
    if (open && may("people.property.manage")) actions.add("returns");
    if (admissions && (exit.state === "left" || exit.state === "recorded")) {
      if (exit.status.readyForReturn) actions.add("awaitReturns");
    }
    if (admissions && open && exit.state !== "planned" && exit.status.readyToClose) {
      actions.add("close");
    }
    if (admissions && exit.state === "closed") actions.add("archive");
  }
  return actions;
}

/** Whether the viewer may change this item, with the actions the tab offers. */
export function itemEditable(entry: ExitEntry, actions: ReadonlySet<ExitAction>): boolean {
  if (entry.derived) return false;
  return entry.owner === "finance" ? actions.has("financeItems") : actions.has("items");
}

/** Where an item counted from its own records is done: its notification, or the returns. */
export function derivedLink(entry: ExitEntry):
  | { readonly kind: "notification"; readonly href: string }
  | {
      readonly kind: "returns";
      readonly href: string;
    }
  | null {
  if (!entry.derived) return null;
  if (entry.evidenceType === "statutory_notification" && entry.evidenceId) {
    return { kind: "notification", href: `/notifications/statutory/${entry.evidenceId}` };
  }
  if (entry.key === "property_returned" || entry.key === "keys_returned") {
    return { kind: "returns", href: "#returns" };
  }
  return null;
}

export interface ChipView {
  readonly status: StatusChipStatus;
  readonly icon:
    | "circle-check"
    | "clock"
    | "circle-minus"
    | "archive"
    | "door-open"
    | "flag"
    | "flower"
    | "x";
  readonly label: string;
}

/** An item's state, an icon and a word. */
export function itemChip(entry: Pick<ExitEntry, "status">, t: Translator): ChipView {
  switch (entry.status) {
    case "done":
      return { status: "done", icon: "circle-check", label: t("people.exit.item.done") };
    case "not_required":
      return {
        status: "notApplicable",
        icon: "circle-minus",
        label: t("people.exit.item.notRequired"),
      };
    default:
      return { status: "due", icon: "clock", label: t("people.exit.item.pending") };
  }
}

/** The workflow's state, an icon and a word. */
export function exitStateChip(exit: Pick<ExitOut, "state">, t: Translator): ChipView {
  const label = t("people.exit.state", { state: exit.state });
  switch (exit.state) {
    case "closed":
      return { status: "done", icon: "circle-check", label };
    case "cancelled":
      return { status: "neutral", icon: "x", label };
    case "awaiting_return":
      return { status: "due", icon: "clock", label };
    case "planned":
      return { status: "info", icon: "flag", label };
    default:
      return { status: "due", icon: "door-open", label };
  }
}

/**
 * The item's title in the catalogue's words, or the API's title for an item the catalogue does
 * not know yet (a new item reads in the API's words, never blank).
 */
export function itemTitle(
  entry: Pick<ExitEntry, "key" | "title">,
  kind: ExitOut["kind"],
  t: Translator,
): string {
  const words = t("people.exit.itemTitle", { key: entry.key, kind });
  return words.trim() === "" ? entry.title : words;
}

/** The checklist in two parts: what is done first, then returning money, property and keys. */
export function checklistParts(exit: Pick<ExitOut, "checklist">): {
  readonly first: readonly ExitEntry[];
  readonly returns: readonly ExitEntry[];
} {
  return {
    first: exit.checklist.filter((e) => !e.returnItem),
    returns: exit.checklist.filter((e) => e.returnItem),
  };
}

/** The titles of what is still outstanding, in the checklist's order. */
export function outstandingTitles(exit: ExitOut, keys: readonly string[], t: Translator): string[] {
  return exit.checklist.filter((e) => keys.includes(e.key)).map((e) => itemTitle(e, exit.kind, t));
}

/** The longest reason the API takes for "not required" and for cancelling a plan. */
export const ITEM_REASON_MAX = 500;
export const MOVE_REASON_MAX = 1000;

/**
 * The person's status as a badge beside their name, an icon and a word, for everyone not
 * receiving care as usual: before admission, away, left, died, archived. Nothing for `active`.
 */
export function personStatusChip(status: PersonStatus, t: Translator): ChipView | null {
  if (status === "active") return null;
  const label = t("platform.search.status", { status });
  switch (status) {
    case "archived":
    case "not_admitted":
      return { status: "neutral", icon: "archive", label };
    case "discharged":
      return { status: "info", icon: "door-open", label };
    case "deceased":
      return { status: "info", icon: "flower", label };
    case "on_leave":
    case "in_hospital":
      return { status: "info", icon: "flag", label };
    default:
      return { status: "neutral", icon: "flag", label };
  }
}
