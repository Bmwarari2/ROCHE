import type { StaffingProvided, StaffingSkill } from "./dependency";
import { STAFFING_SKILLS } from "./dependency";
import {
  atMinuteOfDay,
  clip,
  DAYS_PER_WEEK,
  datesFrom,
  daysFrom,
  MINUTES_PER_DAY,
  minutesBetween,
  plusDays,
  plusMinutes,
  type Span,
  spanMinutes,
  ukDays,
} from "./intervals";
import type { WorkPeriod } from "./working-time-types";

/**
 * The rota builder's rules (scheduling.md section 14; SCHED-001, SCHED-002; hazards HZ-123 and
 * HZ-124). Shift templates and patterns make shifts; a shift is one position for one worker; the
 * rota's care minutes and skill mix on each dependency period are what `compareStaffing` (slice 12)
 * compares with the organisation's own requirement; the planned periods are what
 * `checkWorkingTime` (slice 5) reads. Everything here advises except the rostering rule, which the
 * workforce module owns (`rosterDecision`). No figure in this file is a literal: the product limits
 * on lengths live in the API contract, statutory figures in the rate table.
 */

export const SHIFT_KINDS = [
  "work",
  "sleep_in",
  "on_call_at_workplace",
  "on_call_away",
  "training",
] as const;
export type ShiftKind = (typeof SHIFT_KINDS)[number];

/** Only these give care on the floor; a sleep-in or on-call is presence, not care minutes. */
export const CARE_SHIFT_KINDS: ReadonlySet<ShiftKind> = new Set(["work"]);

export interface ShiftShape {
  readonly kind: ShiftKind;
  /** UK wall-clock minute the shift starts, after midnight. */
  readonly startMinute: number;
  /** UK wall-clock minute it ends; at or before the start means the next day. */
  readonly endMinute: number;
  readonly breakMinutes: number;
  readonly requiredCompetences: readonly string[];
  readonly requiredSkills: readonly string[];
}

export type ShiftShapeProblem =
  | "start_out_of_day"
  | "end_out_of_day"
  | "break_not_whole"
  | "break_too_long"
  | "unknown_competence"
  | "unknown_skill"
  | "duplicate_requirement";

export const SHIFT_SHAPE_MESSAGES: Readonly<Record<ShiftShapeProblem, string>> = {
  start_out_of_day: "Give a start time between 00:00 and 23:59.",
  end_out_of_day: "Give an end time between 00:00 and 23:59.",
  break_not_whole: "Give the break in whole minutes, 0 or more.",
  break_too_long: "The break must be shorter than the shift.",
  unknown_competence: "One of the competences is not one your organisation signs off.",
  unknown_skill: "One of the skills is not one the dependency scale uses.",
  duplicate_requirement: "Each competence and skill is listed once.",
};

const inDay = (minute: number) =>
  Number.isInteger(minute) && minute >= 0 && minute < MINUTES_PER_DAY;

/** The shift's length in wall-clock minutes (a clock change moves the real length; see `shiftTimes`). */
export function wallClockMinutes(startMinute: number, endMinute: number): number {
  return endMinute > startMinute
    ? endMinute - startMinute
    : endMinute + MINUTES_PER_DAY - startMinute;
}

export function checkShiftShape(
  shape: ShiftShape,
  knownCompetences: readonly string[],
): ShiftShapeProblem[] {
  const problems: ShiftShapeProblem[] = [];
  if (!inDay(shape.startMinute)) problems.push("start_out_of_day");
  if (!inDay(shape.endMinute)) problems.push("end_out_of_day");
  if (!Number.isInteger(shape.breakMinutes) || shape.breakMinutes < 0) {
    problems.push("break_not_whole");
  } else if (
    inDay(shape.startMinute) &&
    inDay(shape.endMinute) &&
    shape.breakMinutes >= wallClockMinutes(shape.startMinute, shape.endMinute)
  ) {
    problems.push("break_too_long");
  }
  if (shape.requiredCompetences.some((c) => !knownCompetences.includes(c))) {
    problems.push("unknown_competence");
  }
  if (shape.requiredSkills.some((s) => !(STAFFING_SKILLS as readonly string[]).includes(s))) {
    problems.push("unknown_skill");
  }
  const all = [...shape.requiredCompetences, ...shape.requiredSkills];
  if (new Set(all).size !== all.length) problems.push("duplicate_requirement");
  return problems;
}

/**
 * The instants a shift on a UK date runs: its wall-clock start that day to its wall-clock end, the
 * next day when the end is at or before the start. A night across a clock change is an hour longer
 * or shorter in elapsed time, which the working time check and the care minutes use.
 */
export function shiftTimes(isoDate: string, startMinute: number, endMinute: number): Span {
  const start = atMinuteOfDay(isoDate, startMinute);
  const endDate = endMinute > startMinute ? isoDate : plusDays(isoDate, 1);
  return { start, end: atMinuteOfDay(endDate, endMinute) };
}

// ---------------------------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------------------------

export interface PatternEntry {
  /** Day of the cycle, from 0. */
  readonly day: number;
  readonly templateId: string;
  /** How many positions of the template on that day. */
  readonly count: number;
}

export type PatternProblem =
  | "cycle_not_whole"
  | "no_entries"
  | "day_outside_cycle"
  | "count_not_whole"
  | "unknown_template";

export const PATTERN_MESSAGES: Readonly<Record<PatternProblem, string>> = {
  cycle_not_whole: "Give the cycle as a whole number of days, 1 or more.",
  no_entries: "Add at least one shift to the pattern.",
  day_outside_cycle: "Each shift must fall on a day of the cycle.",
  count_not_whole: "Give how many of each shift as a whole number, 1 or more.",
  unknown_template: "One of the shifts is not a live template at this location.",
};

export function checkPattern(
  cycleDays: number,
  entries: readonly PatternEntry[],
  liveTemplateIds: readonly string[],
): PatternProblem[] {
  const problems = new Set<PatternProblem>();
  if (!Number.isInteger(cycleDays) || cycleDays < 1) problems.add("cycle_not_whole");
  if (entries.length === 0) problems.add("no_entries");
  for (const e of entries) {
    if (!Number.isInteger(e.day) || e.day < 0 || e.day >= cycleDays) {
      problems.add("day_outside_cycle");
    }
    if (!Number.isInteger(e.count) || e.count < 1) problems.add("count_not_whole");
    if (!liveTemplateIds.includes(e.templateId)) problems.add("unknown_template");
  }
  return [...problems];
}

/**
 * The shifts a pattern makes on the dates from `from` to `to`: the cycle runs from `anchor` (day 0),
 * so applying the same pattern to the next rota carries on where the last one ended.
 */
export function patternShifts(
  cycleDays: number,
  entries: readonly PatternEntry[],
  anchor: string,
  from: string,
  to: string,
): { readonly date: string; readonly templateId: string }[] {
  const out: { date: string; templateId: string }[] = [];
  for (const date of datesFrom(from, to)) {
    const day = (((daysFrom(anchor, date) % cycleDays) + cycleDays) % cycleDays) as number;
    for (const e of entries.filter((x) => x.day === day)) {
      for (let i = 0; i < e.count; i++) out.push({ date, templateId: e.templateId });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The rota against the dependency requirement (HZ-123)
// ---------------------------------------------------------------------------------------------

export interface RosteredShift {
  readonly id: string;
  readonly kind: ShiftKind;
  readonly start: Date;
  readonly end: Date;
  readonly breakMinutes: number;
  /**
   * The organisation counts this shift as care on the floor (a care shift, not housekeeping, the
   * kitchen, the office or a supernumerary manager; clinical safety review round 1, C2).
   */
  readonly countsAsCare: boolean;
  /** The assigned worker, or null for an open shift. */
  readonly workerId: string | null;
  /** The skills the assigned worker holds on the shift's day, from the workforce port. */
  readonly workerSkills: readonly StaffingSkill[];
}

export interface StaffingProvidedWithMethod extends StaffingProvided {
  /** Assigned care shifts that overlap the period. */
  readonly shiftIds: readonly string[];
  /** Open care shifts that overlap the period: not counted. */
  readonly openShiftIds: readonly string[];
  /** Assigned shifts in the period the organisation does not count as care. */
  readonly notCareShiftIds: readonly string[];
  readonly method: readonly string[];
}

/**
 * The fewest distinct holders present at any moment of the window (0 when any moment has none):
 * a skill minimum is met only if it is met throughout, so a 15-minute handover overlap or two
 * holders one after the other never count as two (clinical safety review round 1, C1).
 */
export function fewestPresent(
  spans: readonly { readonly start: Date; readonly end: Date; readonly holder: string }[],
  window: Span,
): number {
  const inside = spans
    .map((s) => ({ part: clip(s, window), holder: s.holder }))
    .filter((s): s is { part: Span; holder: string } => s.part !== null);
  const cuts = new Set<number>([window.start.getTime(), window.end.getTime()]);
  for (const s of inside) {
    cuts.add(s.part.start.getTime());
    cuts.add(s.part.end.getTime());
  }
  const points = [...cuts].sort((x, y) => x - y);
  let fewest = Number.POSITIVE_INFINITY;
  for (let i = 0; i + 1 < points.length; i++) {
    const at = points[i] as number;
    const present = new Set(
      inside
        .filter((s) => s.part.start.getTime() <= at && s.part.end.getTime() > at)
        .map((s) => s.holder),
    );
    fewest = Math.min(fewest, present.size);
  }
  return Number.isFinite(fewest) ? fewest : 0;
}

/**
 * What the rota gives on one dependency period: the care minutes of assigned `work` shifts the
 * organisation counts as care, inside the period, less each shift's planned break in proportion to
 * the part inside; and for each skill the fewest assigned holders on those shifts present at any
 * moment of the period. Open shifts, shifts not counted as care, sleep-ins and on-call give nothing
 * (they are listed). No figure is rounded; the comparison formats it.
 */
export function staffingProvided(
  shifts: readonly RosteredShift[],
  window: Span,
): StaffingProvidedWithMethod {
  let careMinutes = 0;
  const shiftIds: string[] = [];
  const openShiftIds: string[] = [];
  const notCareShiftIds: string[] = [];
  const holderSpans = new Map<StaffingSkill, { start: Date; end: Date; holder: string }[]>();
  for (const shift of shifts) {
    if (!CARE_SHIFT_KINDS.has(shift.kind)) continue;
    const inside = clip({ start: shift.start, end: shift.end }, window);
    if (!inside) continue;
    if (!shift.countsAsCare) {
      if (shift.workerId !== null) notCareShiftIds.push(shift.id);
      continue;
    }
    if (shift.workerId === null) {
      openShiftIds.push(shift.id);
      continue;
    }
    const length = minutesBetween(shift.start, shift.end);
    const part = spanMinutes(inside);
    careMinutes += length > 0 ? part - (shift.breakMinutes * part) / length : 0;
    shiftIds.push(shift.id);
    for (const skill of shift.workerSkills) {
      const list = holderSpans.get(skill) ?? [];
      list.push({ start: shift.start, end: shift.end, holder: shift.workerId });
      holderSpans.set(skill, list);
    }
  }
  const staffWithSkill: Partial<Record<StaffingSkill, number>> = {};
  for (const skill of STAFFING_SKILLS) {
    staffWithSkill[skill] = fewestPresent(holderSpans.get(skill) ?? [], window);
  }
  const method = [
    "The rota's care minutes are the assigned care shifts inside the period, less each shift's planned break in proportion to the part inside it.",
    "Shifts your organisation does not count as care, sleep-ins, on-call and training are not counted. Open shifts are not counted until someone is assigned.",
    "Staff with a skill are the fewest holders on shift at any moment of the period, so a skill is met only if it is covered throughout. A member counts for a skill when the workforce records show they hold it on the day.",
  ];
  return { careMinutes, staffWithSkill, shiftIds, openShiftIds, notCareShiftIds, method };
}

// ---------------------------------------------------------------------------------------------
// The working time check's input from the rota
// ---------------------------------------------------------------------------------------------

export interface PlannedShift {
  readonly id: string;
  readonly kind: ShiftKind;
  readonly start: Date;
  readonly end: Date;
  readonly breakMinutes: number;
}

/**
 * The planned periods of one worker, as the working time check reads them. A planned break has no
 * time until time and attendance (slice 30) records it, so it is placed in the middle of the shift;
 * the rota says so beside every finding.
 */
export function plannedWorkPeriods(shifts: readonly PlannedShift[]): WorkPeriod[] {
  return shifts.map((s) => {
    const length = minutesBetween(s.start, s.end);
    if (s.breakMinutes <= 0 || s.breakMinutes >= length) {
      return { id: s.id, kind: s.kind, start: s.start, end: s.end };
    }
    const breakStart = plusMinutes(s.start, (length - s.breakMinutes) / 2);
    return {
      id: s.id,
      kind: s.kind,
      start: s.start,
      end: s.end,
      breaks: [{ start: breakStart, end: plusMinutes(breakStart, s.breakMinutes) }],
    };
  });
}

/** Whole minutes of notice a publication gave before the first shift it published (never below 0). */
export function noticeMinutes(publishedAt: Date, firstShiftStart: Date | null): number | null {
  if (!firstShiftStart) return null;
  return Math.max(0, Math.floor(minutesBetween(publishedAt, firstShiftStart)));
}

/** Two spans overlap (a worker cannot be on two shifts at once). */
export function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Every UK date a rota covers, in order. */
export function rotaDates(startsOn: string, endsOn: string): string[] {
  return datesFrom(startsOn, endsOn);
}

/**
 * The instants the working time check reads shifts from for a rota: the longest reference period
 * before its first date (`lookBackWeeks`, from the rate table) to the end of the day after its last
 * (a night shift ends then). Only the rota's own days count as known: hours before it come from
 * earlier rotas and are planned, not recorded.
 */
export function workingTimeWindow(
  startsOn: string,
  endsOn: string,
  lookBackWeeks: number,
): { readonly from: Date; readonly to: Date; readonly known: Span } {
  return {
    from: ukDays(plusDays(startsOn, -lookBackWeeks * DAYS_PER_WEEK), startsOn).start,
    to: ukDays(endsOn, plusDays(endsOn, 1)).end,
    known: ukDays(startsOn, endsOn),
  };
}
