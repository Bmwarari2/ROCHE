/**
 * The death record (safety.md Phase 2 rule 4 and slice 37; SAFE-014; HZ-013): one per death recorded
 * on the person's exit, holding the clinician's judgement (expected or not, whether the cause may
 * be unnatural), the steps the death needs (`deathPlan`) with who did each and when, and the
 * mortality review. The notification steps follow the notification centre, never a tick here: the
 * regulator's death notification, the medical examiner information and LeDeR are done when
 * submitted or decided not required there. Until the judgement is recorded the plan assumes the
 * death was unexpected and may be unnatural, so the police steps are never missed (fail safe).
 * Harbour never decides the cause, or whether the death was expected.
 */

import { type DeathPlan, type DeathStep, deathPlan } from "./deaths";
import type { NotificationStatus, StatutoryNotificationKind } from "./notifications";
import type { SafetyPhase2Rates } from "./phase2-rates";

export const DEATH_RECORD_STATUSES = ["open", "closed", "withdrawn"] as const;
export type DeathRecordStatus = (typeof DEATH_RECORD_STATUSES)[number];

/** Every step a death can need, in plan order. */
export const DEATH_STEPS: readonly DeathStep[] = [
  "verification_of_death",
  "family_informed",
  "medical_examiner_pack",
  "cqc_reg16_notification",
  "leder_notification",
  "police_informed",
  "preserve_room_and_equipment",
  "mortality_review",
];

/** The steps whose doing is recorded on the death record. */
export const RECORDED_DEATH_STEPS: readonly DeathStep[] = [
  "verification_of_death",
  "family_informed",
  "police_informed",
  "preserve_room_and_equipment",
];

/** The steps done in the notification centre, by the notification that does them. */
export const NOTIFICATION_DEATH_STEPS: Readonly<
  Partial<Record<DeathStep, StatutoryNotificationKind>>
> = {
  medical_examiner_pack: "medical_examiner",
  cqc_reg16_notification: "cqc_reg16_death",
  leder_notification: "leder",
};

/** `done`, or `not_needed` with the reason (for example, the person died in hospital). */
export const DEATH_STEP_OUTCOMES = ["done", "not_needed"] as const;
export type DeathStepOutcome = (typeof DEATH_STEP_OUTCOMES)[number];

/** The shortest reason for a step not needed, and for each part of the mortality review. */
export const DEATH_REASON_MIN = 20;

export interface DeathRecordFacts {
  readonly diedAt: Date;
  /** The clinician's judgement as recorded; null until recorded. */
  readonly expected: boolean | null;
  /** Whether the cause may be unnatural, violent or unknown, or the circumstances suspicious. */
  readonly possiblyUnnatural: boolean | null;
  readonly learningDisabilityOrAutism: boolean;
}

export interface RecordedDeathStep {
  readonly step: DeathStep;
  readonly outcome: DeathStepOutcome;
  readonly at: Date;
}

export interface DeathReview {
  readonly findings: string | null;
  readonly lessons: string | null;
  readonly reviewedAt: Date | null;
}

/**
 * `done`; `not_needed` with a reason; `waiting` (its notification is a draft or ready); or
 * `outstanding` (nothing recorded, or no notification drafted to do it).
 */
export type DeathStepState = "done" | "not_needed" | "waiting" | "outstanding";

export interface DeathStepView {
  readonly step: DeathStep;
  readonly state: DeathStepState;
  /** When it was recorded as done or not needed here; null for one done in the notification centre. */
  readonly at: Date | null;
  /** For a notification step: its notification's status, or null when none was drafted. */
  readonly notificationStatus: NotificationStatus | null;
  readonly reason: string | null;
}

export interface DeathRecordView {
  readonly plan: DeathPlan;
  readonly steps: readonly DeathStepView[];
  /** The judgement not yet recorded: the plan assumes the safer answer until it is. */
  readonly missingFacts: readonly ("expected" | "possiblyUnnatural")[];
  readonly reviewDueAt: Date;
  readonly reviewOverdue: boolean;
  readonly closeProblems: readonly string[];
}

const LABEL: Readonly<Record<DeathStep, string>> = {
  verification_of_death: "verification of death",
  family_informed: "telling the family",
  medical_examiner_pack: "the medical examiner information",
  cqc_reg16_notification: "the regulator's death notification",
  leder_notification: "the LeDeR notification",
  police_informed: "telling the police",
  preserve_room_and_equipment: "leaving the room and equipment as they are",
  mortality_review: "the mortality review",
};

/** The plan for the facts as recorded, assuming the safer answer for any not yet recorded. */
export function deathRecordPlan(
  facts: DeathRecordFacts,
  rates: Pick<SafetyPhase2Rates, "mortalityReviewDueDays">,
): DeathPlan {
  return deathPlan(
    {
      diedAt: facts.diedAt,
      expected: facts.expected === true,
      possiblyUnnatural: facts.possiblyUnnatural !== false,
      learningDisabilityOrAutism: facts.learningDisabilityOrAutism,
    },
    rates,
  );
}

/** The record as it stands: each step's state, what is missing, and what closing needs. */
export function deathRecordView(input: {
  readonly facts: DeathRecordFacts;
  /** Steps recorded here, oldest first: the latest for a step counts. */
  readonly recorded: readonly RecordedDeathStep[];
  /** The notifications counted for this death, by kind. */
  readonly notifications: Readonly<Partial<Record<StatutoryNotificationKind, NotificationStatus>>>;
  readonly review: DeathReview;
  readonly now: Date;
  readonly rates: Pick<SafetyPhase2Rates, "mortalityReviewDueDays">;
}): DeathRecordView {
  const plan = deathRecordPlan(input.facts, input.rates);
  const latest = new Map<DeathStep, RecordedDeathStep>();
  for (const r of input.recorded) latest.set(r.step, r);
  const steps = plan.steps.map((step): DeathStepView => {
    const reason = plan.reasons[step] ?? null;
    const recorded = latest.get(step);
    if (step === "mortality_review") {
      return {
        step,
        state: input.review.reviewedAt ? "done" : "outstanding",
        at: input.review.reviewedAt,
        notificationStatus: null,
        reason,
      };
    }
    const kind = NOTIFICATION_DEATH_STEPS[step];
    if (kind) {
      const status = input.notifications[kind] ?? null;
      if (status === "submitted" || status === "not_required") {
        return { step, state: "done", at: null, notificationStatus: status, reason };
      }
      if (recorded?.outcome === "not_needed") {
        return { step, state: "not_needed", at: recorded.at, notificationStatus: status, reason };
      }
      return {
        step,
        state: status ? "waiting" : "outstanding",
        at: null,
        notificationStatus: status,
        reason,
      };
    }
    return {
      step,
      state: recorded ? recorded.outcome : "outstanding",
      at: recorded?.at ?? null,
      notificationStatus: null,
      reason,
    };
  });
  const missingFacts: ("expected" | "possiblyUnnatural")[] = [];
  if (input.facts.expected === null) missingFacts.push("expected");
  if (input.facts.possiblyUnnatural === null) missingFacts.push("possiblyUnnatural");
  const closeProblems: string[] = [];
  if (missingFacts.includes("expected")) {
    closeProblems.push("Record whether the death was expected, in the clinician's judgement.");
  }
  if (missingFacts.includes("possiblyUnnatural")) {
    closeProblems.push(
      "Record whether the cause may be unnatural or the circumstances suspicious, in the clinician's judgement.",
    );
  }
  for (const s of steps) {
    if (s.state === "done" || s.state === "not_needed") continue;
    if (s.step === "mortality_review") {
      closeProblems.push("Record the mortality review: its findings and lessons.");
    } else if (s.state === "waiting") {
      closeProblems.push(
        `Submit ${LABEL[s.step]}, or decide it is not required, in the notification centre.`,
      );
    } else {
      closeProblems.push(`Record ${LABEL[s.step]}, or why it is not needed.`);
    }
  }
  return {
    plan,
    steps,
    missingFacts,
    reviewDueAt: plan.mortalityReviewDueAt,
    reviewOverdue: !input.review.reviewedAt && input.now > plan.mortalityReviewDueAt,
    closeProblems,
  };
}

/**
 * Why a step cannot be recorded: it is not in this death's plan; the mortality review is recorded
 * on its own; a notification step is done only in the notification centre (here only "not
 * needed"); "not needed" takes a reason of at least `DEATH_REASON_MIN` characters; the time is
 * not later than now nor earlier than the death.
 */
export function deathStepProblems(
  plan: DeathPlan,
  diedAt: Date,
  step: {
    readonly step: DeathStep;
    readonly outcome: DeathStepOutcome;
    readonly at: Date;
    readonly note: string | null;
  },
  now: Date,
): string[] {
  const problems: string[] = [];
  if (step.step === "mortality_review") {
    problems.push("Record the mortality review on its own, with its findings and lessons.");
  } else if (!plan.steps.includes(step.step)) {
    problems.push("This step is not needed for this death as recorded.");
  } else if (NOTIFICATION_DEATH_STEPS[step.step] && step.outcome === "done") {
    problems.push(
      "This step is done in the notification centre: submit the notification there, or record here why it is not needed.",
    );
  }
  if (step.outcome === "not_needed" && (step.note?.trim().length ?? 0) < DEATH_REASON_MIN) {
    problems.push(`Say why it is not needed, in at least ${DEATH_REASON_MIN} characters.`);
  }
  if (step.at > now) problems.push("The time cannot be in the future.");
  if (step.at < diedAt) problems.push("The time cannot be before the death.");
  return problems;
}

/** The mortality review needs its findings and lessons, each at least `DEATH_REASON_MIN` characters. */
export function deathReviewProblems(review: {
  readonly findings: string | null | undefined;
  readonly lessons: string | null | undefined;
}): string[] {
  const problems: string[] = [];
  if ((review.findings?.trim().length ?? 0) < DEATH_REASON_MIN) {
    problems.push(`Record the review's findings, in at least ${DEATH_REASON_MIN} characters.`);
  }
  if ((review.lessons?.trim().length ?? 0) < DEATH_REASON_MIN) {
    problems.push(
      `Record the lessons, or that there are none and why, in at least ${DEATH_REASON_MIN} characters.`,
    );
  }
  return problems;
}
