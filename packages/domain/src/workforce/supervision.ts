import { addDays, addMonths } from "./dates";

/**
 * Supervision and appraisal (workforce.md rule 7; WORK-009). `supervision.per_year` supervisions
 * and `appraisal.per_year` appraisals a year: the next falls due one interval (12 months divided by
 * the number, in whole months, at least one) after the last held, or after the start date when none
 * has been held; overdue from the day after it falls due. Spot checks are recorded but never count
 * as a supervision.
 */

export interface SupervisionRecord {
  readonly kind: "supervision" | "appraisal" | "spot_check";
  readonly heldOn: string;
}

export interface NextMeeting {
  readonly kind: "supervision" | "appraisal";
  readonly dueOn: string;
  readonly state: "upcoming" | "due" | "overdue";
}

const MONTHS_IN_YEAR = 12; // calendar fact, not a statutory figure

export function intervalMonths(perYear: number): number {
  if (!(perYear > 0)) throw new RangeError("The number a year must be more than zero.");
  return Math.max(1, Math.floor(MONTHS_IN_YEAR / perYear));
}

export function nextMeeting(
  kind: "supervision" | "appraisal",
  records: readonly SupervisionRecord[],
  startedOn: string,
  perYear: number,
  today: string,
  dueWindowDays = 0,
): NextMeeting {
  const last = records
    .filter((r) => r.kind === kind && r.heldOn <= today)
    .map((r) => r.heldOn)
    .sort()
    .at(-1);
  const dueOn = addMonths(last ?? startedOn, intervalMonths(perYear));
  const state =
    today > dueOn ? "overdue" : addDays(today, dueWindowDays) >= dueOn ? "due" : "upcoming";
  return { kind, dueOn, state };
}
