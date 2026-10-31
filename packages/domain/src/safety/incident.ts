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
  /**
   * When the person was found, if later (an unwitnessed fall): post-fall observations count from
   * here (`postFallChecklist`). Statutory clocks still start at `occurredAt`.
   */
  readonly foundAt?: Date | null;
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

/** What closing needs to know about the duty of candour beyond the record's stage. */
export interface CandourCloseFacts {
  /**
   * Harbour found the duty may apply: a candour output on the incident's last classification, or
   * a candour notification not marked not required and not flagged no longer indicated.
   */
  readonly indicated: boolean;
  /**
   * The candour record's threshold decision, or null when none is recorded. Kept for the record:
   * a decision covers only the person it names, so it never clears anyone else (#120 round 2, M1).
   */
  readonly notifiable: boolean | null;
  /** The candour record's relevant person, or null. */
  readonly personId: string | null;
  /** The people we support the duty applies to: those affected by the incident. */
  readonly people: readonly string[];
}

export interface IncidentCloseView {
  readonly notifications: readonly { readonly kind: string; readonly status: NotificationStatus }[];
  /** Questions the classifier still needs answered. */
  readonly openQuestions: readonly string[];
  readonly candourState: string | null;
  readonly candour: CandourCloseFacts;
}

/** The stages at which a candour record is finished (`CANDOUR_WORKFLOW`'s terminal states). */
export const CANDOUR_FINISHED_STATES: readonly string[] = [
  "closed",
  "not_notifiable",
  "no_contact",
];

export interface CandourCloseBlock {
  /** The duty may apply and nobody has started a candour record (HZ-013, review H2). */
  readonly noRecord: boolean;
  /** The candour record is not finished. */
  readonly open: boolean;
  /**
   * People affected who have no finished candour record of their own, once a record exists. One
   * record covers one relevant person, the one it names, whatever it decided ("not notifiable"
   * included): everyone else affected is still to be told, whether one person was affected or
   * several (#120 review H1, round 2 M1 and M2; one record per person to follow).
   */
  readonly stillToTell: readonly string[];
}

/**
 * Whether the duty of candour lets an incident close (HZ-013). With no record, it waits where
 * Harbour found the duty may apply (`indicated`). Once a record exists it must be finished, and
 * it covers only the person it names, so every other person affected is still to be told.
 */
export function candourCloseBlock(
  candourState: string | null,
  candour: CandourCloseFacts,
): CandourCloseBlock {
  const finished = candourState !== null && CANDOUR_FINISHED_STATES.includes(candourState);
  return {
    noRecord: candour.indicated && candourState === null,
    open: candourState !== null && !finished,
    stillToTell:
      candourState !== null
        ? candour.people.filter((p) => !(finished && p === candour.personId))
        : [],
  };
}

/**
 * HZ-013: an incident cannot close while a notification is still a draft or ready, while the
 * classifier is waiting for answers, while the duty of candour may apply and no candour record
 * has finished, while the candour record is still open, or while someone affected has not been
 * told under the duty of candour.
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
  const candour = candourCloseBlock(view.candourState, view.candour);
  if (candour.noRecord) {
    problems.push("Record the duty of candour threshold decision before closing.");
  }
  if (candour.open) {
    problems.push("Complete the duty of candour record before closing.");
  }
  if (candour.stillToTell.length > 0) {
    problems.push(
      "Someone affected has no finished duty of candour record of their own: one candour record covers only the person it names, so each person affected must be told before closing.",
    );
  }
  return problems;
}
