import { addYears, daysBetween } from "./dates";

/**
 * Qualifications and NMC revalidation (workforce.md rule 8; WORK-012). A registered nurse's
 * registration must be current on the day worked (valid through its renewal date). Revalidation is
 * due every `nmc.revalidation.cycle_years` years on the date the NMC gives; the planner counts the
 * evidence against the NMC's requirements, each read from the rate table.
 */

export interface Registration {
  readonly body: "nmc" | "hcpc" | "swe" | "gmc";
  readonly pin: string;
  /** The last day the registration is valid unless renewed. */
  readonly renewalDueOn: string;
  /** NMC: the date the next revalidation application is due. */
  readonly revalidationDueOn: string | null;
  readonly lapsed?: boolean;
}

export function registrationCurrent(registration: Registration, today: string): boolean {
  return !registration.lapsed && registration.renewalDueOn >= today;
}

export interface RevalidationEvidence {
  readonly practiceHours: number;
  readonly cpdHours: number;
  readonly participatoryCpdHours: number;
  readonly feedbackPieces: number;
  readonly reflectiveAccounts: number;
  readonly reflectiveDiscussion: boolean;
  readonly healthAndCharacterDeclaration: boolean;
  readonly professionalIndemnity: boolean;
  readonly confirmation: boolean;
}

export interface RevalidationRates {
  readonly nmcCycleYears: number;
  readonly nmcPracticeHours: number;
  readonly nmcCpdHours: number;
  readonly nmcParticipatoryCpdHours: number;
  readonly nmcFeedbackCount: number;
  readonly nmcReflectiveAccounts: number;
}

export type RevalidationRequirement =
  | "practice_hours"
  | "cpd_hours"
  | "participatory_cpd_hours"
  | "feedback"
  | "reflective_accounts"
  | "reflective_discussion"
  | "health_and_character"
  | "professional_indemnity"
  | "confirmation";

export interface RevalidationPlan {
  readonly dueOn: string;
  readonly daysLeft: number;
  readonly outstanding: readonly RevalidationRequirement[];
  readonly ready: boolean;
}

export function revalidationPlan(
  dueOn: string,
  evidence: RevalidationEvidence,
  today: string,
  rates: RevalidationRates,
): RevalidationPlan {
  const checks: [RevalidationRequirement, boolean][] = [
    ["practice_hours", evidence.practiceHours >= rates.nmcPracticeHours],
    ["cpd_hours", evidence.cpdHours >= rates.nmcCpdHours],
    ["participatory_cpd_hours", evidence.participatoryCpdHours >= rates.nmcParticipatoryCpdHours],
    ["feedback", evidence.feedbackPieces >= rates.nmcFeedbackCount],
    ["reflective_accounts", evidence.reflectiveAccounts >= rates.nmcReflectiveAccounts],
    ["reflective_discussion", evidence.reflectiveDiscussion],
    ["health_and_character", evidence.healthAndCharacterDeclaration],
    ["professional_indemnity", evidence.professionalIndemnity],
    ["confirmation", evidence.confirmation],
  ];
  const outstanding = checks.filter(([, met]) => !met).map(([name]) => name);
  return {
    dueOn,
    daysLeft: daysBetween(today, dueOn),
    outstanding,
    ready: outstanding.length === 0,
  };
}

/** The revalidation after one completed on `revalidatedOn`. */
export function nextRevalidationDue(revalidatedOn: string, rates: RevalidationRates): string {
  return addYears(revalidatedOn, rates.nmcCycleYears);
}

/** Who confirms a revalidation: HR or a line manager (rule 8; the NMC's revalidation guidance). */
export const REVALIDATION_CONFIRMING_PERMISSIONS = [
  "workforce.training.manage",
  "workforce.supervision.manage",
] as const;
/** Naming the confirmer is part of HR's planner. */
const TRAINING_MANAGE = "workforce.training.manage";

export type RevalidationConfirmationProblem =
  | "own_record"
  | "not_permitted"
  | "no_confirmer"
  | "not_the_confirmer"
  | "not_reviewed"
  | "already_confirmed";

/**
 * Rule 8 (H-693), separation of duties: the confirmation is recorded only by the confirmer named
 * on the cycle, acting for themselves, after HR's review, never by the nurse. HR keeps the rest
 * of the planner but cannot tick the confirmation unless someone else named them confirmer.
 */
export function checkRevalidationConfirmation(input: {
  readonly actorId: string;
  readonly actorPermissions: readonly string[];
  readonly workerId: string;
  readonly confirmerId: string | null;
  readonly reviewState: "draft" | "submitted" | "reviewed";
  readonly confirmed: boolean;
}): { ok: true } | { ok: false; problem: RevalidationConfirmationProblem } {
  const fail = (problem: RevalidationConfirmationProblem) => ({ ok: false, problem }) as const;
  if (input.actorId === input.workerId) return fail("own_record");
  if (!REVALIDATION_CONFIRMING_PERMISSIONS.some((p) => input.actorPermissions.includes(p))) {
    return fail("not_permitted");
  }
  if (input.confirmerId === null) return fail("no_confirmer");
  if (input.confirmerId !== input.actorId) return fail("not_the_confirmer");
  if (input.reviewState !== "reviewed") return fail("not_reviewed");
  if (input.confirmed) return fail("already_confirmed");
  return { ok: true };
}

export type ConfirmerNamingProblem =
  | "own_record"
  | "not_permitted"
  | "names_worker"
  | "names_self"
  | "already_confirmed";

/**
 * HR (`workforce.training.manage`) names who confirms a nurse's revalidation: never on their own
 * record, never the nurse, never themselves (so nobody can make themselves the confirmer), and
 * never once it is confirmed.
 */
export function checkConfirmerNaming(input: {
  readonly actorId: string;
  readonly actorPermissions: readonly string[];
  readonly workerId: string;
  readonly confirmerId: string;
  readonly confirmed: boolean;
}): { ok: true } | { ok: false; problem: ConfirmerNamingProblem } {
  const fail = (problem: ConfirmerNamingProblem) => ({ ok: false, problem }) as const;
  if (input.actorId === input.workerId) return fail("own_record");
  if (!input.actorPermissions.includes(TRAINING_MANAGE)) return fail("not_permitted");
  if (input.confirmerId === input.workerId) return fail("names_worker");
  if (input.confirmerId === input.actorId) return fail("names_self");
  if (input.confirmed) return fail("already_confirmed");
  return { ok: true };
}
