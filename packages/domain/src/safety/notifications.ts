/**
 * Statutory notification kinds, their clocks and the notification workflow (safety.md sections 2,
 * 3 and 4 rule 10; SAFE-002, SAFE-003; hazard HZ-013). The kinds are the values of
 * `statutory_notification.kind`. "Without delay" kinds are due at the incident's `occurred_at`, so
 * they show as overdue at once until submitted or marked not required with a reason; the other
 * clocks come from the rate table. Phase 1 prepares and records: the manager submits on the
 * regulator's own portal and records the reference here.
 */

import { defineWorkflow } from "../platform/workflow";
import { type Citation, cite, SOURCES } from "../shared/citation";

export const STATUTORY_NOTIFICATION_KINDS = [
  "cqc_reg16_death",
  "cqc_reg18_serious_injury",
  "cqc_reg18_abuse",
  "cqc_reg18_police",
  "cqc_reg18_service_disruption",
  "cqc_reg18_dols_outcome",
  "riddor_death",
  "riddor_specified_injury",
  "riddor_non_worker_hospital",
  "riddor_over_7_day",
  "riddor_dangerous_occurrence",
  "safeguarding_s42",
  "candour",
  "leder",
  "ukhsa_outbreak",
  "medical_examiner",
  "police_missing_person",
] as const;

export type StatutoryNotificationKind = (typeof STATUTORY_NOTIFICATION_KINDS)[number];

export type NotificationClock =
  /** Due at the event time and overdue at once until done. */
  | "without_delay"
  /** RIDDOR: notify without delay and the report must be received within `riddor.report_days` days. */
  | "riddor_report"
  /** RIDDOR over-seven-day injury: within `riddor.over_7_day.report_days` days of the accident. */
  | "riddor_over_7_day"
  /** Candour: verbal as soon as reasonably practicable; written target in working days (ADR-0021). */
  | "candour"
  /** CQC reg 18(4B): once the outcome of a DoLS request or court application is known. */
  | "on_outcome";

export interface NotificationKindInfo {
  readonly label: string;
  /** Who receives it. */
  readonly recipient: string;
  /** True when the law requires it of the provider; false for a prompt Harbour adds. */
  readonly statutory: boolean;
  readonly clock: NotificationClock;
  /** One draft per incident, or one per person (deaths, DoLS outcomes). */
  readonly per: "incident" | "person";
  readonly retentionClass: "serious_incident" | "riddor_report";
  readonly source: Citation;
}

const CQC = (provision: string, url: string): Citation =>
  cite("CQC (Registration) Regulations 2009", provision, url);
const RIDDOR = (provision: string, url: string): Citation => cite("RIDDOR 2013", provision, url);

export const NOTIFICATION_KINDS: Readonly<Record<StatutoryNotificationKind, NotificationKindInfo>> =
  {
    cqc_reg16_death: {
      label: "Death of a person using the service",
      recipient: "Care Quality Commission",
      statutory: true,
      clock: "without_delay",
      per: "person",
      retentionClass: "serious_incident",
      source: CQC("reg 16", SOURCES.cqcReg16),
    },
    cqc_reg18_serious_injury: {
      label: "Serious injury to a person using the service",
      recipient: "Care Quality Commission",
      statutory: true,
      clock: "without_delay",
      per: "incident",
      retentionClass: "serious_incident",
      source: CQC("reg 18(2)(a) and (b)", SOURCES.cqcReg18),
    },
    cqc_reg18_abuse: {
      label: "Abuse or allegation of abuse",
      recipient: "Care Quality Commission",
      statutory: true,
      clock: "without_delay",
      per: "incident",
      retentionClass: "serious_incident",
      source: CQC("reg 18(2)(e)", SOURCES.cqcReg18),
    },
    cqc_reg18_police: {
      label: "Incident reported to or investigated by the police",
      recipient: "Care Quality Commission",
      statutory: true,
      clock: "without_delay",
      per: "incident",
      retentionClass: "serious_incident",
      source: CQC("reg 18(2)(f)", SOURCES.cqcReg18),
    },
    cqc_reg18_service_disruption: {
      label: "Event that stops the service running safely",
      recipient: "Care Quality Commission",
      statutory: true,
      clock: "without_delay",
      per: "incident",
      retentionClass: "serious_incident",
      source: CQC("reg 18(2)(g)", SOURCES.cqcReg18),
    },
    cqc_reg18_dols_outcome: {
      label: "Outcome of an application to deprive a person of their liberty",
      recipient: "Care Quality Commission",
      statutory: true,
      clock: "on_outcome",
      per: "person",
      retentionClass: "serious_incident",
      source: CQC("reg 18(4A) and (4B)", SOURCES.cqcReg18),
    },
    riddor_death: {
      label: "RIDDOR: work-related death",
      recipient: "Health and Safety Executive",
      statutory: true,
      clock: "riddor_report",
      per: "incident",
      retentionClass: "riddor_report",
      source: RIDDOR("reg 6(1)", SOURCES.riddorReg6),
    },
    riddor_specified_injury: {
      label: "RIDDOR: specified injury to a worker",
      recipient: "Health and Safety Executive",
      statutory: true,
      clock: "riddor_report",
      per: "incident",
      retentionClass: "riddor_report",
      source: RIDDOR("reg 4(1)", SOURCES.riddorReg4),
    },
    riddor_non_worker_hospital: {
      label: "RIDDOR: person not at work taken to hospital",
      recipient: "Health and Safety Executive",
      statutory: true,
      clock: "riddor_report",
      per: "incident",
      retentionClass: "riddor_report",
      source: RIDDOR("reg 5(a)", SOURCES.riddorReg5),
    },
    riddor_over_7_day: {
      label: "RIDDOR: worker unable to work for more than seven days",
      recipient: "Health and Safety Executive",
      statutory: true,
      clock: "riddor_over_7_day",
      per: "incident",
      retentionClass: "riddor_report",
      source: RIDDOR("reg 4(2)", SOURCES.riddorReg4),
    },
    riddor_dangerous_occurrence: {
      label: "RIDDOR: dangerous occurrence",
      recipient: "Health and Safety Executive",
      statutory: true,
      clock: "riddor_report",
      per: "incident",
      retentionClass: "riddor_report",
      source: RIDDOR("reg 7 and Schedule 2", SOURCES.riddorSchedule2),
    },
    safeguarding_s42: {
      label: "Safeguarding concern to the local authority",
      recipient: "Local authority adult safeguarding team",
      statutory: false,
      clock: "without_delay",
      per: "incident",
      retentionClass: "serious_incident",
      source: cite("Care Act 2014", "s.42", SOURCES.careActS42),
    },
    candour: {
      label: "Duty of candour",
      recipient: "The person or someone lawfully acting on their behalf",
      statutory: true,
      clock: "candour",
      per: "incident",
      retentionClass: "serious_incident",
      source: cite(
        "Health and Social Care Act 2008 (Regulated Activities) Regulations 2014",
        "reg 20",
        SOURCES.candourReg20,
      ),
    },
    leder: {
      label: "LeDeR notification",
      recipient: "LeDeR (NHS England)",
      statutory: false,
      clock: "without_delay",
      per: "person",
      retentionClass: "serious_incident",
      source: cite("LeDeR", "Report a death", SOURCES.leder),
    },
    ukhsa_outbreak: {
      label: "Outbreak report to the health protection team",
      recipient: "UKHSA health protection team",
      statutory: false,
      clock: "without_delay",
      per: "incident",
      retentionClass: "serious_incident",
      source: cite(
        "UKHSA",
        "Report an outbreak of acute respiratory infection in an adult social care setting",
        SOURCES.ukhsaAri,
      ),
    },
    medical_examiner: {
      label: "Medical examiner information pack",
      recipient: "Medical examiner office",
      statutory: false,
      clock: "without_delay",
      per: "person",
      retentionClass: "serious_incident",
      source: cite(
        "DHSC",
        "An overview of the death certification reforms",
        SOURCES.deathCertification,
      ),
    },
    police_missing_person: {
      label: "Missing person: Herbert Protocol profile to the police",
      recipient: "Police",
      statutory: false,
      clock: "without_delay",
      per: "person",
      retentionClass: "serious_incident",
      source: cite("Harbour master prompt", "11.1 (Herbert Protocol)", "docs/00-MASTER-PROMPT.md"),
    },
  };

export type NotificationStatus = "draft" | "ready" | "submitted" | "not_required";

/**
 * Draft, ready, submitted, or not required with a reason. Submitting and deciding "not required"
 * both need `safety.notification.submit` with step-up (safety.md section 3, ADR-0002).
 */
export const STATUTORY_NOTIFICATION_WORKFLOW = defineWorkflow<NotificationStatus>({
  key: "safety.statutory_notification",
  version: 1,
  // The notification's own due time (HZ-013), written by the safety module.
  deadlineOnRecord: { states: ["draft", "ready"] },
  states: ["draft", "ready", "submitted", "not_required"],
  initial: "draft",
  terminal: ["submitted", "not_required"],
  transitions: [
    { from: "draft", to: "ready", permission: "safety.incident.manage" },
    { from: "ready", to: "draft", permission: "safety.incident.manage" },
    {
      from: "ready",
      to: "submitted",
      permission: "safety.notification.submit",
      requiresStepUp: true,
    },
    {
      from: ["draft", "ready"],
      to: "not_required",
      permission: "safety.notification.submit",
      requiresReason: true,
      requiresStepUp: true,
    },
  ],
});

export interface SubmissionEvidence {
  readonly submittedAt: Date | null;
  /** The regulator's reference (CQC portal, HSE online form, local authority). */
  readonly externalReference: string | null;
  /** The submitted form or confirmation, stored as a document. */
  readonly evidenceDocumentId: string | null;
}

/** HZ-013: a notification is submitted only with the time and a reference or the evidence document. */
export function submissionEvidenceProblems(evidence: SubmissionEvidence, at: Date): string[] {
  const problems: string[] = [];
  if (!evidence.submittedAt) problems.push("Record when the notification was submitted.");
  else if (evidence.submittedAt.getTime() > at.getTime()) {
    problems.push("The submission time cannot be in the future.");
  }
  if (!(evidence.externalReference?.trim() ?? "") && !evidence.evidenceDocumentId) {
    problems.push("Record the regulator's reference or attach the submitted form.");
  }
  return problems;
}

export type ClockState = "done" | "due" | "overdue";

/** The countdown state shown on the incident, the dashboard and the notification centre. */
export function notificationClockState(
  dueAt: Date,
  status: NotificationStatus,
  at: Date,
): ClockState {
  if (status === "submitted" || status === "not_required") return "done";
  return at.getTime() >= dueAt.getTime() ? "overdue" : "due";
}
