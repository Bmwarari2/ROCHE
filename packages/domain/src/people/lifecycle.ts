import {
  checkWorkflowTransition,
  defineWorkflow,
  type WorkflowTransitionProblem,
  type WorkflowTransitionRule,
} from "../platform/workflow";
import { DEFAULT_CLOCK_DRIFT_TOLERANCE_MINUTES } from "../shared/time";

/**
 * Person lifecycle (master prompt section 9.2; people.md section 4 rules 1 to 3; care.md rule 12).
 * One person, one record, from first contact to archive. The status says what may be recorded:
 * a discharged or deceased person's record is read-only except for post-event records, and an
 * archived record takes nothing at all. Status changes are checked like any other workflow move
 * (permission, reason, step-up) plus the lifecycle's own guards, and return the side effects the
 * API must carry out in the same transaction (tasks, sharing, beds, outbox events).
 */

export const PERSON_STATUSES = [
  "enquiry",
  "pre_admission",
  "active",
  "on_leave",
  "in_hospital",
  "discharged",
  "deceased",
  "archived",
  "not_admitted",
] as const;
export type PersonStatus = (typeof PERSON_STATUSES)[number];

/** Statuses in which the person is receiving care from the service (the record is live). */
export const LIVE_PERSON_STATUSES: readonly PersonStatus[] = ["active", "on_leave", "in_hospital"];

export function isPersonStatus(value: string): value is PersonStatus {
  return (PERSON_STATUSES as readonly string[]).includes(value);
}

// ------------------------------------------------------------------------------------------------
// What each status allows
// ------------------------------------------------------------------------------------------------

export const PERSON_CAPABILITIES = [
  "edit_demographics",
  "pre_admission_assessment",
  "about_me_authoring",
  "care_notes",
  "care_observations",
  "care_plan_changes",
  "point_of_care_rounds",
  "room_moves",
  "property_in",
  "property_return",
  "hospital_transfer_pack",
  "family_and_professional_sharing",
  "post_event_records",
] as const;
export type PersonCapability = (typeof PERSON_CAPABILITIES)[number];

export interface PersonStatusRule {
  /** Plain-English summary for screens and the spec. */
  readonly summary: string;
  /** True when ordinary care records can no longer be written (care.md rule 12). */
  readonly readOnly: boolean;
  readonly allows: readonly PersonCapability[];
}

const LIVE_COMMON: readonly PersonCapability[] = [
  "edit_demographics",
  "about_me_authoring",
  "care_notes",
  "care_plan_changes",
  "property_in",
  "property_return",
  "hospital_transfer_pack",
  "family_and_professional_sharing",
];

export const PERSON_STATUS_RULES: Readonly<Record<PersonStatus, PersonStatusRule>> = {
  enquiry: {
    summary: "First contact. Contact details and the enquiry only; no care records.",
    readOnly: false,
    allows: ["edit_demographics"],
  },
  pre_admission: {
    summary: "Being assessed. The pre-admission assessment and About Me can be written.",
    readOnly: false,
    allows: ["edit_demographics", "pre_admission_assessment", "about_me_authoring"],
  },
  active: {
    summary: "Receiving care. Everything can be recorded and the person is on rounds.",
    readOnly: false,
    allows: [...LIVE_COMMON, "care_observations", "point_of_care_rounds", "room_moves"],
  },
  on_leave: {
    summary: "Temporarily away (for example a visit home). Notes only; off rounds; bed kept.",
    readOnly: false,
    allows: [...LIVE_COMMON, "room_moves"],
  },
  in_hospital: {
    summary: "In hospital. Notes and plan updates only; off rounds; bed kept.",
    readOnly: false,
    allows: LIVE_COMMON,
  },
  discharged: {
    summary: "Left the service. Read-only except post-event records.",
    readOnly: true,
    allows: ["post_event_records", "property_return"],
  },
  deceased: {
    summary: "Died. Read-only except post-event records.",
    readOnly: true,
    allows: ["post_event_records", "property_return"],
  },
  archived: {
    summary: "Closed and held under the retention schedule. Nothing can be added.",
    readOnly: true,
    allows: [],
  },
  not_admitted: {
    summary: "Enquiry or assessment closed without admission. Nothing can be added.",
    readOnly: true,
    allows: [],
  },
};

export function personStatusAllows(status: PersonStatus, capability: PersonCapability): boolean {
  return PERSON_STATUS_RULES[status].allows.includes(capability);
}

// ------------------------------------------------------------------------------------------------
// Which records may be written in each status (care.md rule 12)
// ------------------------------------------------------------------------------------------------

/** Records written about a person, by the capability they need in a live status. */
export const PERSON_RECORD_KINDS = {
  demographics: "edit_demographics",
  contact: "edit_demographics",
  pre_admission_assessment: "pre_admission_assessment",
  admission_decision: "pre_admission_assessment",
  about_me: "about_me_authoring",
  care_note: "care_notes",
  task_completion: "care_notes",
  incident: "care_notes",
  observation: "care_observations",
  body_map_mark: "care_observations",
  assessment: "care_observations",
  care_plan: "care_plan_changes",
  risk_assessment: "care_plan_changes",
  room_move: "room_moves",
  property_item: "property_in",
  key_issue: "property_in",
  property_return: "property_return",
  hospital_transfer: "hospital_transfer_pack",
  sharing_decision: "family_and_professional_sharing",
  // Post-event records (care.md rule 12): allowed once the person has died or left.
  after_death_care: "post_event_records",
  medical_examiner_pack: "post_event_records",
  statutory_notification: "post_event_records",
  exit_checklist_item: "post_event_records",
  money_return: "post_event_records",
  key_return: "post_event_records",
  post_event_note: "post_event_records",
  document: "post_event_records",
  correspondence: "post_event_records",
} as const satisfies Record<string, PersonCapability>;
export type PersonRecordKind = keyof typeof PERSON_RECORD_KINDS;

/**
 * The records that may still be written once a person is discharged or has died, listed so the
 * API, the spec and the tests agree. Care events that happened before the discharge or death are
 * also accepted (see `checkPersonRecordWrite`).
 */
export const POST_EVENT_RECORD_KINDS: readonly PersonRecordKind[] = [
  "after_death_care",
  "medical_examiner_pack",
  "statutory_notification",
  "exit_checklist_item",
  "property_return",
  "money_return",
  "key_return",
  "post_event_note",
  "document",
  "correspondence",
];

/** Kinds that only make sense after a death. */
const DEATH_ONLY_KINDS: readonly PersonRecordKind[] = ["after_death_care", "medical_examiner_pack"];

/**
 * Append-only care events that record something that happened while the person was in the
 * service's care. One that happened at or before the discharge or death is still accepted after
 * it: a phone that recorded the last observations offline must be able to upload them (hazards
 * HZ-006 and HZ-017; the late-entry flag still applies).
 */
const CARE_EVENT_KINDS: readonly PersonRecordKind[] = [
  "care_note",
  "observation",
  "body_map_mark",
  "assessment",
  "task_completion",
  "incident",
];

export interface PersonRecordContext {
  readonly status: PersonStatus;
  /** When the person entered their current status (for discharged or deceased: when they left or died). */
  readonly statusChangedAt: Date | null;
}

export interface PersonRecordWrite {
  readonly kind: PersonRecordKind;
  /** When the recorded event happened, for care events. */
  readonly occurredAt?: Date | null;
}

export type PersonRecordProblem =
  | "record_closed"
  | "not_allowed_in_status"
  | "occurred_after_status_change"
  | "death_only";

export type PersonRecordCheck =
  | {
      readonly ok: true;
      /** True when a care event is accepted after the person left or died; show it as such. */
      readonly recordedAfterStatusChange: boolean;
    }
  | { readonly ok: false; readonly problem: PersonRecordProblem; readonly message: string };

const RECORD_MESSAGES: Record<PersonRecordProblem, string> = {
  record_closed: "This record is closed. Nothing more can be added to it.",
  not_allowed_in_status: "This cannot be recorded while the person has this status.",
  occurred_after_status_change:
    "This person has left the service or died. Only records about what happened before then, or post-event records, can be added.",
  death_only: "This record is only used after a person has died.",
};

function recordProblem(problem: PersonRecordProblem): PersonRecordCheck {
  return { ok: false, problem, message: RECORD_MESSAGES[problem] };
}

/** Whether a record may be written for a person in their current status (care.md rule 12). */
export function checkPersonRecordWrite(
  person: PersonRecordContext,
  write: PersonRecordWrite,
): PersonRecordCheck {
  const { status } = person;
  if (status === "archived" || status === "not_admitted") return recordProblem("record_closed");
  if (DEATH_ONLY_KINDS.includes(write.kind) && status !== "deceased") {
    return recordProblem("death_only");
  }
  if (personStatusAllows(status, PERSON_RECORD_KINDS[write.kind])) {
    return { ok: true, recordedAfterStatusChange: false };
  }
  if ((status === "discharged" || status === "deceased") && CARE_EVENT_KINDS.includes(write.kind)) {
    const occurredAt = write.occurredAt ?? null;
    const changedAt = person.statusChangedAt;
    if (occurredAt && changedAt && occurredAt.getTime() <= changedAt.getTime()) {
      return { ok: true, recordedAfterStatusChange: true };
    }
    return recordProblem("occurred_after_status_change");
  }
  return recordProblem("not_allowed_in_status");
}

// ------------------------------------------------------------------------------------------------
// Status changes
// ------------------------------------------------------------------------------------------------

/**
 * The lifecycle as a workflow (platform workflow engine). Nothing is terminal: a discharged person
 * can be re-admitted on the same record (one person, many placements), and a death or discharge
 * recorded in error can be corrected with a reason (HZ-001).
 */
export const PERSON_LIFECYCLE = defineWorkflow<PersonStatus>({
  key: "people.person_lifecycle",
  version: 1,
  states: PERSON_STATUSES,
  initial: "enquiry",
  terminal: [],
  transitions: [
    { from: "enquiry", to: "pre_admission", permission: "people.enquiry.manage" },
    {
      from: ["enquiry", "pre_admission"],
      to: "not_admitted",
      permission: "people.enquiry.manage",
      requiresReason: true,
    },
    {
      from: "not_admitted",
      to: "enquiry",
      permission: "people.enquiry.manage",
      requiresReason: true,
    },
    { from: "pre_admission", to: "active", permission: "people.admission.manage" },
    { from: "active", to: "on_leave", permission: "people.movement.record" },
    { from: ["active", "on_leave"], to: "in_hospital", permission: "people.movement.record" },
    { from: ["on_leave", "in_hospital"], to: "active", permission: "people.movement.record" },
    {
      from: ["active", "on_leave", "in_hospital"],
      to: "discharged",
      permission: "people.admission.manage",
      requiresReason: true,
    },
    {
      from: ["active", "on_leave", "in_hospital"],
      to: "deceased",
      permission: "people.movement.record",
    },
    // A discharge recorded in error is corrected (the person never left).
    {
      from: "discharged",
      to: "active",
      permission: "people.admission.manage",
      requiresReason: true,
    },
    // A death recorded in error is corrected with a reason and a fresh sign-in (HZ-001).
    {
      from: "deceased",
      to: "active",
      permission: "people.admission.manage",
      requiresReason: true,
      requiresStepUp: true,
    },
    // Re-admission on the same record: a new pre-admission assessment and placement.
    {
      from: ["discharged", "archived"],
      to: "pre_admission",
      permission: "people.admission.manage",
      requiresReason: true,
    },
    {
      from: ["discharged", "deceased", "not_admitted"],
      to: "archived",
      permission: "people.admission.manage",
    },
  ],
});

/** Exit workflow started by a status change (see exit.ts). */
export type ExitKind = "discharge" | "transfer" | "death";

export type PersonStatusEffect =
  | "start_pre_admission_assessment"
  | "open_placement_and_bed"
  | "start_welcome_checklist"
  | "schedule_first_care_plan"
  | "pause_rounds"
  | "resume_rounds"
  | "offer_hospital_transfer_pack"
  | "start_return_from_hospital_checks"
  | "raise_care_plan_review_on_change"
  | "start_exit_workflow"
  | "cancel_future_tasks"
  | "close_sharing"
  | "release_bed"
  | "hold_room_for_clearance"
  | "cancel_exit_workflow"
  | "reopen_record"
  | "start_retention_clock"
  | "close_enquiry";

/** Outbox events (people.md section 5); other modules react to these, never to tables. */
export type PersonLifecycleEvent =
  | "people.person.assessment_started"
  | "people.person.admitted"
  | "people.person.not_admitted"
  | "people.person.re_referred"
  | "people.person.went_on_leave"
  | "people.person.went_to_hospital"
  | "people.person.returned"
  | "people.person.discharged"
  | "people.person.died"
  | "people.person.status_corrected"
  | "people.person.archived";

export interface PersonLifecycleView {
  readonly status: PersonStatus;
  readonly createdBy: string;
  readonly statusChangedAt: Date | null;
  /** Set when a death has ever been recorded and not corrected; a deceased person is never re-admitted. */
  readonly deceasedAt: Date | null;
}

export interface PersonStatusChangeRequest {
  readonly to: PersonStatus;
  readonly actorId: string;
  readonly permissions: ReadonlySet<string>;
  readonly reason?: string | null;
  readonly stepUpFresh: boolean;
  /** When the change happened (left for hospital, died, left the service). */
  readonly effectiveAt: Date;
  /** The server's clock. */
  readonly now: Date;
  /** For a discharge: whether the person is going home or elsewhere (`discharge`) or to another provider (`transfer`). */
  readonly exitKind?: "discharge" | "transfer";
  /** For admission: the result of `checkAdmissionReadiness` (admission.ts). */
  readonly admissionReady?: boolean;
  /** For archiving after a discharge or death: the exit workflow is closed (exit.ts). */
  readonly exitWorkflowClosed?: boolean;
  /** Tolerance for a device clock ahead of the server (`sync.clock_drift_flag_minutes`). */
  readonly futureToleranceMinutes?: number;
}

export type PersonStatusProblem =
  | WorkflowTransitionProblem
  | "same_status"
  | "effective_in_future"
  | "effective_before_current_status"
  | "admission_not_ready"
  | "exit_kind_required"
  | "exit_not_closed"
  | "deceased_cannot_be_readmitted";

export type PersonStatusChangeCheck =
  | {
      readonly ok: true;
      readonly rule: WorkflowTransitionRule<PersonStatus>;
      readonly effects: readonly PersonStatusEffect[];
      readonly exitKind: ExitKind | null;
      readonly event: PersonLifecycleEvent;
      /** True for a correction of a discharge or death recorded in error. */
      readonly correction: boolean;
    }
  | { readonly ok: false; readonly problem: PersonStatusProblem; readonly message: string };

const STATUS_MESSAGES: Record<Exclude<PersonStatusProblem, WorkflowTransitionProblem>, string> = {
  same_status: "The person already has this status.",
  effective_in_future: "The time of this change cannot be in the future.",
  effective_before_current_status:
    "The time of this change is before the person's current status began.",
  admission_not_ready:
    "The admission cannot be recorded yet: check the decision to admit, its conditions and the bed.",
  exit_kind_required: "Say whether this is a discharge or a transfer to another provider.",
  exit_not_closed: "Finish the discharge, transfer or death checklist before archiving the record.",
  deceased_cannot_be_readmitted: "A person who has died cannot be re-admitted.",
};

function statusProblem(
  problem: Exclude<PersonStatusProblem, WorkflowTransitionProblem>,
): PersonStatusChangeCheck {
  return { ok: false, problem, message: STATUS_MESSAGES[problem] };
}

function effectsFor(
  from: PersonStatus,
  to: PersonStatus,
): { effects: PersonStatusEffect[]; event: PersonLifecycleEvent } {
  if (to === "pre_admission") {
    return {
      effects: ["start_pre_admission_assessment"],
      event: "people.person.assessment_started",
    };
  }
  if (to === "not_admitted")
    return { effects: ["close_enquiry"], event: "people.person.not_admitted" };
  if (to === "enquiry") return { effects: [], event: "people.person.re_referred" };
  if (to === "on_leave") return { effects: ["pause_rounds"], event: "people.person.went_on_leave" };
  if (to === "in_hospital") {
    return {
      effects: ["pause_rounds", "offer_hospital_transfer_pack"],
      event: "people.person.went_to_hospital",
    };
  }
  if (to === "discharged") {
    return {
      effects: ["start_exit_workflow", "cancel_future_tasks", "close_sharing", "release_bed"],
      event: "people.person.discharged",
    };
  }
  if (to === "deceased") {
    return {
      effects: [
        "start_exit_workflow",
        "cancel_future_tasks",
        "close_sharing",
        "hold_room_for_clearance",
      ],
      event: "people.person.died",
    };
  }
  if (to === "archived")
    return { effects: ["start_retention_clock"], event: "people.person.archived" };
  // to === "active"
  if (from === "pre_admission") {
    return {
      effects: ["open_placement_and_bed", "start_welcome_checklist", "schedule_first_care_plan"],
      event: "people.person.admitted",
    };
  }
  if (from === "in_hospital") {
    return {
      effects: [
        "resume_rounds",
        "start_return_from_hospital_checks",
        "raise_care_plan_review_on_change",
      ],
      event: "people.person.returned",
    };
  }
  if (from === "on_leave") return { effects: ["resume_rounds"], event: "people.person.returned" };
  // Correction of a discharge or death recorded in error. Sharing stays closed until a manager
  // reinstates the decisions, and the bed is re-checked by the API before the person is shown in it.
  return {
    effects: ["cancel_exit_workflow", "reopen_record", "resume_rounds"],
    event: "people.person.status_corrected",
  };
}

/**
 * Checks a status change and returns what the API must do with it. Every refusal names one
 * problem; nothing is changed on refusal.
 */
export function checkPersonStatusChange(
  person: PersonLifecycleView,
  request: PersonStatusChangeRequest,
): PersonStatusChangeCheck {
  if (person.status === request.to) return statusProblem("same_status");
  const workflow = checkWorkflowTransition(
    PERSON_LIFECYCLE,
    { state: person.status, createdBy: person.createdBy },
    request,
  );
  if (!workflow.ok) return workflow;

  const tolerance = request.futureToleranceMinutes ?? DEFAULT_CLOCK_DRIFT_TOLERANCE_MINUTES;
  if (request.effectiveAt.getTime() > request.now.getTime() + tolerance * 60_000) {
    return statusProblem("effective_in_future");
  }
  if (person.statusChangedAt && request.effectiveAt.getTime() < person.statusChangedAt.getTime()) {
    return statusProblem("effective_before_current_status");
  }

  const from = person.status;
  const to = request.to;
  if (from === "pre_admission" && to === "active" && request.admissionReady !== true) {
    return statusProblem("admission_not_ready");
  }
  if (to === "discharged" && !request.exitKind) return statusProblem("exit_kind_required");
  if (
    to === "archived" &&
    (from === "discharged" || from === "deceased") &&
    request.exitWorkflowClosed !== true
  ) {
    return statusProblem("exit_not_closed");
  }
  if (to === "pre_admission" && from === "archived" && person.deceasedAt !== null) {
    return statusProblem("deceased_cannot_be_readmitted");
  }

  const { effects, event } = effectsFor(from, to);
  let exitKind: ExitKind | null = null;
  if (to === "deceased") exitKind = "death";
  else if (to === "discharged") exitKind = request.exitKind ?? null;
  return {
    ok: true,
    rule: workflow.rule,
    effects,
    exitKind,
    event,
    correction: to === "active" && (from === "discharged" || from === "deceased"),
  };
}
