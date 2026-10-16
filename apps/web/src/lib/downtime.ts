import type {
  DowntimePackOut,
  EntryBackEntry,
  Me,
  OutageItem,
  OutageReconciliation,
} from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";
import { formatDate, formatDateTime } from "./format";
import type { SafetyChip } from "./incidents";
import { formatUkTime } from "./uk-time";

/**
 * View logic for the downtime screens (docs/specs/operations.md sections 12 to 14; OPS-028;
 * hazards HZ-017 and HZ-021). Pure and unit tested. Every state is the API's; the web says it in
 * the catalogue's words with an icon, and a state it does not know warns, never reads as calm.
 */

export const OUTAGE_KINDS = [
  "power",
  "network",
  "harbour_unavailable",
  "device_failure",
  "planned_maintenance",
  "other",
] as const satisfies readonly OutageItem["kind"][];

const OUTAGE_CHIPS: Record<OutageItem["state"], Omit<SafetyChip, "label">> = {
  declared: { status: "due", icon: "clock" },
  closed: { status: "due", icon: "file-pen" },
  reconciled: { status: "done", icon: "circle-check" },
  cancelled: { status: "notApplicable", icon: "circle-minus" },
};

/** Where an outage stands: open, closed with paper records to enter, reconciled or cancelled. */
export function outageStateChip(state: string, t: Translator): SafetyChip {
  const known = OUTAGE_CHIPS[state as OutageItem["state"]];
  return {
    ...(known ?? { status: "overdue", icon: "circle-alert" }),
    label: t("operations.outage.state", { state }),
  };
}

const FRESHNESS_CHIPS: Record<DowntimePackOut["freshness"]["state"], Omit<SafetyChip, "label">> = {
  current: { status: "done", icon: "circle-check" },
  outage: { status: "due", icon: "clock" },
  out_of_date: { status: "overdue", icon: "triangle-alert" },
  clock_behind: { status: "overdue", icon: "triangle-alert" },
};

/** Whether the pack can be used as it is (HZ-021); a state the web does not know warns. */
export function packFreshnessChip(state: string, t: Translator): SafetyChip {
  const known = FRESHNESS_CHIPS[state as DowntimePackOut["freshness"]["state"]];
  return {
    ...(known ?? { status: "overdue", icon: "triangle-alert" }),
    label: t("operations.pack.freshness", { state }),
  };
}

/** "Power cut, from 16/10/2026 09:00": an outage's heading and link, unique with its start. */
export function outageTitle(item: Pick<OutageItem, "kind" | "startedAt">, t: Translator): string {
  return t("operations.outage.title", {
    kind: t("operations.outage.kind", { kind: item.kind }),
    dateTime: formatDateTime(item.startedAt) ?? t("common.notRecorded"),
  });
}

/** "From 16/10/2026 09:00 to 16/10/2026 11:30", or "still open" when it has not ended. */
export function outageWindow(item: Pick<OutageItem, "startedAt" | "endedAt">, t: Translator) {
  const from = formatDateTime(item.startedAt) ?? t("common.notRecorded");
  const to = formatDateTime(item.endedAt);
  return to ? t("operations.outage.window", { from, to }) : t("operations.outage.open", { from });
}

/** What the location page offers: only what the viewer's permissions allow at this location. */
export interface DowntimeAccess {
  /** `operations.downtime.read`: open and print the pack (with a fresh sign-in). */
  readonly pack: boolean;
  /** `operations.downtime.manage`: declare, close, reconcile, cancel and correct outages. */
  readonly manage: boolean;
  /** `people.person.read`: see the outages, to enter a paper record against one. */
  readonly outages: boolean;
}

/**
 * The location must be one the viewer works at (`/v1/me` locations) and the permission held
 * (ADR-0071). `/v1/me` has no per-location `reaching` list yet, so a permission held only at
 * another home can still show an action here; the API refuses it in words and the location reads
 * as not found (an API gap logged in docs/plans/STATUS.md).
 */
export function downtimeAccess(
  me: Pick<Me, "permissions" | "locations">,
  locationId: string,
): DowntimeAccess | null {
  if (!me.locations.some((l) => l.id === locationId)) return null;
  const has = (permission: string) => me.permissions.includes(permission);
  return {
    pack: has("operations.downtime.read"),
    manage: has("operations.downtime.manage"),
    outages: has("people.person.read"),
  };
}

/** Downtime is in the navigation for those who open the pack or manage outages. */
export function downtimeNavShown(permissions: readonly string[]): boolean {
  return (
    permissions.includes("operations.downtime.read") ||
    permissions.includes("operations.downtime.manage")
  );
}

/** What can be done to an outage now, by its state (operations.md rules 9 to 15). */
export interface OutageActions {
  readonly close: boolean;
  readonly cancel: boolean;
  readonly correct: boolean;
  readonly reconcile: boolean;
}

export function outageActions(state: string, manage: boolean): OutageActions {
  const open = state === "declared";
  return {
    close: manage && open,
    // Only an open outage declared in error; the API refuses once a paper record cites it.
    cancel: manage && open,
    correct: manage && (open || state === "closed"),
    reconcile: manage && state === "closed",
  };
}

/** One thing the reconciler must look at before reconciling, with the entries it covers. */
export interface ReviewItem {
  readonly key: string;
  readonly kind: "duplicate" | "outside";
  readonly entryIds: readonly string[];
}

/**
 * Every possible duplicate group and every back-entry outside the window with no reason, each to
 * be reviewed before the outage is reconciled (operations.md section 12, #38 review round 2).
 */
export function reviewItems(
  reconciliation: Pick<OutageReconciliation, "duplicateGroups" | "outsideWindowEntryIds">,
): ReviewItem[] {
  return [
    ...reconciliation.duplicateGroups
      .filter((group) => group.length > 0)
      .map((group, index) => ({
        key: `duplicate-${index}`,
        kind: "duplicate" as const,
        entryIds: group,
      })),
    ...reconciliation.outsideWindowEntryIds.map((id) => ({
      key: `outside-${id}`,
      kind: "outside" as const,
      entryIds: [id],
    })),
  ];
}

/** The reviewed entry ids to send, from the items ticked; null while any item is not ticked. */
export function reviewedEntryIds(
  items: readonly ReviewItem[],
  ticked: ReadonlySet<string>,
): string[] | null {
  if (items.some((item) => !ticked.has(item.key))) return null;
  return [...new Set(items.flatMap((item) => item.entryIds))];
}

/** A short reference for an entry the reviewer can match in the record's history. */
export function entryReference(id: string): string {
  return id.slice(-8).toUpperCase();
}

/** Why printing came back to the location page instead of downloading. */
export type PrintProblem = "limited" | "unavailable" | "forbidden" | "failed";

const PRINT_PROBLEMS: readonly PrintProblem[] = ["limited", "unavailable", "forbidden", "failed"];

export function printProblem(value: string | undefined): PrintProblem | null {
  return PRINT_PROBLEMS.find((p) => p === value) ?? null;
}

/** When the pack can be opened again, from the API's Retry-After (seconds); null when not said. */
export function retryAt(retryAfter: string | null, now: Date = new Date()): string | null {
  const seconds = Number(retryAfter);
  if (!retryAfter || !Number.isFinite(seconds) || seconds < 0 || seconds > 86_400) return null;
  return new Date(now.getTime() + Math.ceil(seconds) * 1000).toISOString();
}

/** The words for a refused print or open, with when it can be opened again over the limit. */
export function printProblemWords(
  problem: PrintProblem,
  from: string | null,
  t: Translator,
): { readonly title: string; readonly hint: string } {
  const time = problem === "limited" ? formatUkTime(from) : null;
  return {
    title: t("operations.pack.printProblem", { problem }),
    hint: time
      ? t("operations.pack.limitedUntil", { time })
      : t("operations.pack.printProblemHint", { problem }),
  };
}

/** Where the print route sends the person when the API does not give a PDF. */
export function printFailureTarget(
  locationId: string,
  status: number,
  code: string | undefined,
  retryAfter: string | null = null,
  now: Date = new Date(),
): string {
  const page = `/downtime/${locationId}`;
  if (code === "step_up_required") {
    return `/sign-in?${new URLSearchParams({ reason: "step-up", next: page }).toString()}`;
  }
  if (code === "unauthenticated") {
    return `/sign-in?${new URLSearchParams({ next: page }).toString()}`;
  }
  if (status === 429) {
    const from = retryAt(retryAfter, now);
    return `${page}?${new URLSearchParams({ print: "limited", ...(from ? { from } : {}) }).toString()}`;
  }
  const problem: PrintProblem =
    status === 503 ? "unavailable" : status === 403 || status === 404 ? "forbidden" : "failed";
  return `${page}?print=${problem}`;
}

/**
 * The words that keep a back-entered record from reading as written at the time (rule 12;
 * HZ-017): the API's label, or, when the reader cannot see the outage, the paper date and time.
 */
export function backEntryLabel(entry: EntryBackEntry, t: Translator): string {
  if (entry.label?.trim()) return entry.label;
  return t("care.entry.backEntryFallback", {
    date: formatDate(entry.paperDate) ?? entry.paperDate,
    time: entry.paperTime,
  });
}
