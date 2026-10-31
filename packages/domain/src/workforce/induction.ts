import { addPeriod } from "../platform/retention";

/**
 * Onboarding, the Care Certificate and leavers (workforce.md section 2d and rules 19 to 23;
 * WORK-004, WORK-013; plan slice 29). From the accepted offer to the first day and probation:
 * a checklist, policy read-and-sign at induction, shadow shifts and probation reviews; the Care
 * Certificate's 16 standards, each assessed and then observed by someone other than the worker;
 * and leaving: access ended at the end of the leaving day, the exit interview, references and
 * how long the staff file is kept. Dates are UK calendar dates (`yyyy-mm-dd`). Harbour records
 * the people's decisions; it decides nothing.
 */

/**
 * The Care Certificate's 16 standards (Skills for Care): ids and short titles only, never the
 * standards' text, which is Skills for Care's (H-531). The titles follow the current version and
 * are confirmed with Skills for Care (H-871).
 */
export const CARE_CERTIFICATE_STANDARDS = [
  { id: "cc01", title: "Understand your role" },
  { id: "cc02", title: "Your personal development" },
  { id: "cc03", title: "Duty of care" },
  { id: "cc04", title: "Equality, diversity, inclusion and human rights" },
  { id: "cc05", title: "Work in a person-centred way" },
  { id: "cc06", title: "Communication" },
  { id: "cc07", title: "Privacy and dignity" },
  { id: "cc08", title: "Fluids and nutrition" },
  { id: "cc09", title: "Awareness of mental health and dementia" },
  { id: "cc10", title: "Safeguarding adults" },
  { id: "cc11", title: "Safeguarding children" },
  { id: "cc12", title: "Basic life support" },
  { id: "cc13", title: "Health and safety" },
  { id: "cc14", title: "Handling information" },
  { id: "cc15", title: "Infection prevention and control" },
  { id: "cc16", title: "Awareness of learning disability and autism" },
] as const;
export type CareCertificateStandardId = (typeof CARE_CERTIFICATE_STANDARDS)[number]["id"];
export const CARE_CERTIFICATE_STANDARD_IDS: readonly CareCertificateStandardId[] =
  CARE_CERTIFICATE_STANDARDS.map((s) => s.id);

export type StandardStatus = "not_started" | "knowledge_assessed" | "competent";

export interface StandardProgress {
  readonly standardId: CareCertificateStandardId;
  readonly knowledgeAssessedOn: string | null;
  readonly knowledgeAssessedBy: string | null;
  readonly observedOn: string | null;
  readonly observedBy: string | null;
}

export function standardStatus(p: StandardProgress | undefined): StandardStatus {
  if (!p || p.knowledgeAssessedOn === null) return "not_started";
  return p.observedOn === null ? "knowledge_assessed" : "competent";
}

export type StandardChangeProblem =
  | "self_assessed"
  | "not_an_observer"
  | "knowledge_first"
  | "already_recorded"
  | "date_in_future"
  | "date_before_start"
  | "observed_before_knowledge";

/**
 * Rule 20: a standard's knowledge is assessed, then the worker is observed competent in
 * practice, each by someone other than the worker; the observation only by someone who holds
 * `workforce.competence.observe` when they sign. Neither is ever before the worker's start date,
 * after today, or recorded twice; an observation never comes before the knowledge assessment.
 */
export function checkStandardChange(input: {
  readonly current: StandardProgress | undefined;
  readonly step: "knowledge" | "observation";
  readonly on: string;
  readonly today: string;
  readonly startsOn: string;
  readonly workerId: string;
  readonly actorId: string;
  readonly actorObserves: boolean;
}): { ok: true } | { ok: false; problem: StandardChangeProblem } {
  const fail = (problem: StandardChangeProblem) => ({ ok: false, problem }) as const;
  if (input.actorId === input.workerId) return fail("self_assessed");
  if (input.on > input.today) return fail("date_in_future");
  if (input.on < input.startsOn) return fail("date_before_start");
  const status = standardStatus(input.current);
  if (input.step === "knowledge") {
    if (status !== "not_started") return fail("already_recorded");
    return { ok: true };
  }
  if (!input.actorObserves) return fail("not_an_observer");
  if (status === "not_started") return fail("knowledge_first");
  if (status === "competent") return fail("already_recorded");
  if (input.current?.knowledgeAssessedOn && input.on < input.current.knowledgeAssessedOn) {
    return fail("observed_before_knowledge");
  }
  return { ok: true };
}

/** The worker's Care Certificate: each standard's status, and complete once all 16 are. */
export function careCertificateProgress(rows: readonly StandardProgress[]): {
  readonly standards: readonly {
    id: CareCertificateStandardId;
    title: string;
    status: StandardStatus;
  }[];
  readonly competent: number;
  readonly complete: boolean;
  readonly completedOn: string | null;
} {
  const byId = new Map(rows.map((r) => [r.standardId, r]));
  const standards = CARE_CERTIFICATE_STANDARDS.map((s) => ({
    id: s.id,
    title: s.title,
    status: standardStatus(byId.get(s.id)),
  }));
  const competent = standards.filter((s) => s.status === "competent").length;
  const complete = competent === CARE_CERTIFICATE_STANDARDS.length;
  const completedOn = complete
    ? rows.reduce<string | null>(
        (latest, r) => (r.observedOn && (!latest || r.observedOn > latest) ? r.observedOn : latest),
        null,
      )
    : null;
  return { standards, competent, complete, completedOn };
}

/** The onboarding checklist (rule 19): what is ticked by hand, and what Harbour works out. */
export const INDUCTION_ITEMS = [
  { kind: "contract_issued", phase: "before_start", source: "ticked" },
  { kind: "pre_employment_checks", phase: "before_start", source: "staff_file" },
  { kind: "system_access_set_up", phase: "before_start", source: "ticked" },
  { kind: "uniform_and_badge", phase: "before_start", source: "ticked" },
  { kind: "location_induction", phase: "first_day", source: "ticked" },
  { kind: "fire_safety_briefing", phase: "first_day", source: "ticked" },
  { kind: "policy_read_and_sign", phase: "first_day", source: "policies" },
  { kind: "shadowing_signed_off", phase: "first_weeks", source: "ticked" },
  { kind: "care_certificate", phase: "first_weeks", source: "care_certificate" },
  { kind: "probation_decided", phase: "probation", source: "probation" },
] as const;
export type InductionItemKind = (typeof INDUCTION_ITEMS)[number]["kind"];
export const TICKED_INDUCTION_ITEMS: readonly InductionItemKind[] = INDUCTION_ITEMS.filter(
  (i) => i.source === "ticked",
).map((i) => i.kind);

export type ItemStatus = "done" | "outstanding" | "overdue" | "not_needed";

/**
 * Rule 19: where each onboarding item stands. A ticked item is done when ticked; the
 * pre-employment checks when the staff file is complete; read-and-sign when every published
 * policy the worker's roles need is signed; the Care Certificate when all 16 standards are
 * competent, or not needed where the organisation records it as already held; probation when
 * passed. An item due before the start date is overdue from the start date while outstanding;
 * the probation decision from the day after probation was due to end. Status is a word, never
 * a colour.
 */
export function inductionState(input: {
  readonly ticked: ReadonlySet<InductionItemKind>;
  readonly staffFileComplete: boolean;
  readonly policies: { readonly required: number; readonly signed: number };
  readonly careCertificate: { readonly complete: boolean; readonly alreadyHeld: boolean };
  readonly probation: { readonly endsOn: string | null; readonly outcome: ProbationOutcome | null };
  readonly startsOn: string;
  readonly today: string;
}): readonly { kind: InductionItemKind; phase: string; status: ItemStatus }[] {
  return INDUCTION_ITEMS.map((item) => {
    let done: boolean;
    let status: ItemStatus | null = null;
    switch (item.source) {
      case "ticked":
        done = input.ticked.has(item.kind);
        break;
      case "staff_file":
        done = input.staffFileComplete;
        break;
      case "policies":
        done = input.policies.signed >= input.policies.required;
        break;
      case "care_certificate":
        if (input.careCertificate.alreadyHeld) status = "not_needed";
        done = input.careCertificate.complete;
        break;
      case "probation":
        done = input.probation.outcome === "passed";
        break;
    }
    if (status === null) {
      if (done) status = "done";
      else if (item.phase === "before_start" && input.today >= input.startsOn) status = "overdue";
      else if (
        item.kind === "probation_decided" &&
        input.probation.endsOn !== null &&
        input.probation.outcome !== "extended" &&
        input.today > input.probation.endsOn
      )
        status = "overdue";
      else status = "outstanding";
    }
    return { kind: item.kind, phase: item.phase, status };
  });
}

export const PROBATION_REVIEW_OUTCOMES = ["on_track", "concerns"] as const;
export const PROBATION_OUTCOMES = ["passed", "extended", "not_passed"] as const;
export type ProbationOutcome = (typeof PROBATION_OUTCOMES)[number];

export type ProbationProblem =
  | "self_reviewed"
  | "no_probation"
  | "already_decided"
  | "new_end_required"
  | "new_end_not_allowed"
  | "date_before_start";

/**
 * Rule 21: probation ends with a decision by someone other than the worker: passed, extended to a
 * later date (it is then decided again), or not passed. A probation not passed is a dismissal
 * decision, made through an employee relations case of type `probation` (workforce.md rule 15);
 * this record notes it and links nothing.
 */
export function checkProbationDecision(input: {
  readonly workerId: string;
  readonly actorId: string;
  readonly endsOn: string | null;
  readonly currentOutcome: ProbationOutcome | null;
  readonly outcome: ProbationOutcome;
  readonly decidedOn: string;
  readonly startsOn: string;
  readonly newEndsOn: string | null;
}): { ok: true } | { ok: false; problem: ProbationProblem } {
  const fail = (problem: ProbationProblem) => ({ ok: false, problem }) as const;
  if (input.actorId === input.workerId) return fail("self_reviewed");
  if (input.endsOn === null) return fail("no_probation");
  if (input.currentOutcome === "passed" || input.currentOutcome === "not_passed") {
    return fail("already_decided");
  }
  if (input.decidedOn < input.startsOn) return fail("date_before_start");
  if (input.outcome === "extended") {
    if (input.newEndsOn === null || input.newEndsOn <= input.endsOn) {
      return fail("new_end_required");
    }
  } else if (input.newEndsOn !== null) {
    return fail("new_end_not_allowed");
  }
  return { ok: true };
}

/** Shadow shifts and probation reviews (rule 21): never by, or about, oneself. */
export function checkSupervisedEntry(input: {
  readonly workerId: string;
  readonly byId: string;
  readonly on: string;
  readonly today: string;
  readonly startsOn: string;
}): { ok: true } | { ok: false; problem: "self" | "date_in_future" | "date_before_start" } {
  if (input.byId === input.workerId) return { ok: false, problem: "self" };
  if (input.on > input.today) return { ok: false, problem: "date_in_future" };
  if (input.on < input.startsOn) return { ok: false, problem: "date_before_start" };
  return { ok: true };
}

export const LEAVING_REASONS = [
  "resignation",
  "end_of_fixed_term",
  "retirement",
  "dismissal",
  "redundancy",
  "tupe_transfer_out",
  "death_in_service",
  "other",
] as const;
export type LeavingReason = (typeof LEAVING_REASONS)[number];

export const LEAVER_ITEMS = [
  { kind: "property_returned", source: "ticked" },
  { kind: "final_pay_notified", source: "ticked" },
  { kind: "access_removed", source: "access" },
  { kind: "exit_interview", source: "exit_interview" },
] as const;
export type LeaverItemKind = (typeof LEAVER_ITEMS)[number]["kind"];
export const TICKED_LEAVER_ITEMS: readonly LeaverItemKind[] = LEAVER_ITEMS.filter(
  (i) => i.source === "ticked",
).map((i) => i.kind);

export const EXIT_INTERVIEW_STATES = ["not_offered", "offered", "declined", "held"] as const;
export type ExitInterviewState = (typeof EXIT_INTERVIEW_STATES)[number];

/** Rule 22: the leaving date is on or after the start, and a leaving is recorded once. */
export function checkLeaving(input: {
  readonly startsOn: string;
  readonly leavingOn: string;
  readonly alreadyLeaving: boolean;
  readonly workerId: string;
  readonly actorId: string;
}): { ok: true } | { ok: false; problem: "self" | "before_start" | "already_recorded" } {
  if (input.actorId === input.workerId) return { ok: false, problem: "self" };
  if (input.alreadyLeaving) return { ok: false, problem: "already_recorded" };
  if (input.leavingOn < input.startsOn) return { ok: false, problem: "before_start" };
  return { ok: true };
}

/**
 * Rule 22: access ends at the end of the leaving day, so from the UK day after it; earlier when a
 * manager ends it at once (a dismissal, for example).
 */
export function accessRemovalDue(leavingOn: string, today: string): boolean {
  return today > leavingOn;
}

/** Rule 22: the exit interview moves from not offered to offered, then declined or held. */
export function checkExitInterview(
  from: ExitInterviewState,
  to: ExitInterviewState,
  heldOn: string | null,
):
  | { ok: true }
  | { ok: false; problem: "not_allowed" | "held_on_required" | "held_on_not_allowed" } {
  const allowed: Record<ExitInterviewState, readonly ExitInterviewState[]> = {
    not_offered: ["offered", "declined", "held"],
    offered: ["declined", "held"],
    declined: [],
    held: [],
  };
  if (!allowed[from].includes(to)) return { ok: false, problem: "not_allowed" };
  if (to === "held" && heldOn === null) return { ok: false, problem: "held_on_required" };
  if (to !== "held" && heldOn !== null) return { ok: false, problem: "held_on_not_allowed" };
  return { ok: true };
}

/** The leaving checklist (rule 22). */
export function leaverState(input: {
  readonly ticked: ReadonlySet<LeaverItemKind>;
  readonly accessRemoved: boolean;
  readonly exitInterview: ExitInterviewState;
  readonly leavingOn: string;
  readonly today: string;
}): readonly { kind: LeaverItemKind; status: ItemStatus }[] {
  return LEAVER_ITEMS.map((item) => {
    let done: boolean;
    switch (item.source) {
      case "ticked":
        done = input.ticked.has(item.kind);
        break;
      case "access":
        done = input.accessRemoved;
        break;
      case "exit_interview":
        done = input.exitInterview === "held" || input.exitInterview === "declined";
        break;
    }
    const status: ItemStatus = done
      ? "done"
      : input.today > input.leavingOn
        ? "overdue"
        : "outstanding";
    return { kind: item.kind, status };
  });
}

export const REFERENCE_KINDS = ["factual", "conduct"] as const;
export const REFERENCE_STATES = ["requested", "sent", "declined"] as const;
export const REFERENCE_DECLINED_REASONS = [
  "no_consent_to_share",
  "not_employed_here",
  "duplicate_request",
] as const;

/**
 * Rule 23: how long the staff file is kept once employment ends (retention.md), from the
 * leaving date: `staff_file.after_leaving` (the period after leaving), or
 * `staff_file.to_75th_birthday` (until the later of leaving and the birthday at
 * `retention.staff_file.birthday_age`, from the rate table). Without a date of birth the
 * birthday cannot be worked out: the file is kept, and the date is left empty for a person to
 * decide (H-874).
 */
export function staffFileRetainUntil(input: {
  readonly leftOn: string;
  readonly dateOfBirth: string | null;
  readonly choice: "staff_file.after_leaving" | "staff_file.to_75th_birthday";
  readonly afterLeaving: { readonly period: number; readonly unit: "years" | "months" };
  readonly birthdayAge: number;
}): string | null {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const day = (s: string) => new Date(`${s}T00:00:00Z`);
  if (input.choice === "staff_file.after_leaving") {
    return iso(addPeriod(day(input.leftOn), input.afterLeaving.period, input.afterLeaving.unit));
  }
  if (input.dateOfBirth === null) return null;
  const birthday = iso(addPeriod(day(input.dateOfBirth), input.birthdayAge, "years"));
  return birthday > input.leftOn ? birthday : input.leftOn;
}
