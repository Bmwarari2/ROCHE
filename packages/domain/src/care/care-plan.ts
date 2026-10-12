/**
 * The personalised care and support plan (care.md section 4 rules 1 and 2; master prompt 10.1;
 * register row CARE-001).
 *
 * Structure. The PRSB Personalised Care and Support Plan standard v2.0 (December 2021,
 * https://theprsb.org/standards/personalisedcareandsupportplan/) has four main sections: About Me,
 * Care and support plan, Contingency plans and Additional support plans. About Me is its own record
 * (`about_me`); risk assessments and advance care records are additional support plans. Harbour's
 * "Care and support plan" is divided into the 16 need domains listed in master prompt 10.1, each
 * with the need, the outcome in the person's words, their strengths, the contingency plan and the
 * actions (who and when). The mapping is in docs/specs/data-standards.md.
 *
 * Timing. The first plan is due within `care_plan.initial_working_days` working days of admission
 * (England, the EHCH framework tenant default; no figure exists yet for the other nations, so no
 * deadline is guessed for them), and each plan is reviewed every `care_plan.review_interval_months`
 * months and on change. Figures come from the rate table and are passed in.
 */

import { type RateNation, RateNotFoundError, type RateRow, resolveRate } from "../platform/rates";
import { type Recurrence, RecurrenceError, validateRecurrence } from "../platform/tasks";
import { addWorkingDays, type BankHolidays, workingDaysDeadline } from "../shared/working-days";
import { addMonthsToDate, isIsoDate } from "./assessment";

export const PCSP_STANDARD = {
  name: "PRSB Personalised Care and Support Plan",
  version: "2.0",
  released: "December 2021",
  url: "https://theprsb.org/standards/personalisedcareandsupportplan/",
} as const;

/** The 16 need domains of the care and support plan (master prompt 10.1). */
export const PCSP_DOMAINS = [
  "mobility",
  "skin",
  "nutrition_and_hydration",
  "continence",
  "communication",
  "cognition",
  "mood",
  "behaviour",
  "sleep",
  "pain",
  "breathing",
  "medicines",
  "personal_care",
  "social_and_spiritual",
  "sexuality_and_relationships",
  "end_of_life",
] as const;

export type PcspDomain = (typeof PCSP_DOMAINS)[number];

export const PCSP_DOMAIN_LABELS: Readonly<Record<PcspDomain, string>> = {
  mobility: "Mobility",
  skin: "Skin",
  nutrition_and_hydration: "Nutrition and hydration",
  continence: "Continence",
  communication: "Communication",
  cognition: "Cognition",
  mood: "Mood",
  behaviour: "Behaviour",
  sleep: "Sleep",
  pain: "Pain",
  breathing: "Breathing",
  medicines: "Medicines",
  personal_care: "Personal care",
  social_and_spiritual: "Social and spiritual",
  sexuality_and_relationships: "Sexuality and relationships",
  end_of_life: "End of life",
};

export type CarePlanStatus = "draft" | "active" | "superseded";

// ------------------------------------------------------------------------------------------------
// Rule 1: timing
// ------------------------------------------------------------------------------------------------

export const CARE_PLAN_RATE_KEYS = {
  initialWorkingDays: "care_plan.initial_working_days",
  reviewIntervalMonths: "care_plan.review_interval_months",
} as const;

export interface CarePlanRates {
  /** Null where the rate table has no figure for the location's nation. */
  readonly initialWorkingDays: number | null;
  readonly reviewIntervalMonths: number;
}

export function resolveCarePlanRates(
  rows: readonly RateRow[],
  nation: Exclude<RateNation, "uk" | "all">,
  on: string,
  tenantId: string | null,
): CarePlanRates {
  let initialWorkingDays: number | null = null;
  try {
    initialWorkingDays = resolveRate(
      rows,
      CARE_PLAN_RATE_KEYS.initialWorkingDays,
      nation,
      on,
      tenantId,
    ).value;
  } catch (error) {
    if (!(error instanceof RateNotFoundError)) throw error;
  }
  return {
    initialWorkingDays,
    reviewIntervalMonths: resolveRate(
      rows,
      CARE_PLAN_RATE_KEYS.reviewIntervalMonths,
      nation,
      on,
      tenantId,
    ).value,
  };
}

export interface FirstPlanDue {
  /** The last day on which the first plan is on time (UK date). */
  readonly dueOn: string;
  /** Midnight UK time at the end of `dueOn`. */
  readonly deadline: Date;
}

/** The first plan is due by the end of the Nth working day after the admission day. */
export function firstCarePlanDue(
  admittedOn: string,
  workingDays: number,
  holidays: BankHolidays,
): FirstPlanDue {
  if (!isIsoDate(admittedOn)) throw new RangeError(`Not a date: ${admittedOn}`);
  // Midday UTC is the admission day in UK time whatever the season.
  const admitted = new Date(`${admittedOn}T12:00:00Z`);
  return {
    dueOn: addWorkingDays(admittedOn, workingDays, holidays),
    deadline: workingDaysDeadline(admitted, workingDays, holidays),
  };
}

export type CarePlanDueState =
  | {
      readonly kind: "first_plan";
      /** Null when the rate table has no first-plan figure for the nation or no admission date. */
      readonly dueOn: string | null;
      readonly overdue: boolean;
    }
  | { readonly kind: "review"; readonly dueOn: string; readonly overdue: boolean };

/**
 * What is due next: the first plan until one is active, then its review. Due on a day means on
 * time all that day; overdue from the next day.
 */
export function carePlanDue(input: {
  readonly today: string;
  readonly activeReviewDueOn: string | null;
  readonly firstPlanDueOn: string | null;
}): CarePlanDueState {
  if (input.activeReviewDueOn !== null) {
    return {
      kind: "review",
      dueOn: input.activeReviewDueOn,
      overdue: input.today > input.activeReviewDueOn,
    };
  }
  return {
    kind: "first_plan",
    dueOn: input.firstPlanDueOn,
    overdue: input.firstPlanDueOn !== null && input.today > input.firstPlanDueOn,
  };
}

/**
 * A change in the person's needs (a new screening band, a fall, a return from hospital) brings the
 * review forward to the day of the change; it never puts a review back.
 */
export function reviewOnChange(currentDueOn: string | null, changedOn: string): string {
  return currentDueOn === null || changedOn < currentDueOn ? changedOn : currentDueOn;
}

// ------------------------------------------------------------------------------------------------
// Rule 2: publication
// ------------------------------------------------------------------------------------------------

export interface PlanActionDraft {
  readonly generatesTasks: boolean;
  readonly recurrence: Recurrence | null;
  readonly roleKey: string | null;
  /** The need domain of the action's section, where known. */
  readonly domain?: PcspDomain;
}

/**
 * Need domains whose actions never generate tasks (care.md rule 14). Medicines rounds come from
 * the medicines record (the eMAR, Phase 2), never from the care plan, so a care plan task can never
 * be ticked off as if it were a dose (HZ-003, HZ-004). The CSO confirms the rule (H-151).
 */
export const DOMAINS_WITHOUT_PLAN_TASKS: readonly PcspDomain[] = ["medicines"];

export const MEDICINES_ACTION_MESSAGE =
  "Medicines rounds come from the medicines record, so a medicines action cannot generate tasks. Describe the support here and leave the rounds to the MAR.";

/** Whether an action in this need domain may generate tasks. */
export function planActionGeneratesTasks(domain: PcspDomain): boolean {
  return !DOMAINS_WITHOUT_PLAN_TASKS.includes(domain);
}

export interface PlanSectionDraft {
  readonly domain: PcspDomain;
  readonly need: string | null;
  readonly outcome: string | null;
  readonly actions: readonly PlanActionDraft[];
}

export type PublicationProblem =
  | "not_a_draft"
  | "no_sections"
  | "section_incomplete"
  | "action_incomplete";

export interface PublicationIssue {
  readonly problem: PublicationProblem;
  readonly domain?: PcspDomain;
  readonly message: string;
}

export type PublicationCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly PublicationIssue[] };

const filled = (value: string | null | undefined) => (value?.trim().length ?? 0) > 0;

/**
 * Two rounds of one action closer together than this are one round: such times are refused when
 * the action is written (`checkPlanAction`), and where a clock change brings two rounds this close
 * (01:00 and 02:00 are the same instant on the night the clocks go forward) they are merged, so a
 * round is never made twice at the same moment (HZ-004).
 */
export const MIN_ROUND_GAP_MINUTES = 10;

/**
 * Consecutive occurrences of one action at least `MIN_ROUND_GAP_MINUTES` apart on the clock face,
 * for every frequency: within a day, from one day's last time to the next day's first for a daily
 * schedule, from one weekday's last time to the next weekday's first for a weekly one (Monday 23:55
 * and Tuesday 00:00 are 5 minutes apart), and from the last time of the cycle to the first of the
 * next. Returns the message when they are not.
 */
export function roundGapProblem(rule: Recurrence): string | null {
  if (rule.freq === "every_hours") return null;
  const DAY = 24 * 60;
  const times = [...new Set(rule.times)].map((time) => {
    const [h, m] = time.split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  });
  const interval = rule.interval ?? 1;
  // Each occurrence as minutes from the start of its cycle, and the cycle's length.
  let offsets: number[];
  let cycle: number;
  if (rule.freq === "weekly") {
    const days = [...new Set(rule.weekdays)].map((d) => WEEKDAYS.indexOf(d));
    offsets = days.flatMap((d) => times.map((m) => d * DAY + m));
    cycle = 7 * DAY * interval;
  } else if (rule.freq === "daily") {
    offsets = times;
    cycle = DAY * interval;
  } else {
    // Monthly: the next month's first time is at least 28 days on.
    offsets = times;
    cycle = 28 * DAY * interval;
  }
  offsets.sort((x, y) => x - y);
  const gaps = offsets.slice(1).map((m, i) => m - (offsets[i] as number));
  const first = offsets[0];
  const last = offsets.at(-1);
  if (first !== undefined && last !== undefined) gaps.push(cycle - last + first);
  return gaps.some((g) => g < MIN_ROUND_GAP_MINUTES)
    ? `Times for one action must be at least ${MIN_ROUND_GAP_MINUTES} minutes apart.`
    : null;
}

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export type ActionCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly field: "recurrence" | "role" | "generatesTasks";
      readonly message: string;
    };

/**
 * An action that generates tasks (a task series, care.md rule 14) needs a valid schedule in the
 * location's time zone and the role that carries it out, and never sits in a domain without plan
 * tasks (medicines). Other actions are done as needed.
 */
export function checkPlanAction(action: PlanActionDraft, startsOn: string): ActionCheck {
  if (!action.generatesTasks) return { ok: true };
  if (action.domain && !planActionGeneratesTasks(action.domain)) {
    return { ok: false, field: "generatesTasks", message: MEDICINES_ACTION_MESSAGE };
  }
  if (action.recurrence === null) {
    return { ok: false, field: "recurrence", message: "Say when the action happens." };
  }
  try {
    validateRecurrence({ rule: action.recurrence, startsOn });
  } catch (error) {
    if (error instanceof RecurrenceError) {
      return { ok: false, field: "recurrence", message: error.message };
    }
    throw error;
  }
  const gap = roundGapProblem(action.recurrence);
  if (gap) return { ok: false, field: "recurrence", message: gap };
  if (!filled(action.roleKey)) {
    return { ok: false, field: "role", message: "Say which role carries out the action." };
  }
  return { ok: true };
}

/** A plan is published only from a draft with at least one complete section. */
export function checkPublication(plan: {
  readonly status: CarePlanStatus;
  readonly sections: readonly PlanSectionDraft[];
}): PublicationCheck {
  if (plan.status !== "draft") {
    return {
      ok: false,
      issues: [{ problem: "not_a_draft", message: "Only a draft plan can be published." }],
    };
  }
  if (plan.sections.length === 0) {
    return {
      ok: false,
      issues: [{ problem: "no_sections", message: "Add at least one need before publishing." }],
    };
  }
  const issues: PublicationIssue[] = [];
  for (const section of plan.sections) {
    const label = PCSP_DOMAIN_LABELS[section.domain];
    if (!filled(section.need) || !filled(section.outcome)) {
      issues.push({
        problem: "section_incomplete",
        domain: section.domain,
        message: `${label}: record the need and the outcome in the person's words.`,
      });
    }
    for (const action of section.actions) {
      const check = checkPlanAction({ ...action, domain: section.domain }, "2000-01-01");
      if (!check.ok) {
        issues.push({
          problem: "action_incomplete",
          domain: section.domain,
          message: `${label}: ${check.message}`,
        });
      }
    }
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

export interface PlanPublication {
  readonly publishedVersion: number;
  /** The active plan this one replaces, which becomes `superseded`. */
  readonly supersedesPlanId: string | null;
  readonly reviewDueOn: string;
}

/**
 * Publishing makes the draft the active plan, supersedes the previous one, and sets the review
 * date: the review interval from today, or earlier if the clinician asks for an earlier review.
 */
export function planPublication(
  input: {
    readonly active: { readonly id: string; readonly publishedVersion: number } | null;
    readonly today: string;
    readonly requestedReviewOn: string | null;
  },
  rates: Pick<CarePlanRates, "reviewIntervalMonths">,
): PlanPublication {
  const latest = addMonthsToDate(input.today, rates.reviewIntervalMonths);
  const requested = input.requestedReviewOn;
  if (requested !== null) {
    if (!isIsoDate(requested)) throw new RangeError("The review date must be a real date.");
    if (requested < input.today) throw new RangeError("The review date cannot be in the past.");
    if (requested > latest) {
      throw new RangeError("The review date cannot be later than the review interval allows.");
    }
  }
  return {
    publishedVersion: (input.active?.publishedVersion ?? 0) + 1,
    supersedesPlanId: input.active?.id ?? null,
    reviewDueOn: requested ?? latest,
  };
}

/** Only an active plan drives tasks; drafts and superseded versions never do. */
export function actionsDrivingTasks<A extends { readonly generatesTasks: boolean }>(plan: {
  readonly status: CarePlanStatus;
  readonly actions: readonly A[];
}): A[] {
  return plan.status === "active" ? plan.actions.filter((a) => a.generatesTasks) : [];
}

// ------------------------------------------------------------------------------------------------
// Rule 2: sign-off
// ------------------------------------------------------------------------------------------------

/** Who, besides the person, may agree the plan for them (their authority is recorded). */
export const REPRESENTATIVE_AUTHORITIES = [
  "lpa_health_welfare",
  "deputy",
  "imca",
  "advocate",
  "next_of_kin",
  "other",
] as const;

export type SignOffAuthority = (typeof REPRESENTATIVE_AUTHORITIES)[number];

export type SignOff =
  | { readonly agreedBy: "person" }
  | {
      readonly agreedBy: "representative";
      readonly representativeName?: string | null;
      readonly authority?: SignOffAuthority | null;
    }
  | { readonly agreedBy: "unable"; readonly reason?: string | null };

/** A reason is a sentence, not a placeholder such as "n/a". */
export const MIN_SIGN_OFF_REASON_LENGTH = 10;

export type SignOffCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly field: "representativeName" | "authority" | "reason";
      readonly message: string;
    };

export function checkSignOff(signOff: SignOff): SignOffCheck {
  if (signOff.agreedBy === "representative") {
    if (!filled(signOff.representativeName)) {
      return {
        ok: false,
        field: "representativeName",
        message: "Record who agreed the plan for the person.",
      };
    }
    if (!signOff.authority) {
      return {
        ok: false,
        field: "authority",
        message: "Record the representative's authority, for example a lasting power of attorney.",
      };
    }
  }
  if (
    signOff.agreedBy === "unable" &&
    (signOff.reason?.trim().length ?? 0) < MIN_SIGN_OFF_REASON_LENGTH
  ) {
    return {
      ok: false,
      field: "reason",
      message: "Say why the person or a representative could not agree the plan.",
    };
  }
  return { ok: true };
}
