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
