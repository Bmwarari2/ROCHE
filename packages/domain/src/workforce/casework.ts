/**
 * Employee relations casework (workforce.md section 2c and rules 14 to 18; WORK-010; plan slice
 * 39). Grievance, disciplinary, capability, sickness absence and probation cases, run as the Acas
 * Code of Practice on disciplinary and grievance procedures sets out: establish the facts,
 * set the issue out in writing with the evidence, hold a meeting at which the employee may be
 * accompanied, decide and confirm in writing with the right of appeal, and hear any appeal by
 * someone not involved before where that is practicable. Suspension is a precaution kept under
 * review, never a sanction. Harbour records the people's decisions; it never makes one (master
 * prompt section 5.1: no solely automated significant decision). Dates are UK calendar dates
 * (`yyyy-mm-dd`).
 *
 * A case is read only by the members named on it (ADR-0089); the codes here are mirrored by the
 * database (packages/db `schema/casework.ts`, migration 0101).
 */

export const CASE_TYPES = [
  "grievance",
  "disciplinary",
  "capability",
  "sickness_absence",
  "probation",
] as const;
export type CaseType = (typeof CASE_TYPES)[number];

export const CASE_STAGES = [
  "open",
  "investigation",
  "hearing",
  "outcome",
  "appeal",
  "closed",
] as const;
export type CaseStage = (typeof CASE_STAGES)[number];

/** What each member does on the case; membership is what lets them read it. */
export const CASE_MEMBER_ROLES = [
  "case_manager",
  "investigator",
  "hearing_chair",
  "appeal_chair",
  "note_taker",
  "hr_adviser",
] as const;
export type CaseMemberRole = (typeof CASE_MEMBER_ROLES)[number];

/** The outcomes a hearing may decide, by case type. */
export const CASE_OUTCOMES = {
  grievance: ["upheld", "partly_upheld", "not_upheld"],
  disciplinary: [
    "no_action",
    "first_written_warning",
    "final_written_warning",
    "action_short_of_dismissal",
    "dismissal",
  ],
  capability: [
    "no_action",
    "improvement_plan",
    "first_written_warning",
    "final_written_warning",
    "redeployment",
    "dismissal",
  ],
  sickness_absence: [
    "no_action",
    "support_plan",
    "reasonable_adjustments",
    "first_written_warning",
    "final_written_warning",
    "redeployment",
    "dismissal",
  ],
  probation: ["passed", "extended", "not_passed"],
} as const satisfies Record<CaseType, readonly string[]>;
export type CaseOutcome = (typeof CASE_OUTCOMES)[CaseType][number];
export const ALL_CASE_OUTCOMES: readonly CaseOutcome[] = [
  ...new Set(Object.values(CASE_OUTCOMES).flat()),
];

/** Outcomes that are warnings: each carries the date it stops counting (the tenant's policy). */
export const WARNING_OUTCOMES = ["first_written_warning", "final_written_warning"] as const;
/** Outcomes that end employment: a DBS barring referral decision is then due (rule 17). */
export const DISMISSAL_OUTCOMES = ["dismissal", "not_passed"] as const;

export const APPEAL_OUTCOMES = ["upheld", "partly_upheld", "not_upheld"] as const;
export type AppealOutcome = (typeof APPEAL_OUTCOMES)[number];

export const CASE_CLOSING_REASONS = [
  "outcome_accepted",
  "appeal_decided",
  "resolved_informally",
  "no_case_to_answer",
  "withdrawn",
  "left_employment",
] as const;
export type CaseClosingReason = (typeof CASE_CLOSING_REASONS)[number];

/** Why a hearing was decided without one being held (Acas Code paragraph 25). */
export const NO_HEARING_REASONS = ["employee_repeatedly_did_not_attend"] as const;

/** Why the same person takes two parts of a case (Acas: "where practicable"). */
export const INDEPENDENCE_EXCEPTIONS = ["no_other_manager_available"] as const;
export type IndependenceException = (typeof INDEPENDENCE_EXCEPTIONS)[number];

export const REFERRAL_DECISIONS = ["referred", "not_required"] as const;
export type ReferralDecision = (typeof REFERRAL_DECISIONS)[number];
export const REFERRAL_NOT_REQUIRED_REASONS = [
  "harm_test_not_met",
  "not_regulated_activity",
  "referred_by_another_body",
  "other_recorded_in_case",
] as const;
export type ReferralNotRequiredReason = (typeof REFERRAL_NOT_REQUIRED_REASONS)[number];

export const HEARING_KINDS = ["investigation_meeting", "hearing", "appeal_hearing"] as const;
export type HearingKind = (typeof HEARING_KINDS)[number];
export const HEARING_STATES = [
  "scheduled",
  "held",
  "not_attended",
  "postponed",
  "cancelled",
] as const;
export type HearingState = (typeof HEARING_STATES)[number];
export const POSTPONEMENT_REASONS = [
  "companion_unavailable",
  "employee_unwell",
  "employer_request",
  "other",
] as const;

export const isWarning = (outcome: string): boolean =>
  (WARNING_OUTCOMES as readonly string[]).includes(outcome);

export function outcomeAllowed(type: CaseType, outcome: string): outcome is CaseOutcome {
  return (CASE_OUTCOMES[type] as readonly string[]).includes(outcome);
}

/** What the rules need to know about the case as it stands. */
export interface CaseFacts {
  readonly type: CaseType;
  readonly stage: CaseStage;
  /** Hearings (kind `hearing`) held, and those the employee did not attend. */
  readonly hearingsHeld: number;
  readonly hearingsNotAttended: number;
  /** Appeal hearings held. */
  readonly appealHearingsHeld: number;
  readonly suspended: boolean;
  readonly outcome: CaseOutcome | null;
  /** The referral decisions recorded (rule 17), null while none is. */
  readonly dbsReferral: ReferralDecision | null;
  readonly regulatorReferral: ReferralDecision | null;
  /** The member of staff is on a professional register (NMC, HCPC, SWE, GMC). */
  readonly subjectRegistered: boolean;
  /** The case is linked to a safeguarding concern in the safeguarding log. */
  readonly linkedToSafeguarding: boolean;
}

export type CaseMove =
  | { readonly to: "investigation"; readonly investigatorNamed: boolean }
  | { readonly to: "hearing" }
  | {
      readonly to: "outcome";
      readonly outcome: string;
      readonly decidedOn: string;
      /** For a warning: when it stops counting, after the decision. */
      readonly warningExpiresOn: string | null;
      readonly appealRightGiven: boolean;
      readonly noHearingReason: (typeof NO_HEARING_REASONS)[number] | null;
    }
  | { readonly to: "appeal" }
  | {
      readonly to: "closed";
      readonly reason: CaseClosingReason;
      readonly appealOutcome?: AppealOutcome | null;
    };

export type CaseMoveProblem =
  | "closed"
  | "not_allowed_from_stage"
  | "investigator_required"
  | "hearing_required"
  | "outcome_not_for_case_type"
  | "warning_expiry_required"
  | "warning_expiry_not_allowed"
  | "appeal_right_required"
  | "appeal_hearing_required"
  | "appeal_outcome_required"
  | "reason_not_for_stage"
  | "suspension_in_force"
  | "referral_decision_required";

export type CaseMoveCheck =
  | { readonly ok: true; readonly to: CaseStage }
  | { readonly ok: false; readonly problem: CaseMoveProblem };

const fail = (problem: CaseMoveProblem): CaseMoveCheck => ({ ok: false, problem });

/** Which closing reasons each stage allows (rule 15). */
const CLOSE_FROM: Record<CaseClosingReason, readonly CaseStage[]> = {
  outcome_accepted: ["outcome"],
  appeal_decided: ["appeal"],
  resolved_informally: ["open", "investigation"],
  no_case_to_answer: ["investigation"],
  withdrawn: ["open", "investigation", "hearing"],
  left_employment: ["open", "investigation", "hearing", "outcome", "appeal"],
};

/**
 * Rule 15: how a case moves. Open, then (as the facts need) investigation, a hearing, the
 * outcome, any appeal, and closed; a closed case never reopens (a new case is opened instead).
 */
export function checkCaseMove(facts: CaseFacts, move: CaseMove): CaseMoveCheck {
  const { stage } = facts;
  if (stage === "closed") return fail("closed");
  switch (move.to) {
    case "investigation":
      if (stage !== "open") return fail("not_allowed_from_stage");
      if (!move.investigatorNamed) return fail("investigator_required");
      return { ok: true, to: "investigation" };
    case "hearing":
      if (stage !== "open" && stage !== "investigation") return fail("not_allowed_from_stage");
      return { ok: true, to: "hearing" };
    case "outcome": {
      if (stage !== "hearing") return fail("not_allowed_from_stage");
      // No decision without a meeting, unless the employee repeatedly did not attend one without
      // good reason (Acas Code paragraph 25).
      const decidedWithout = move.noHearingReason !== null && facts.hearingsNotAttended >= 2;
      if (facts.hearingsHeld === 0 && !decidedWithout) return fail("hearing_required");
      if (!outcomeAllowed(facts.type, move.outcome)) return fail("outcome_not_for_case_type");
      if (isWarning(move.outcome)) {
        if (move.warningExpiresOn === null || move.warningExpiresOn <= move.decidedOn) {
          return fail("warning_expiry_required");
        }
      } else if (move.warningExpiresOn !== null) {
        return fail("warning_expiry_not_allowed");
      }
      if (!move.appealRightGiven) return fail("appeal_right_required");
      return { ok: true, to: "outcome" };
    }
    case "appeal":
      if (stage !== "outcome") return fail("not_allowed_from_stage");
      return { ok: true, to: "appeal" };
    case "closed": {
      if (!CLOSE_FROM[move.reason].includes(stage)) return fail("reason_not_for_stage");
      if (move.reason === "appeal_decided") {
        if (facts.appealHearingsHeld === 0) return fail("appeal_hearing_required");
        if (!move.appealOutcome) return fail("appeal_outcome_required");
      }
      if (facts.suspended) return fail("suspension_in_force");
      const due = referralDecisionsDue(facts, move.reason);
      if (
        (due.dbs && facts.dbsReferral === null) ||
        (due.regulator && facts.regulatorReferral === null)
      ) {
        return fail("referral_decision_required");
      }
      return { ok: true, to: "closed" };
    }
  }
}

/**
 * Rule 17: which referral decisions must be recorded before the case closes. A regulated activity
 * provider must refer to the DBS someone it dismissed, or would have dismissed had they not left,
 * because they harmed or posed a risk of harm (Safeguarding Vulnerable Groups Act 2006 section
 * 35); a registered professional's fitness to practise concerns go to their regulator. Whether a
 * referral is made is the people's decision, never Harbour's: the rule only asks that one is
 * recorded, with its reason, whenever the case could meet the test.
 */
export function referralDecisionsDue(
  facts: Pick<CaseFacts, "type" | "outcome" | "subjectRegistered" | "linkedToSafeguarding">,
  closingReason: CaseClosingReason | null,
): { readonly dbs: boolean; readonly regulator: boolean } {
  const conduct = facts.type === "disciplinary" || facts.type === "capability";
  const ended =
    (facts.outcome !== null && (DISMISSAL_OUTCOMES as readonly string[]).includes(facts.outcome)) ||
    (closingReason === "left_employment" && conduct);
  const dbs = facts.linkedToSafeguarding || (ended && facts.type !== "sickness_absence");
  const serious =
    ended || (conduct && facts.outcome !== null && facts.outcome === "final_written_warning");
  const regulator = facts.subjectRegistered && (facts.linkedToSafeguarding || (conduct && serious));
  return { dbs, regulator };
}

export type ReferralProblem = "reason_required" | "reason_not_allowed" | "referred_on_required";

/** A referral decision: referred on a date, or not required with a reason code. */
export function checkReferralDecision(input: {
  readonly decision: ReferralDecision;
  readonly referredOn: string | null;
  readonly reason: ReferralNotRequiredReason | null;
}): { ok: true } | { ok: false; problem: ReferralProblem } {
  if (input.decision === "referred") {
    if (input.referredOn === null) return { ok: false, problem: "referred_on_required" };
    if (input.reason !== null) return { ok: false, problem: "reason_not_allowed" };
    return { ok: true };
  }
  if (input.reason === null) return { ok: false, problem: "reason_required" };
  if (input.referredOn !== null) return { ok: false, problem: "reason_not_allowed" };
  return { ok: true };
}

export interface ActiveMember {
  readonly tenantUserId: string;
  readonly role: CaseMemberRole;
}

export type MemberProblem =
  | "subject_cannot_be_member"
  | "already_in_role"
  | "chair_was_investigator"
  | "investigator_is_chair"
  | "appeal_chair_involved"
  | "involved_in_appeal"
  | "last_case_manager";

/**
 * Rule 16: who may be named on a case. Never the member of staff it is about. Where practicable
 * (Acas Code paragraphs 6 and 27) the investigator does not chair the hearing, and the appeal is
 * heard by someone involved in neither; a small organisation records why it is not practicable
 * (`no_other_manager_available`).
 */
export function checkMemberAppointment(input: {
  readonly tenantUserId: string;
  readonly role: CaseMemberRole;
  readonly subjectTenantUserId: string;
  readonly active: readonly ActiveMember[];
  readonly exception: IndependenceException | null;
}): { ok: true } | { ok: false; problem: MemberProblem } {
  const { tenantUserId, role, active, exception } = input;
  if (tenantUserId === input.subjectTenantUserId) {
    return { ok: false, problem: "subject_cannot_be_member" };
  }
  const roles = new Set(active.filter((m) => m.tenantUserId === tenantUserId).map((m) => m.role));
  if (roles.has(role)) return { ok: false, problem: "already_in_role" };
  if (exception === null) {
    if (role === "hearing_chair" && roles.has("investigator")) {
      return { ok: false, problem: "chair_was_investigator" };
    }
    if (role === "investigator" && roles.has("hearing_chair")) {
      return { ok: false, problem: "investigator_is_chair" };
    }
    if (role === "appeal_chair" && (roles.has("investigator") || roles.has("hearing_chair"))) {
      return { ok: false, problem: "appeal_chair_involved" };
    }
    if ((role === "investigator" || role === "hearing_chair") && roles.has("appeal_chair")) {
      return { ok: false, problem: "involved_in_appeal" };
    }
  }
  return { ok: true };
}

/** A case always keeps a case manager: the last one is not removed. */
export function checkMemberRemoval(
  removing: ActiveMember,
  active: readonly ActiveMember[],
): { ok: true } | { ok: false; problem: "last_case_manager" } {
  if (removing.role !== "case_manager") return { ok: true };
  const managers = active.filter((m) => m.role === "case_manager");
  return managers.length <= 1 ? { ok: false, problem: "last_case_manager" } : { ok: true };
}

export type InvitationProblem =
  | "not_allowed_from_stage"
  | "issue_not_set_out"
  | "evidence_not_shared"
  | "companion_right_not_given"
  | "no_notice";

/**
 * Rule 18: a hearing or appeal hearing is arranged only once the employee has been told in
 * writing what it is about (and, for a disciplinary or capability case, given the evidence), and
 * of their statutory right to be accompanied by a colleague or trade union representative
 * (Employment Relations Act 1999 section 10), for a date after the invitation. How much notice is
 * reasonable is the tenant's policy; Harbour holds no figure for it.
 */
export function checkHearingInvitation(input: {
  readonly type: CaseType;
  readonly stage: CaseStage;
  readonly kind: HearingKind;
  readonly invitedOn: string;
  readonly scheduledOn: string;
  readonly issueSetOut: boolean;
  readonly evidenceShared: boolean;
  readonly companionRightGiven: boolean;
}): { ok: true } | { ok: false; problem: InvitationProblem } {
  const stageFor: Record<HearingKind, readonly CaseStage[]> = {
    investigation_meeting: ["investigation"],
    hearing: ["hearing"],
    appeal_hearing: ["appeal"],
  };
  if (!stageFor[input.kind].includes(input.stage)) {
    return { ok: false, problem: "not_allowed_from_stage" };
  }
  if (input.kind !== "investigation_meeting") {
    if (!input.issueSetOut) return { ok: false, problem: "issue_not_set_out" };
    const evidenceNeeded = input.type === "disciplinary" || input.type === "capability";
    if (evidenceNeeded && !input.evidenceShared) {
      return { ok: false, problem: "evidence_not_shared" };
    }
    if (!input.companionRightGiven) return { ok: false, problem: "companion_right_not_given" };
  }
  if (input.scheduledOn <= input.invitedOn) return { ok: false, problem: "no_notice" };
  return { ok: true };
}

/** Which hearing states may follow which (a held, unattended or cancelled one is final). */
export function checkHearingChange(from: HearingState, to: HearingState): boolean {
  if (from !== "scheduled" && from !== "postponed") return false;
  return to !== "scheduled" && to !== from;
}

export type SuspensionProblem =
  | "not_for_case_type"
  | "closed"
  | "already_suspended"
  | "not_suspended"
  | "review_date_required"
  | "ends_before_start";

/**
 * Rule 18 (suspension): only in a disciplinary case, as a precaution while the facts are
 * established, never a sanction; it always carries the date it is next reviewed, which must be
 * after the day it starts or was last reviewed, and it ends before the case closes.
 */
export function checkSuspension(
  input: {
    readonly type: CaseType;
    readonly stage: CaseStage;
    readonly suspendedOn: string | null;
  },
  change:
    | { readonly kind: "start"; readonly on: string; readonly reviewOn: string }
    | { readonly kind: "review"; readonly on: string; readonly reviewOn: string }
    | { readonly kind: "end"; readonly on: string },
): { ok: true } | { ok: false; problem: SuspensionProblem } {
  if (input.type !== "disciplinary") return { ok: false, problem: "not_for_case_type" };
  if (input.stage === "closed") return { ok: false, problem: "closed" };
  if (change.kind === "start") {
    if (input.suspendedOn !== null) return { ok: false, problem: "already_suspended" };
  } else if (input.suspendedOn === null) {
    return { ok: false, problem: "not_suspended" };
  }
  if (change.kind !== "end" && change.reviewOn <= change.on) {
    return { ok: false, problem: "review_date_required" };
  }
  if (change.kind !== "start" && input.suspendedOn !== null && change.on < input.suspendedOn) {
    return { ok: false, problem: "ends_before_start" };
  }
  return { ok: true };
}

/** A suspension whose review date has passed: shown on the case as overdue, in words. */
export function suspensionReviewOverdue(reviewOn: string | null, today: string): boolean {
  return reviewOn !== null && today > reviewOn;
}

/**
 * Whether a warning still counts on a day: from its decision up to and including the day before
 * it expires, and never once an appeal overturned it.
 */
export function warningCounts(
  warning: {
    readonly outcome: string;
    readonly decidedOn: string;
    readonly expiresOn: string | null;
    readonly appealOutcome: AppealOutcome | null;
  },
  on: string,
): boolean {
  if (!isWarning(warning.outcome) || warning.expiresOn === null) return false;
  if (warning.appealOutcome === "upheld") return false;
  return on >= warning.decidedOn && on < warning.expiresOn;
}

const MS_PER_DAY = 86_400_000;
const dayNumber = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));

/**
 * The case's timeline (Acas: deal with issues promptly, without unreasonable delay): each step
 * with the calendar days since the one before, and the days at the current stage. No target is
 * applied: what delay is reasonable is the people's judgement.
 */
export function caseTimeline(
  steps: readonly { readonly stage: CaseStage; readonly on: string }[],
  today: string,
): {
  readonly steps: readonly { stage: CaseStage; on: string; daysSincePrevious: number | null }[];
  readonly daysAtStage: number | null;
} {
  const sorted = [...steps].sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0));
  const out = sorted.map((s, i) => {
    const previous = sorted[i - 1];
    return {
      stage: s.stage,
      on: s.on,
      daysSincePrevious: previous
        ? Math.round((dayNumber(s.on) - dayNumber(previous.on)) / MS_PER_DAY)
        : null,
    };
  });
  const last = sorted.at(-1);
  const daysAtStage =
    last && last.stage !== "closed"
      ? Math.round((dayNumber(today) - dayNumber(last.on)) / MS_PER_DAY)
      : null;
  return { steps: out, daysAtStage };
}
