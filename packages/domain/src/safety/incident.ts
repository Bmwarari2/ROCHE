/**
 * Incidents (safety.md sections 2 and 4 rule 11; SAFE-001, SAFE-002; master prompt 11.1). The
 * types are the section 11.1 list. The facts here are what the classifier reads from the incident
 * and its people; the answers to its questions are stored separately (`classifier_answer`).
 */

import type { PressureUlcerCategory } from "../care/body-map";
import { defineWorkflow } from "../platform/workflow";
import type { NotificationStatus } from "./notifications";

export const INCIDENT_TYPES = [
  "fall",
  "medication",
  "skin",
  "behaviour",
  "missing_person",
  "safeguarding_concern",
  "injury",
  "near_miss",
  "environmental",
  "ipc",
  "staff_injury",
  "violence_to_staff",
  "self_harm",
  "sexual_safety",
  "absconding",
  "fire_setting",
  "substance_use",
  "data_breach",
] as const;

export type IncidentType = (typeof INCIDENT_TYPES)[number];

export type IncidentNation = "england" | "wales" | "scotland" | "northern_ireland";

/** A person using the service, a worker (staff, agency, volunteer at work) or anyone else. */
export type IncidentPersonKind = "service_user" | "worker" | "other_not_at_work";

export interface IncidentPersonFacts {
  /** Opaque id (person or staff member); never a name. */
  readonly ref: string;
  readonly kind: IncidentPersonKind;
  readonly role: "affected" | "witness" | "involved";
  readonly died?: boolean;
  /** From the person record, for the LeDeR prompt. */
  readonly learningDisability?: boolean;
  readonly autistic?: boolean;
  /** LeDeR covers adults; a child's death goes to Child Death Review. */
  readonly aged18OrOver?: boolean;
  /** Subject to a DoLS authorisation or a court order depriving them of liberty. */
  readonly subjectToDols?: boolean;
  readonly subjectToMentalHealthAct?: boolean;
  /** Pressure ulcer categories on this incident's body-map marks. */
  readonly pressureUlcers?: readonly PressureUlcerCategory[];
}

export interface IncidentFacts {
  readonly type: IncidentType;
  /** When it happened (device time for offline capture): every clock starts here (safety.md 6). */
  readonly occurredAt: Date;
  readonly nation: IncidentNation;
  readonly people: readonly IncidentPersonFacts[];
}

export type IncidentState = "open" | "under_review" | "closed";

/**
 * Open, under review, closed. The person who raised an incident can add to it but cannot close it
 * (safety.md rule 11; master prompt 11.2 rules).
 */
export const INCIDENT_WORKFLOW = defineWorkflow<IncidentState>({
  key: "safety.incident",
  version: 1,
  states: ["open", "under_review", "closed"],
  initial: "open",
  terminal: ["closed"],
  transitions: [
    { from: "open", to: "under_review", permission: "safety.incident.manage" },
    {
      from: "under_review",
      to: "open",
      permission: "safety.incident.manage",
      requiresReason: true,
    },
    {
      from: ["open", "under_review"],
      to: "closed",
      permission: "safety.incident.manage",
      requiresReason: true,
      distinctFromCreator: true,
    },
  ],
});

export interface IncidentCloseView {
  readonly notifications: readonly { readonly kind: string; readonly status: NotificationStatus }[];
  /** Questions the classifier still needs answered. */
  readonly openQuestions: readonly string[];
  readonly candourState: string | null;
}

/**
 * HZ-013: an incident cannot close while a notification is still a draft or ready, while the
 * classifier is waiting for answers, or while the candour record is still open.
 */
export function incidentCloseProblems(view: IncidentCloseView): string[] {
  const problems: string[] = [];
  const open = view.notifications.filter((n) => n.status === "draft" || n.status === "ready");
  if (open.length > 0) {
    problems.push(
      `Submit or mark not required with a reason: ${open.map((n) => n.kind).join(", ")}.`,
    );
  }
  if (view.openQuestions.length > 0) {
    problems.push("Answer the notification questions before closing.");
  }
  if (
    view.candourState !== null &&
    !["closed", "not_notifiable", "no_contact"].includes(view.candourState)
  ) {
    problems.push("Complete the duty of candour record before closing.");
  }
  return problems;
}
