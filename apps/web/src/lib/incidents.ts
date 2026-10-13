import type {
  ClassifierView,
  IncidentPersonItem,
  IncidentSummary,
  StatutoryNotificationSummary,
} from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";
import { formatDateTime } from "./format";

/**
 * View logic for the incident screens (docs/specs/safety.md; register rows SAFE-001 and
 * SAFE-002; hazard HZ-013). Pure and unit tested. Every status is the API's; the web says it in
 * the catalogue's words with an icon, and a value it does not know warns, never reads as calm.
 */

export type SafetyIcon = "circle-alert" | "clock" | "circle-check" | "search" | "triangle-alert";

export interface SafetyChip {
  readonly status: "overdue" | "due" | "done" | "info";
  readonly icon: SafetyIcon;
  readonly label: string;
}

const STATUS_CHIPS: Record<IncidentSummary["status"], Omit<SafetyChip, "label">> = {
  open: { status: "due", icon: "clock" },
  under_review: { status: "info", icon: "search" },
  closed: { status: "done", icon: "circle-check" },
};

/** Where an incident stands: open, under review or closed; one the web does not know warns. */
export function incidentStatusChip(status: string, t: Translator): SafetyChip {
  const known = STATUS_CHIPS[status as IncidentSummary["status"]];
  return {
    ...(known ?? { status: "overdue", icon: "circle-alert" }),
    label: t("safety.incident.status", { status }),
  };
}

/** "Fall, 12/10/2026 14:05": the incident's heading and link, unique with its time. */
export function incidentTitle(
  item: Pick<IncidentSummary, "type" | "occurredAt">,
  t: Translator,
): string {
  return t("safety.incident.title", {
    type: t("safety.incident.type", { type: item.type }),
    dateTime: formatDateTime(item.occurredAt) ?? t("common.notRecorded"),
  });
}

/** The API's limit on one list of incidents (`GET /v1/incidents`). */
export const INCIDENT_LIST_LIMIT = 500;

/**
 * The newest incidents with every open or under-review one fetched besides, newest first, so an
 * older incident still waiting for answers is never hidden by the list's limit (HZ-013).
 * `truncated` says a list hit the limit, so older incidents may be missing.
 */
export function incidentsToList<I extends Pick<IncidentSummary, "id" | "occurredAt">>(
  newest: readonly I[],
  ...unfinished: readonly (readonly I[])[]
): { readonly items: I[]; readonly truncated: boolean } {
  const byId = new Map<string, I>();
  for (const item of [newest, ...unfinished].flat()) byId.set(item.id, item);
  return {
    items: [...byId.values()].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)),
    truncated: [newest, ...unfinished].some((list) => list.length >= INCIDENT_LIST_LIMIT),
  };
}

export interface SafetyNotice {
  readonly title: string;
  readonly body: string;
}

/** The sidebar's Incidents label, only for holders of `safety.incident.read`. */
export function incidentsNavLabel(permissions: readonly string[], t: Translator) {
  return permissions.includes("safety.incident.read") ? t("shell.nav.incidents") : undefined;
}

/**
 * A statutory notification's clock (safety.md section 4): overdue (a "without delay" kind is due
 * when the incident happened, so overdue at once until done), due, or done with how it ended.
 * The due time is shown beside it. A clock the web does not know warns.
 */
export function notificationClockChip(
  item: Pick<StatutoryNotificationSummary, "clock" | "status">,
  t: Translator,
): SafetyChip {
  switch (item.clock) {
    case "overdue":
      return {
        status: "overdue",
        icon: "circle-alert",
        label: t("safety.notification.clock", { clock: "overdue" }),
      };
    case "due":
      return {
        status: "due",
        icon: "clock",
        label: t("safety.notification.clock", { clock: "due" }),
      };
    case "done":
      return {
        status: "done",
        icon: "circle-check",
        label: t("safety.notification.status", { status: item.status }),
      };
    default:
      return {
        status: "overdue",
        icon: "triangle-alert",
        label: t("safety.notification.clock", { clock: "unknown" }),
      };
  }
}

const CLOCK_ORDER: Record<string, number> = { overdue: 0, due: 1, done: 2 };

/** Overdue first, then due soonest first, then done: what needs doing comes first. */
export function notificationsInOrder<
  N extends Pick<StatutoryNotificationSummary, "clock" | "dueAt">,
>(items: readonly N[]): N[] {
  return [...items].sort(
    (a, b) =>
      (CLOCK_ORDER[a.clock] ?? -1) - (CLOCK_ORDER[b.clock] ?? -1) ||
      Date.parse(a.dueAt) - Date.parse(b.dueAt),
  );
}

/**
 * The warnings on a draft: no longer indicated, or else provisional (an answer of not sure), and
 * a Harbour target. The API keeps a draft provisional after the answer changes, but one no longer
 * indicated does not rest on that answer any more, so it says only that.
 */
export function notificationWarnings(
  item: Pick<StatutoryNotificationSummary, "provisional" | "noLongerIndicated" | "statutory">,
  t: Translator,
): string[] {
  return [
    ...(item.noLongerIndicated
      ? [t("safety.notification.noLongerIndicated")]
      : item.provisional
        ? [t("safety.notification.provisional")]
        : []),
    ...(item.statutory ? [] : [t("safety.notification.harbourTarget")]),
  ];
}

/** The kind of notification in the catalogue's words, never the API's English label. */
export function notificationKindLabel(kind: string, t: Translator): string {
  return t("safety.notification.kind", { kind });
}

export interface NotificationsView {
  /** Warnings that come before the list: never read as "nothing to do". */
  readonly notices: readonly SafetyNotice[];
  /** Notifications that may be needed once the open questions are answered. */
  readonly pending: readonly string[];
  /** Says none was found, only when nothing is open and the nation's law is checked. */
  readonly none: string | null;
}

/**
 * What the notifications section says around its list (safety.md section 5; HZ-013): not checked
 * yet, outside England, questions still to answer and the kinds waiting for them warn; "none
 * found" is said only when nothing is open.
 */
export function notificationsView(
  classifier: Pick<
    ClassifierView,
    "nationSupported" | "openQuestions" | "pending" | "notifications"
  > | null,
  t: Translator,
): NotificationsView {
  const notice = (notice: string, count = 0) => ({
    title: t("safety.notification.notice", { notice, count }),
    body: t("safety.notification.noticeHint", { notice }),
  });
  if (!classifier) return { notices: [notice("notChecked")], pending: [], none: null };
  if (!classifier.nationSupported) return { notices: [notice("nation")], pending: [], none: null };
  const count = classifier.openQuestions.length;
  const pending = classifier.pending.map((p) =>
    t("safety.notification.pending", { kind: notificationKindLabel(p.kind, t) }),
  );
  return {
    notices: count > 0 ? [notice("questions", count)] : [],
    pending,
    none:
      count === 0 && pending.length === 0 && classifier.notifications.length === 0
        ? t("safety.notification.none")
        : null,
  };
}

/** What was recorded about someone on an incident, beyond their name and role. */
export function incidentPersonFacts(
  person: Pick<
    IncidentPersonItem,
    "died" | "learningDisability" | "autistic" | "subjectToMentalHealthAct" | "bodyMapMarkIds"
  >,
  t: Translator,
): string[] {
  const fact = (on: boolean | null, fact: string) =>
    on ? [t("safety.incident.personFact", { fact })] : [];
  return [
    ...fact(person.died, "died"),
    ...fact(person.learningDisability, "learningDisability"),
    ...fact(person.autistic, "autistic"),
    ...fact(person.subjectToMentalHealthAct, "mentalHealthAct"),
    ...(person.bodyMapMarkIds.length > 0
      ? [t("safety.incident.bodyMapMarks", { count: person.bodyMapMarkIds.length })]
      : []),
  ];
}

/**
 * Who someone on an incident is, in words: a person using the service by the name the API gave
 * for them, a member of staff, or the name recorded for someone not at work.
 */
export function incidentPersonLine(
  person: Pick<IncidentPersonItem, "kind" | "role" | "personId" | "otherName">,
  names: ReadonlyMap<string, string>,
  t: Translator,
): string {
  const name =
    (person.personId ? names.get(person.personId) : undefined) ??
    person.otherName ??
    t("safety.incident.unnamed", { kind: person.kind });
  return t("safety.incident.person", { name, role: person.role });
}
