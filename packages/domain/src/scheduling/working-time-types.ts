/**
 * Shared types for the working time rules (SCHED-003; scheduling.md section 4). Pure data: the
 * rota (slice 21) and time and attendance (slice 30) build these from shifts, clock events and
 * timesheet entries, and the checks never read a database.
 */

/** What a planned or recorded period of time was (scheduling.md rules 9 and 10). */
export type WorkPeriodKind =
  /** A shift, visit or duty: working time. */
  | "work"
  /** Job-related training: working time. */
  | "training"
  /** A sleep-in at the workplace, permitted to sleep: on call at the workplace. */
  | "sleep_in"
  /** On call at the workplace and not permitted to sleep. */
  | "on_call_at_workplace"
  /** On call away from the workplace: not working time; a call-out is recorded as `work`. */
  | "on_call_away"
  /** Travel; `travel` on the period says which journey. */
  | "travel";

export type TravelKind =
  /** From one visit or assignment to the next. */
  | "between_assignments"
  /** Home to the first visit, for a worker with no fixed place of work. */
  | "home_to_first_assignment"
  /** Last visit to home, for a worker with no fixed place of work. */
  | "last_assignment_to_home"
  /** Home to a fixed place of work and back: commuting. */
  | "commute_to_fixed_workplace";

export interface TimeSpan {
  readonly start: Date;
  readonly end: Date;
}

/** The sleep-in details the national minimum wage needs (Mencap 2021). */
export interface SleepInDetail {
  /** The worker is expected to sleep for all or most of the shift. */
  readonly expectedToSleep: boolean;
  /** The employer provides suitable sleeping facilities. */
  readonly suitableSleepingFacilities: boolean;
  /** Times awake for the purposes of working, logged per event. */
  readonly awake: readonly TimeSpan[];
}

/**
 * A recorded reason that lets a young worker's time fall outside a limit (regulations 10(3),
 * 11(8) and 27A). Each needs a reason in words; 27A(1) also needs both conditions confirmed.
 */
export type YoungWorkerException =
  | {
      /** Reg 27A(1): continuity of service or a surge in demand. */
      readonly basis: "continuity_or_surge";
      readonly noAdultAvailable: boolean;
      readonly educationUnaffected: boolean;
      readonly reason: string;
    }
  | {
      /** Reg 10(3) and 11(8)(a): work split up over the day or of short duration. */
      readonly basis: "split_or_short_duration";
      readonly reason: string;
    }
  | {
      /** Reg 11(8)(b): technical or organisation reasons (weekly rest down to the minimum). */
      readonly basis: "technical_or_organisational";
      readonly reason: string;
    };

export interface WorkPeriod extends TimeSpan {
  /** Opaque id of the shift, visit or timesheet entry. */
  readonly id: string;
  readonly kind: WorkPeriodKind;
  /** Required when `kind` is `travel`. */
  readonly travel?: TravelKind;
  /** Rest breaks taken inside the period: not working time, not a rest period. */
  readonly breaks?: readonly TimeSpan[];
  /** Required when `kind` is `sleep_in`. */
  readonly sleepIn?: SleepInDetail;
  /** Parts of one duty share an id (a split shift); gaps between them can be its rest break. */
  readonly dutyId?: string;
  /** Hours for another employer, declared by a young worker (reg 5A(2), 12(5)). Default `this`. */
  readonly employer?: "this" | "other";
  /** Occasional overtime is not part of a night worker's normal hours (reg 6(5)). */
  readonly occasionalOvertime?: boolean;
  readonly youngWorkerException?: YoungWorkerException;
}

/** Leave whose days are excluded from the 48-hour average (reg 4(7)); other absence is not. */
export type ExcludedDayReason =
  /** Statutory annual leave only (reg 13, 13A or 15B), never extra contractual leave. */
  | "annual_leave"
  | "sick_leave"
  | "maternity_leave"
  | "paternity_leave"
  | "adoption_leave"
  | "parental_leave";

export interface ExcludedDay {
  /** ISO date (UK). */
  readonly date: string;
  readonly reason: ExcludedDayReason;
}

/** A worker's written agreement that the 48-hour limit does not apply (reg 4(1), 5). */
export interface OptOutAgreement {
  /** ISO date the agreement was signed; in force from that day. */
  readonly signedOn: string;
  /** Last day in force for an agreement for a specified period (reg 5(2)(a)); null: indefinite. */
  readonly endsOn: string | null;
  /** The agreement's own notice period for ending it (reg 5(2)(b), (3)); null: the default. */
  readonly noticePeriod: { readonly amount: number; readonly unit: "days" | "months" } | null;
  /** ISO date the worker gave written notice to end it; null while none is given. */
  readonly noticeGivenOn: string | null;
}

/** Night time as minutes after UK midnight (reg 2). */
export interface NightTime {
  readonly startMinute: number;
  readonly endMinute: number;
}

/** The grounds on which an employer may depart from an adult rest, break or night limit. */
export type AdultDerogationBasis =
  /** Reg 21(c): activities needing continuity of service, such as care in residential institutions. */
  | "special_case"
  /** Reg 23(a): a collective or workforce agreement that modifies or excludes the limit. */
  | "relevant_agreement"
  /** Reg 22(1)(a), (b): a shift worker changing shift. */
  | "shift_change"
  /** Reg 22(1)(c): work split up over the day. */
  | "split_shift";

export interface WorkingTimeWorker {
  /** ISO date of birth: the young worker rules apply until the age in the rate table. */
  readonly dateOfBirth: string;
  /** ISO date the worker started work for this employer (short-service reference periods). */
  readonly employmentStart: string;
  readonly optOuts: readonly OptOutAgreement[];
  /** A night worker by contract or agreement (reg 2(b)), whatever the pattern shows. */
  readonly designatedNightWorker: boolean;
  /** Night work with special hazards or heavy physical or mental strain (reg 6(7), (8)). */
  readonly specialHazards: boolean;
  /** The contract provides for work after 22:00, so a young worker's restricted period moves. */
  readonly contractProvidesWorkAfter22: boolean;
}

/** The employer's arrangements for a worker, from the tenant's working-time setting. */
export interface WorkingTimeSetting {
  readonly derogations: readonly AdultDerogationBasis[];
  /** Reg 4(3)(a), 6(3)(a): successive reference periods from this ISO date; null: rolling. */
  readonly successiveReferencePeriodsFrom: string | null;
  /** Reg 23(b): weeks a collective or workforce agreement sets for the 48-hour average. */
  readonly agreedReferencePeriodWeeks: number | null;
  /** Reg 23(a): weeks a collective or workforce agreement sets for the night average. */
  readonly agreedNightReferencePeriodWeeks: number | null;
  /** Reg 2: night time set by a relevant agreement; null: the default night time. */
  readonly agreedNightTime: NightTime | null;
  /** Reg 11(2): the employer's choice of weekly rest basis. */
  readonly weeklyRestBasis: "each_week" | "each_fortnight";
  /** Reg 11(4)(a): an ISO date a relevant agreement sets for weekly rest periods to start. */
  readonly weeklyRestPeriodsFrom: string | null;
  /** Reg 11(7): objective, technical or work-organisation reasons let weekly rest include daily rest. */
  readonly weeklyRestMayIncludeDailyRest: boolean;
  /** Reg 27A(2)(a): the young worker is employed in a hospital or similar establishment. */
  readonly hospitalOrSimilarEstablishment: boolean;
}

export type WorkingTimeRule =
  | "weekly_average"
  | "daily_rest"
  | "weekly_rest"
  | "rest_break"
  | "night_average"
  | "night_hazard"
  | "young_daily_max"
  | "young_weekly_max"
  | "young_daily_rest"
  | "young_weekly_rest"
  | "young_rest_break"
  | "young_restricted_period";

/** The regulation each rule applies, shown with every finding. */
export const WORKING_TIME_CITATIONS: Readonly<Record<WorkingTimeRule, string>> = {
  weekly_average: "Working Time Regulations 1998, regulation 4",
  daily_rest: "Working Time Regulations 1998, regulation 10(1)",
  weekly_rest: "Working Time Regulations 1998, regulation 11(1), (2) and (7)",
  rest_break: "Working Time Regulations 1998, regulation 12(1) and (3)",
  night_average: "Working Time Regulations 1998, regulation 6(1) and (5)",
  night_hazard: "Working Time Regulations 1998, regulation 6(7)",
  young_daily_max: "Working Time Regulations 1998, regulation 5A",
  young_weekly_max: "Working Time Regulations 1998, regulation 5A",
  young_daily_rest: "Working Time Regulations 1998, regulation 10(2) and (3)",
  young_weekly_rest: "Working Time Regulations 1998, regulation 11(3) and (8)",
  young_rest_break: "Working Time Regulations 1998, regulation 12(4) and (5)",
  young_restricted_period: "Working Time Regulations 1998, regulations 6A and 27A",
};

/**
 * Which adult limits each derogation lets an employer depart from, subject to compensatory rest
 * or other protection (reg 24). The 48-hour average is never in the list: only a worker's own
 * opt-out lifts it. No derogation touches a young worker's limits (reg 27A has its own rules).
 */
export const ADULT_DEROGATIONS: Readonly<Record<AdultDerogationBasis, readonly WorkingTimeRule[]>> =
  {
    special_case: ["daily_rest", "weekly_rest", "rest_break", "night_average", "night_hazard"],
    relevant_agreement: [
      "daily_rest",
      "weekly_rest",
      "rest_break",
      "night_average",
      "night_hazard",
    ],
    shift_change: ["daily_rest", "weekly_rest"],
    split_shift: ["daily_rest", "weekly_rest"],
  };

/**
 * `breach`: a limit is exceeded and nothing recorded allows it. `conditional`: the law allows it
 * only with the conditions listed, which the manager confirms (compensatory rest owed, adult
 * supervision, protection for health and safety, or a recorded reason).
 */
export type WorkingTimeOutcome = "breach" | "conditional";

export type WorkingTimeCondition =
  | "compensatory_rest"
  | "health_and_safety_protection"
  | "adult_supervision"
  | "reason_recorded";

export interface WorkingTimeFinding {
  readonly rule: WorkingTimeRule;
  readonly citation: string;
  readonly outcome: WorkingTimeOutcome;
  readonly conditions: readonly WorkingTimeCondition[];
  /** The derogation or exception relied on; null for a breach. */
  readonly basis: AdultDerogationBasis | YoungWorkerException["basis"] | null;
  readonly from: Date;
  readonly to: Date;
  /** The figure in minutes: a limit, or a minimum for rest and breaks. */
  readonly limitMinutes: number;
  /** What happened, in minutes (an average for the average rules). */
  readonly actualMinutes: number;
  /** Equivalent compensatory rest owed, in minutes (0 when none is owed). */
  readonly compensatoryRestMinutes: number;
  readonly periodIds: readonly string[];
}

/** The first derogation in force that covers a rule, or null. */
export function derogationFor(
  rule: WorkingTimeRule,
  derogations: readonly AdultDerogationBasis[],
): AdultDerogationBasis | null {
  return derogations.find((basis) => ADULT_DEROGATIONS[basis].includes(rule)) ?? null;
}
