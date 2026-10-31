import type { WorkflowInstanceItem } from "@harbour/contracts";
import { LISTED_WORKFLOW_PERMISSIONS } from "@harbour/domain";
import type { Translator } from "@harbour/i18n";
import { formatDateTime } from "./format";
import type { IncidentManageView } from "./incident-review";
import type { SafetyChip } from "./incidents";

/**
 * The approvals screen (PLAT-011; platform.md, task and workflow engine): pure and unit tested.
 * The API (`GET /v1/workflows`) lists open workflow records in the reader's scope with their
 * deadline state and the steps open to the reader; these helpers group, name and link them. Every
 * step is taken on the record's own route, which checks the module's rules and separation of
 * duties again; an unknown workflow, state or deadline state never reads as calm.
 */

export const APPROVALS_PAGE = "/approvals";

/** Shown to anyone who holds a permission some listed step needs (the API's own check). */
export function approvalsShown(permissions: readonly string[]): boolean {
  return LISTED_WORKFLOW_PERMISSIONS.some((p) => permissions.includes(p));
}

export type ApprovalGroup = "yours" | "raised" | "other";

/**
 * Waiting for the reader's approval first, then what they raised that waits for someone else,
 * then every other open record they have a part in; each record in one group only, in the API's
 * order. One list (`view=all`) gives all three.
 */
export function approvalGroups(
  items: readonly WorkflowInstanceItem[],
): Record<ApprovalGroup, WorkflowInstanceItem[]> {
  return {
    yours: items.filter((i) => i.awaitingYourApproval),
    raised: items.filter((i) => !i.awaitingYourApproval && i.raisedByYou),
    other: items.filter((i) => !i.awaitingYourApproval && !i.raisedByYou),
  };
}

/**
 * The item's heading, told apart from others of its kind by when it was raised (never a name):
 * "Incident, raised 31/10/2026 12:16".
 */
export function workflowItemTitle(item: WorkflowInstanceItem, t: Translator): string {
  return t("approvals.itemTitle", {
    workflow: workflowLabel(item.definitionKey, t),
    when: formatDateTime(item.startedAt) ?? "",
  });
}

/** "Incident", "Statutory notification" and so on; "Record" for one the web does not know. */
export function workflowLabel(definitionKey: string, t: Translator): string {
  return t("approvals.workflow", { key: definitionKey.replace(/\./g, "_") });
}

/** States where something is waiting to be done: shown as due, with a clock. */
const WAITING_STATES = new Set([
  "open",
  "threshold_assessment",
  "verbal_due",
  "written_due",
  "draft",
  "ready",
  "awaiting_review",
  "declared",
  "planned",
  "recorded",
  "awaiting_return",
  "received",
  "acknowledged",
  "appealed",
]);
/** States where the work is under way: shown as in progress, with a magnifying glass. */
const IN_PROGRESS_STATES = new Set([
  "under_review",
  "enquiries_open",
  "reviewed",
  "referred",
  "left",
  "investigating",
  "responded",
  "appeal_responded",
]);

/**
 * The state as an icon and a word. An outage that has ended waits to be reconciled, so its
 * "closed" reads that way; a state the web does not know is a warning, never a fact.
 */
export function workflowStateChip(item: WorkflowInstanceItem, t: Translator): SafetyChip {
  if (item.definitionKey === "operations.outage" && item.state === "closed") {
    return {
      status: "due",
      icon: "clock",
      label: t("approvals.state", { state: "outage_closed" }),
    };
  }
  const label = t("approvals.state", { state: item.state });
  if (WAITING_STATES.has(item.state)) return { status: "due", icon: "clock", label };
  if (IN_PROGRESS_STATES.has(item.state)) return { status: "info", icon: "search", label };
  return {
    status: "overdue",
    icon: "triangle-alert",
    label: t("approvals.state", { state: "unknown" }),
  };
}

const timeOnly = (iso: string) => formatDateTime(iso)?.split(" ").slice(1).join(" ") ?? "";

/** Where the record stands against its deadline, as an icon and words with the UK date. */
export function slaChip(item: WorkflowInstanceItem, t: Translator): SafetyChip {
  const when = formatDateTime(item.slaDueAt) ?? "";
  switch (item.slaState) {
    case "overdue":
      return {
        status: "overdue",
        icon: "circle-alert",
        label: t("approvals.sla", { state: "overdue", when, time: "" }),
      };
    case "due_today":
      return {
        status: "due",
        icon: "clock",
        label: t("approvals.sla", {
          state: "due_today",
          when,
          time: item.slaDueAt ? timeOnly(item.slaDueAt) : "",
        }),
      };
    case "on_track":
      return {
        status: "neutral",
        icon: "clock",
        label: t("approvals.sla", { state: "on_track", when, time: "" }),
      };
    case "on_record":
      // The deadline is on the record and the list does not have it: never "no deadline" (HZ-013).
      return {
        status: "due",
        icon: "triangle-alert",
        label: t("approvals.sla", { state: "on_record", when: "", time: "" }),
      };
    case "none":
      return {
        status: "neutral",
        icon: "circle-minus",
        label: t("approvals.sla", { state: "none", when: "", time: "" }),
      };
    default:
      // A deadline state the web does not know is a warning, never "no deadline".
      return {
        status: "overdue",
        icon: "triangle-alert",
        label: t("approvals.state", { state: "unknown" }),
      };
  }
}

/** The record's own page, where its steps are taken; null when the web has none for it. */
export function workflowLink(item: WorkflowInstanceItem): string | null {
  switch (item.subjectType) {
    case "incident":
      return `/incidents/${item.subjectId}`;
    case "candour_record":
      return item.incidentId ? `/incidents/${item.incidentId}` : null;
    case "statutory_notification":
      return `/notifications/statutory/${item.subjectId}`;
    case "outage":
      return item.locationId ? `/downtime/${item.locationId}/outages/${item.subjectId}` : null;
    case "exit_record":
      return item.personId ? `/people/${item.personId}` : null;
    case "dols_legal_change_review":
      return item.personId ? `/people/${item.personId}/dols` : null;
    default:
      return null;
  }
}

/** Who raised it, or that Harbour started it (a job, for example a DoLS review). */
export function raisedByLine(item: WorkflowInstanceItem, t: Translator): string {
  return item.createdBy
    ? t("approvals.raisedBy", { name: item.createdBy.displayName })
    : t("approvals.startedByHarbour");
}

/**
 * An incident whose closing the reader may approve here: the API marks it waiting for the reader
 * and sends what the forms need (its version, whether closing is held back).
 */
export function isIncidentApproval(item: WorkflowInstanceItem): boolean {
  return (
    item.subjectType === "incident" &&
    item.definitionKey === "safety.incident" &&
    item.awaitingYourApproval &&
    item.incident !== null &&
    item.moves.some((m) => m.to === "closed" && m.approval)
  );
}

/**
 * The incident forms this page offers, from the steps and facts the API returned for the reader
 * where the incident is (#130 review rounds 1 and 2), never from permissions held elsewhere:
 * close with a reason, or what must be done first; and send it back to open when under review.
 */
export function incidentApprovalView(item: WorkflowInstanceItem): IncidentManageView | null {
  if (!isIncidentApproval(item) || !item.incident) return null;
  const review = item.moves.some((m) => m.to === "open") ? "open" : null;
  if (item.incident.closeBlocked) {
    return { review, close: { kind: "blocked", notifications: [], questions: 0 } };
  }
  return { review, close: { kind: "form" } };
}
