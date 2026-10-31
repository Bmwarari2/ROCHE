import type {
  IncidentDetail,
  IncidentPersonItem,
  StatutoryNotificationSummary,
} from "@harbour/contracts";
import {
  MEDICAL_EXAMINER_PACK_SECTIONS,
  type MedicalExaminerPackSection,
  SOURCES,
} from "@harbour/domain";
import { type RecordTab, tabHref } from "./care-record";

/**
 * After a death on an incident (safety.md section 4 rules 6 and 8; register row SAFE-008; hazard
 * HZ-013): the medical examiner information pack's sections and where each is kept in the
 * person's record, and the LeDeR prompt. Pure and unit tested. Harbour does not put the pack
 * together for the medical examiner yet (no API assembles it): the page lists what it holds and
 * where to find each part, and nothing here judges the death.
 */

/** LeDeR's own online form, from the domain's sources (never a literal on the page). */
export const LEDER_REPORT_URL: string = SOURCES.leder;

/** Where each section of the pack is in the record: a tab, this incident, or not on the web yet. */
const PACK_PLACES: Record<MedicalExaminerPackSection, RecordTab | "incident" | null> = {
  demographics: "overview",
  diagnoses: null,
  recent_notes: "notes",
  recent_observations: "charts",
  medicines: null,
  advance_care_records: "advance-care",
  death_circumstances: "incident",
};

export interface PackSection {
  readonly key: MedicalExaminerPackSection;
  /** Where it is: a link into the person's record or to this incident, or null (not on the web). */
  readonly href: string | null;
  readonly place: RecordTab | "incident" | null;
  /** The place as the catalogue names it ("advanceCare"), "none" when not on the web. */
  readonly placeKey: string;
}

/** The pack's sections in pack order, each with where it is kept for this person. */
export function packSections(personId: string | null, incidentId: string): PackSection[] {
  return MEDICAL_EXAMINER_PACK_SECTIONS.map(({ key }) => {
    const place = PACK_PLACES[key];
    const href =
      place === "incident"
        ? `/incidents/${incidentId}`
        : place && personId
          ? tabHref(personId, place)
          : null;
    const placeKey = !place ? "none" : place === "advance-care" ? "advanceCare" : place;
    return { key, href, place, placeKey };
  });
}

/**
 * What the page says about LeDeR for someone who died: drafted (a LeDeR notification is on the
 * incident: report it on LeDeR's form, then record it); unknown (whether they had a learning
 * disability or were autistic is not recorded on the incident, so staff check); or nothing to say
 * (both recorded as no, or they were under 18 and the classifier excluded it).
 */
export type LederPrompt =
  | { readonly kind: "drafted"; readonly notification: StatutoryNotificationSummary }
  | { readonly kind: "unknown" }
  | { readonly kind: "none" };

export function lederPrompt(
  person: Pick<IncidentPersonItem, "personId" | "learningDisability" | "autistic">,
  notifications: readonly StatutoryNotificationSummary[],
): LederPrompt {
  const drafted = notifications.find((n) => n.kind === "leder" && n.personId === person.personId);
  if (drafted) return { kind: "drafted", notification: drafted };
  if (person.learningDisability === true || person.autistic === true) return { kind: "none" };
  if (person.learningDisability === false && person.autistic === false) return { kind: "none" };
  return { kind: "unknown" };
}

export interface AfterDeath {
  readonly person: IncidentPersonItem;
  readonly examiner: StatutoryNotificationSummary | null;
  readonly leder: LederPrompt;
}

/**
 * The people using the service who died on this incident, each with their medical examiner
 * notification and the LeDeR prompt; empty for an incident with no death or one the reader sees
 * only in part (the notifications are not theirs to see).
 */
export function afterDeath(
  incident: Pick<IncidentDetail, "restricted" | "people" | "classifier">,
): AfterDeath[] {
  if (incident.restricted) return [];
  const notifications = incident.classifier?.notifications ?? [];
  return incident.people
    .filter((p) => p.kind === "service_user" && p.died && p.personId)
    .map((person) => ({
      person,
      examiner:
        notifications.find(
          (n) => n.kind === "medical_examiner" && n.personId === person.personId,
        ) ?? null,
      leder: lederPrompt(person, notifications),
    }));
}
