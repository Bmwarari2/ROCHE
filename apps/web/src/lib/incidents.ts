import type { IncidentPersonItem, IncidentSummary } from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";
import { formatDateTime } from "./format";

/**
 * View logic for the incident screens (docs/specs/safety.md; register rows SAFE-001 and
 * SAFE-002; hazard HZ-013). Pure and unit tested. Every status is the API's; the web says it in
 * the catalogue's words with an icon, and a value it does not know warns, never reads as calm.
 */

export type SafetyIcon = "circle-alert" | "clock" | "circle-check" | "search";

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
 * `truncated` says what may be missing: older incidents ("older") when the newest hit the limit,
 * or open and under-review ones too ("unfinished") when one of those lists hit it as well.
 */
export function incidentsToList<I extends Pick<IncidentSummary, "id" | "occurredAt">>(
  newest: readonly I[],
  ...unfinished: readonly (readonly I[])[]
): { readonly items: I[]; readonly truncated: "older" | "unfinished" | null } {
  const byId = new Map<string, I>();
  for (const item of [newest, ...unfinished].flat()) byId.set(item.id, item);
  const full = (list: readonly I[]) => list.length >= INCIDENT_LIST_LIMIT;
  return {
    items: [...byId.values()].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)),
    truncated: unfinished.some(full) ? "unfinished" : full(newest) ? "older" : null,
  };
}

export interface SafetyNotice {
  readonly title: string;
  readonly body: string;
}

/**
 * What the incident page says about statutory notifications while it does not show them
 * (HZ-013, #42 review): not checked yet, or not checked outside England, and that the questions
 * and notifications are not on this page yet. A holder of `safety.notification.submit` is told
 * to check them themselves, not sent to ask someone (#42 review round 2). Nothing for a reader
 * who cannot see everyone on the incident: they are told part of it is hidden instead.
 */
export function incidentNotices(
  incident: {
    readonly restricted: boolean;
    readonly classifier: { readonly nationSupported: boolean } | null;
  },
  canSubmit: boolean,
  t: Translator,
): SafetyNotice[] {
  if (incident.restricted) return [];
  const notice = (notice: string) => ({
    title: t("safety.incident.notice", { notice }),
    body: t("safety.incident.noticeHint", { notice, self: String(canSubmit) }),
  });
  if (!incident.classifier) return [notice("notChecked")];
  return [...(incident.classifier.nationSupported ? [] : [notice("nation")]), notice("notShown")];
}

/** The sidebar's Incidents label, only for holders of `safety.incident.read`. */
export function incidentsNavLabel(permissions: readonly string[], t: Translator) {
  return permissions.includes("safety.incident.read") ? t("shell.nav.incidents") : undefined;
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
