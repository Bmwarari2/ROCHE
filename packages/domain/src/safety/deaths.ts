/**
 * Deaths (safety.md Phase 2 rule 4; SAFE-014; death certification reforms from 9 September 2024;
 * Regulation 16; LeDeR). Whether a death was expected is the clinician's recorded judgement, never
 * Harbour's. The steps each death needs are listed so none is missed; Harbour does not decide cause.
 */

import { addUkDays } from "../shared/time";
import type { SafetyPhase2Rates } from "./phase2-rates";

export type DeathStep =
  | "verification_of_death"
  | "family_informed"
  | "medical_examiner_pack"
  | "cqc_reg16_notification"
  | "leder_notification"
  | "police_informed"
  | "preserve_room_and_equipment"
  | "mortality_review";

export interface DeathFacts {
  readonly diedAt: Date;
  /** The clinician's judgement, as recorded. */
  readonly expected: boolean;
  readonly learningDisabilityOrAutism: boolean;
  /** Whether the cause may be unnatural, violent or unknown, or the circumstances suspicious. */
  readonly possiblyUnnatural: boolean;
}

export interface DeathPlan {
  readonly steps: readonly DeathStep[];
  readonly mortalityReviewDueAt: Date;
  readonly reasons: Readonly<Partial<Record<DeathStep, string>>>;
}

export function deathPlan(
  facts: DeathFacts,
  rates: Pick<SafetyPhase2Rates, "mortalityReviewDueDays">,
): DeathPlan {
  const steps: DeathStep[] = [
    "verification_of_death",
    "family_informed",
    "medical_examiner_pack",
    "cqc_reg16_notification",
  ];
  const reasons: Partial<Record<DeathStep, string>> = {
    medical_examiner_pack:
      "Every death not referred straight to the coroner is reviewed by a medical examiner",
    cqc_reg16_notification: "Regulation 16: notify CQC of the death of a person using the service",
  };
  if (facts.learningDisabilityOrAutism) {
    steps.push("leder_notification");
    reasons.leder_notification = "The person had a learning disability or autism: notify LeDeR";
  }
  if (!facts.expected || facts.possiblyUnnatural) {
    steps.push("police_informed", "preserve_room_and_equipment");
    reasons.police_informed = facts.possiblyUnnatural
      ? "The cause may be unnatural or the circumstances suspicious: tell the police, who tell the coroner"
      : "The death was unexpected: follow the tenant's procedure for informing the police";
    reasons.preserve_room_and_equipment =
      "Leave the room and equipment as they are until told otherwise";
  }
  steps.push("mortality_review");
  reasons.mortality_review = `A mortality review is due within ${rates.mortalityReviewDueDays} days (your organisation's target)`;
  return {
    steps,
    mortalityReviewDueAt: addUkDays(facts.diedAt, rates.mortalityReviewDueDays),
    reasons,
  };
}

/** Steps not yet done, in plan order. */
export function outstandingDeathSteps(plan: DeathPlan, done: ReadonlySet<DeathStep>): DeathStep[] {
  return plan.steps.filter((step) => !done.has(step));
}
