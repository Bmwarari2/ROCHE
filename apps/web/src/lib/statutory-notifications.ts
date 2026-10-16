import type {
  Citation,
  StatutoryNotificationDetail,
  StatutoryNotificationSummary,
} from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";
import { deadlineLine, notificationsInOrder, type TimeLine } from "./incidents";

/**
 * View logic for the statutory notification pages (docs/specs/safety.md section 5; register rows
 * SAFE-002 and SAFE-003; hazard HZ-013). Pure and unit tested; the notification's own clock,
 * status, warnings and kind come from `./incidents`, shared with the incident page.
 */

/** The API's limit on one list of notifications (`GET /v1/notifications/statutory`). */
export const NOTIFICATION_LIST_LIMIT = 1000;

/**
 * Still to do (a clock the web does not know, overdue, then due soonest first) and done
 * (submitted or not required), so what needs doing is never under what is finished.
 */
export function notificationGroups<N extends Pick<StatutoryNotificationSummary, "clock" | "dueAt">>(
  items: readonly N[],
): { readonly todo: N[]; readonly done: N[] } {
  const ordered = notificationsInOrder(items);
  return {
    todo: ordered.filter((n) => n.clock !== "done"),
    done: ordered.filter((n) => n.clock === "done"),
  };
}

export interface NotificationSource {
  readonly source: "incident" | "dols" | "person";
  /** The incident's id, or the person's. */
  readonly id: string;
  readonly href: string;
}

/**
 * The record a notification was drafted on (#49 review round 2): its incident, else the person's
 * DoLS register for a DoLS outcome, else the person's record. Null when it names none.
 */
export function notificationSource(
  item: Pick<StatutoryNotificationSummary, "incidentId" | "personId" | "dolsAuthorisationId">,
): NotificationSource | null {
  if (item.incidentId) {
    return { source: "incident", id: item.incidentId, href: `/incidents/${item.incidentId}` };
  }
  if (!item.personId) return null;
  return item.dolsAuthorisationId
    ? { source: "dols", id: item.personId, href: `/people/${item.personId}/dols` }
    : { source: "person", id: item.personId, href: `/people/${item.personId}` };
}

/**
 * Every deadline on one notification in the law's terms, kept once it is done as its history;
 * the single due time when the classifier gave none. A time that cannot be read warns.
 */
export function deadlineLines(
  item: Pick<StatutoryNotificationDetail, "deadlines" | "dueAt">,
  t: Translator,
): TimeLine[] {
  const deadlines =
    item.deadlines.length > 0 ? item.deadlines : [{ key: "due", dueAt: item.dueAt }];
  return deadlines.map((deadline) => deadlineLine(deadline, t));
}

/**
 * Who a notification is about, on its own page: their name from the reader's people, or "a
 * person we support (not shown to you)" with no number, since there is nothing to match it to.
 */
export function notificationSubject(
  item: Pick<StatutoryNotificationSummary, "personId">,
  names: ReadonlyMap<string, string>,
  t: Translator,
): string | null {
  if (!item.personId) return null;
  const name = names.get(item.personId);
  return name
    ? t("safety.notification.about", { known: "true", name })
    : t("safety.notification.about", { known: "hidden" });
}

/** Whether any notification on a list is about someone the reader cannot see (numbered). */
export function hasHiddenSubjects(
  items: readonly Pick<StatutoryNotificationSummary, "personId">[],
  names: ReadonlyMap<string, string>,
): boolean {
  return items.some((item) => item.personId !== null && !names.has(item.personId));
}

/**
 * A source in words, linked only when its address is https (the API's text, never a script or
 * a plain-http page).
 */
export function citationLine(
  cite: Citation,
  t: Translator,
): { readonly text: string; readonly href: string | null } {
  return {
    text: t("safety.notification.citation", { source: cite.source, provision: cite.provision }),
    href: /^https:\/\/[^\s]+$/.test(cite.url) ? cite.url : null,
  };
}
