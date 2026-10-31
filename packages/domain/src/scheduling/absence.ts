import { type RateNation, RateNotFoundError, type RateRow, resolveRate } from "../platform/rates";
import { DAYS_PER_WEEK, daysFrom, plusDays } from "./intervals";

/**
 * Absence and leave (scheduling.md section 15; SCHED-010; hazards HZ-123, HZ-124): requests and
 * decisions, self-certification and fit notes, periods of incapacity for SSP, and which rostered
 * shifts an absence leaves needing cover. Pure; every statutory figure comes from the rate table.
 * Nothing here holds or judges anyone's health: the kind of absence and its dates only.
 */

export const ABSENCE_KINDS = [
  "annual_leave",
  "sickness",
  "compassionate",
  "carers_leave",
  "parental_leave",
  "maternity",
  "paternity",
  "adoption",
  "parental_bereavement",
  "unpaid",
  "other",
] as const;
export type AbsenceKind = (typeof ABSENCE_KINDS)[number];

/**
 * Statutory leave, never declined (H-970, recommended answer applied 31/10/2026): maternity,
 * paternity, adoption and parental bereavement leave are notified and recorded; carer's leave
 * (Carer's Leave Regulations 2024) and unpaid parental leave may only be postponed as the law
 * allows. Compassionate leave stays the organisation's own policy until bereavement leave under
 * the Employment Rights Act 2025 commences.
 */
export const STATUTORY_LEAVE_KINDS: readonly AbsenceKind[] = [
  "maternity",
  "paternity",
  "adoption",
  "parental_bereavement",
  "carers_leave",
  "parental_leave",
];
/** The statutory kinds an employer may postpone (never decline). */
export const POSTPONABLE_KINDS: readonly AbsenceKind[] = ["carers_leave", "parental_leave"];

/** Kinds a member asks for (sickness is recorded, never requested). */
export const REQUESTABLE_KINDS: readonly AbsenceKind[] = ABSENCE_KINDS.filter(
  (k) => k !== "sickness",
);

export const ABSENCE_STATES = [
  "requested",
  "approved",
  "declined",
  "postponed",
  "cancelled",
  "recorded",
] as const;
export type AbsenceState = (typeof ABSENCE_STATES)[number];

/** States in which the member is away: the absence touches the rota. */
export const AWAY_STATES: readonly AbsenceState[] = ["approved", "recorded"];

/** Where an absence may move (rule 1); nothing moves back. */
const MOVES: Readonly<Record<AbsenceState, readonly AbsenceState[]>> = {
  requested: ["approved", "declined", "postponed", "cancelled"],
  approved: ["cancelled"],
  recorded: ["cancelled"],
  declined: [],
  postponed: [],
  cancelled: [],
};

export type AbsenceProblem =
  | "decider_is_member"
  | "wrong_state"
  | "reason_required"
  | "ends_before_start"
  | "sickness_not_requested"
  | "leave_needs_end"
  | "not_declinable"
  | "not_postponable";

/** Whether a state change is allowed, and by whom (rule 1). */
export function checkAbsenceMove(input: {
  readonly from: AbsenceState;
  readonly to: AbsenceState;
  readonly memberId: string;
  readonly actorId: string;
  readonly reason: string | null;
  /** The kind of absence; statutory leave is never declined (H-970). */
  readonly kind?: AbsenceKind;
}): AbsenceProblem | null {
  if (!MOVES[input.from].includes(input.to)) return "wrong_state";
  if (input.to === "declined" && input.kind && STATUTORY_LEAVE_KINDS.includes(input.kind)) {
    return "not_declinable";
  }
  if (input.to === "postponed" && !(input.kind && POSTPONABLE_KINDS.includes(input.kind))) {
    return "not_postponable";
  }
  const decides = input.to === "approved" || input.to === "declined" || input.to === "postponed";
  if (decides && input.actorId === input.memberId) {
    return "decider_is_member";
  }
  const needsReason =
    input.to === "declined" ||
    input.to === "postponed" ||
    (input.to === "cancelled" && input.from !== "requested");
  if (needsReason && !input.reason?.trim()) return "reason_required";
  return null;
}

/** Whether a new absence's shape is allowed (rules 1 and 2). */
export function checkNewAbsence(input: {
  readonly kind: AbsenceKind;
  readonly startsOn: string;
  readonly endsOn: string | null;
  readonly requested: boolean;
}): AbsenceProblem | null {
  if (input.requested && input.kind === "sickness") return "sickness_not_requested";
  if (input.kind !== "sickness" && input.endsOn === null) return "leave_needs_end";
  if (input.endsOn !== null && input.endsOn < input.startsOn) return "ends_before_start";
  return null;
}

/** Every UK date an absence covers, up to `today` while it is open. */
export function absenceDays(startsOn: string, endsOn: string | null, today: string): string[] {
  const last = endsOn ?? (today < startsOn ? startsOn : today);
  const days: string[] = [];
  for (let d = startsOn; d <= last; d = plusDays(d, 1)) days.push(d);
  return days;
}

export interface AbsenceRates {
  /** Carer's leave a member may take in any 12 months, in weeks (`carers_leave.weeks_per_12_months`). */
  readonly carersLeaveWeeks: number | null;
  /** Days of sickness the member's own statement covers (`ssp.self_certification_days`). */
  readonly selfCertificationDays: number | null;
  /** The shortest period of incapacity for work (`ssp.piw_min_days`). */
  readonly piwMinDays: number | null;
  /** Periods no further apart than this link (`ssp.piw_link_weeks`). */
  readonly piwLinkWeeks: number | null;
}

export const ABSENCE_RATE_KEYS = {
  carersLeaveWeeks: "carers_leave.weeks_per_12_months",
  selfCertificationDays: "ssp.self_certification_days",
  piwMinDays: "ssp.piw_min_days",
  piwLinkWeeks: "ssp.piw_link_weeks",
} as const;

/** The absence figures in force; null where the nation has no rows (Great Britain only). */
export function resolveAbsenceRates(
  rows: readonly RateRow[],
  nation: Exclude<RateNation, "uk" | "all">,
  on: string,
  tenantId: string | null,
): AbsenceRates {
  const read = (key: string): number | null => {
    try {
      return Number(resolveRate(rows, key, nation, on, tenantId).value);
    } catch (error) {
      if (error instanceof RateNotFoundError) return null;
      throw error;
    }
  };
  return {
    carersLeaveWeeks: read(ABSENCE_RATE_KEYS.carersLeaveWeeks),
    selfCertificationDays: read(ABSENCE_RATE_KEYS.selfCertificationDays),
    piwMinDays: read(ABSENCE_RATE_KEYS.piwMinDays),
    piwLinkWeeks: read(ABSENCE_RATE_KEYS.piwLinkWeeks),
  };
}

export interface FitNoteCover {
  readonly coversFrom: string;
  readonly coversTo: string;
}

export type FitNoteNeed =
  | { readonly needed: false; readonly reason: "within_self_certification" | "no_rate_for_nation" }
  | {
      readonly needed: true;
      /** The days after the self-certification days that no fit note covers. */
      readonly uncoveredDays: readonly string[];
    };

/**
 * Whether a sickness needs a fit note (rule 3): the member's own statement covers the first
 * `ssp.self_certification_days` calendar days; every day after needs a fit note covering it.
 */
export function fitNoteNeeded(
  startsOn: string,
  endsOn: string | null,
  today: string,
  notes: readonly FitNoteCover[],
  rates: Pick<AbsenceRates, "selfCertificationDays">,
): FitNoteNeed {
  if (rates.selfCertificationDays === null) return { needed: false, reason: "no_rate_for_nation" };
  const days = absenceDays(startsOn, endsOn, today);
  const after = days.slice(rates.selfCertificationDays);
  if (after.length === 0) return { needed: false, reason: "within_self_certification" };
  const uncoveredDays = after.filter(
    (d) => !notes.some((n) => n.coversFrom <= d && d <= n.coversTo),
  );
  return { needed: true, uncoveredDays };
}

export interface SicknessSpell {
  readonly id: string;
  readonly startsOn: string;
  /** The last day of sickness, or null while it is open (counted to `today`). */
  readonly endsOn: string | null;
}

export interface PeriodOfIncapacity {
  readonly startsOn: string;
  readonly endsOn: string;
  /** The spells that make it up, linked where they are close enough. */
  readonly spellIds: readonly string[];
  /** Calendar days of sickness in it. */
  readonly days: readonly string[];
}

/**
 * Periods of incapacity for work (rule 6; SSCBA 1992 s 152): a spell of at least
 * `ssp.piw_min_days` consecutive calendar days is one; two no more than `ssp.piw_link_weeks` weeks
 * apart (from the end of one to the start of the next) are treated as one, so SSP already paid in
 * the first counts towards the limit in the second. Shorter spells are not periods at all.
 */
export function periodsOfIncapacity(
  spells: readonly SicknessSpell[],
  today: string,
  rates: Pick<AbsenceRates, "piwMinDays" | "piwLinkWeeks">,
): PeriodOfIncapacity[] | null {
  if (rates.piwMinDays === null || rates.piwLinkWeeks === null) return null;
  const long = spells
    .map((s) => ({ s, days: absenceDays(s.startsOn, s.endsOn, today) }))
    .filter(({ days }) => days.length >= (rates.piwMinDays as number))
    .sort((a, b) => a.s.startsOn.localeCompare(b.s.startsOn) || a.s.id.localeCompare(b.s.id));
  const linkDays = rates.piwLinkWeeks * DAYS_PER_WEEK;
  const out: { startsOn: string; endsOn: string; spellIds: string[]; days: string[] }[] = [];
  for (const { s, days } of long) {
    const last = out.at(-1);
    const end = days.at(-1) as string;
    // "Not separated by more than eight weeks": the gap between the two periods' days.
    if (last && daysFrom(last.endsOn, s.startsOn) - 1 <= linkDays) {
      last.spellIds.push(s.id);
      last.days.push(...days.filter((d) => !last.days.includes(d)));
      if (end > last.endsOn) last.endsOn = end;
    } else {
      out.push({ startsOn: s.startsOn, endsOn: end, spellIds: [s.id], days: [...days] });
    }
  }
  return out;
}

/** The qualifying days (the days of the week the member normally works) among some dates. */
export function qualifyingDaysIn(
  days: readonly string[],
  /** ISO weekday numbers, Monday 1 to Sunday the last. */
  qualifyingWeekdays: ReadonlySet<number>,
): string[] {
  return days.filter((d) => {
    // getUTCDay is 0 for Sunday; ISO counts Sunday as the last day of the week.
    const weekday = new Date(`${d}T12:00:00Z`).getUTCDay() || DAYS_PER_WEEK;
    return qualifyingWeekdays.has(weekday);
  });
}

export interface RosteredShiftForCover {
  readonly assignmentId: string;
  readonly shiftId: string;
  readonly workerId: string;
  /** The UK dates the shift touches (a night touches two). */
  readonly dates: readonly string[];
}

/**
 * The assignments an absence leaves needing cover (rule 7; HZ-123): the member's own, on any shift
 * touching a day of the absence. They are flagged, never removed, so the rota never silently loses
 * a shift's worker.
 */
export function assignmentsNeedingCover(
  absence: { readonly memberId: string; readonly startsOn: string; readonly endsOn: string | null },
  assignments: readonly RosteredShiftForCover[],
): RosteredShiftForCover[] {
  const last = absence.endsOn;
  return assignments.filter(
    (a) =>
      a.workerId === absence.memberId &&
      a.dates.some(
        (d) => d >= absence.startsOn && (last === null ? d >= absence.startsOn : d <= last),
      ),
  );
}

/** Whether a member is away on any of a shift's dates (rule 8; HZ-124). */
export function absentOn(
  absences: readonly {
    readonly state: AbsenceState;
    readonly startsOn: string;
    readonly endsOn: string | null;
  }[],
  dates: readonly string[],
): boolean {
  return absences.some(
    (a) =>
      AWAY_STATES.includes(a.state) &&
      dates.some((d) => d >= a.startsOn && (a.endsOn === null || d <= a.endsOn)),
  );
}

/** Sickness days for the Bradford factor (rule 5): away, not cancelled, not excluded. */
export function bradfordDays(
  absences: readonly {
    readonly kind: AbsenceKind;
    readonly state: AbsenceState;
    readonly startsOn: string;
    readonly endsOn: string | null;
    readonly excluded: boolean;
  }[],
  today: string,
): string[] {
  return [
    ...new Set(
      absences
        .filter((a) => a.kind === "sickness" && AWAY_STATES.includes(a.state) && !a.excluded)
        .flatMap((a) => absenceDays(a.startsOn, a.endsOn, today)),
    ),
  ].sort();
}

/** The same calendar date a year earlier (29 February becomes 1 March). */
function sameDayLastYear(isoDate: string): string {
  const cut = isoDate.indexOf("-");
  const monthDay = isoDate.slice(cut);
  const year = String(Number(isoDate.slice(0, cut)) - 1);
  const leap = new Date(`${year}${monthDay}T12:00:00Z`);
  return Number.isNaN(leap.getTime()) ||
    leap.toISOString().slice(cut) !== `${monthDay}T12:00:00.000Z`
    ? plusDays(`${year}-02-28`, 1)
    : `${year}${monthDay}`;
}

export interface CarersLeaveTaken {
  /** Days of carer's leave approved or recorded in the 12 months up to and including `today`. */
  readonly takenDays: number;
  /** The days the rate table allows in any 12 months, or null where the nation has no row. */
  readonly allowanceDays: number | null;
  /** Advisory only: never refuses a request (the law sets the entitlement, H-970). */
  readonly overAllowance: boolean;
}

/**
 * Carer's leave taken in any 12 months against the rate table's allowance (H-970; Carer's Leave
 * Regulations 2024, to verify): an advisory count for the approver, from the calendar days of
 * approved or recorded carer's leave whose days fall in the 12 months ending `today`. A week of
 * leave is counted as seven calendar days; the regulations count it in the member's working week,
 * which the approver checks.
 */
export function carersLeaveTaken(
  absences: readonly {
    readonly kind: AbsenceKind;
    readonly state: AbsenceState;
    readonly startsOn: string;
    readonly endsOn: string | null;
  }[],
  today: string,
  rates: Pick<AbsenceRates, "carersLeaveWeeks">,
): CarersLeaveTaken {
  const yearAgo = plusDays(sameDayLastYear(today), 1);
  const days = new Set(
    absences
      .filter((a) => a.kind === "carers_leave" && AWAY_STATES.includes(a.state))
      .flatMap((a) => absenceDays(a.startsOn, a.endsOn, today))
      .filter((d) => d >= yearAgo && d <= today),
  );
  const allowanceDays =
    rates.carersLeaveWeeks === null ? null : rates.carersLeaveWeeks * DAYS_PER_WEEK;
  return {
    takenDays: days.size,
    allowanceDays,
    overAllowance: allowanceDays !== null && days.size > allowanceDays,
  };
}
