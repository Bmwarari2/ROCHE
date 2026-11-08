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

/** One member's supervision or appraisal, as the training screens list it across staff. */
export interface MeetingDue {
  readonly kind: "supervision" | "appraisal";
  /** The last one held on or before today, or null when none is recorded. */
  readonly lastHeldOn: string | null;
  /** When the next falls due, or null when none is recorded and the start date is not known. */
  readonly dueOn: string | null;
  readonly state: NextMeeting["state"] | "none_recorded";
}

/**
 * Each member's next supervision and appraisal (rule 7; WORK-009), with `supervision.due_window_days`
 * as the window in which one shows as due. With none held, the next is due from the start date when
 * the caller may know it; otherwise it is `none_recorded`, never a guessed date.
 */
export function meetingsDue(
  records: readonly SupervisionRecord[],
  perYear: { readonly supervision: number; readonly appraisal: number },
  today: string,
  dueWindowDays: number,
  startedOn: string | null = null,
): readonly [MeetingDue, MeetingDue] {
  const one = (kind: "supervision" | "appraisal"): MeetingDue => {
    const lastHeldOn =
      records
        .filter((r) => r.kind === kind && r.heldOn <= today)
        .map((r) => r.heldOn)
        .sort()
        .at(-1) ?? null;
    const from = lastHeldOn ?? startedOn;
    if (!from) return { kind, lastHeldOn: null, dueOn: null, state: "none_recorded" };
    const next = nextMeeting(kind, records, from, perYear[kind], today, dueWindowDays);
    return { kind, lastHeldOn, dueOn: next.dueOn, state: next.state };
  };
  return [one("supervision"), one("appraisal")];
}

/** Whether a member's meetings need someone's attention: overdue, due, or none recorded. */
export function meetingsNeedAttention(meetings: readonly MeetingDue[]): boolean {
  return meetings.some((m) => m.state !== "upcoming");
}
