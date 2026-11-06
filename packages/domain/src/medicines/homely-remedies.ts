/**
 * Homely remedy protocols and doses (Phase 2 slice 38; medicines.md section 15.3; MEDS-007;
 * HZ-120). A protocol is the home's own, agreed with a GP or pharmacist (NICE SC1 (2014) 1.17):
 * the product, what it is for, the dose, the shortest gap, the most in 24 hours, how many days
 * before the GP is asked, and the staff allowed to give it. Harbour checks a dose against the
 * protocol the home wrote; every figure is the protocol's or the rate table's, never a literal, and
 * Harbour recommends nothing.
 */

import { addDaysToDate } from "../care/assessment";

export const HOMELY_RATE_KEYS = {
  /** The longest a protocol may allow before the GP is asked (tenant default). */
  maxDaysCeiling: "medicines.homely_remedy.max_days_ceiling",
  /** The longest before a protocol is reviewed with the GP or pharmacist. */
  reviewMaxDays: "medicines.homely_remedy.review_max_days",
  /** A gap longer than this between doses starts a new course (for the days before referral). */
  courseGapHours: "medicines.homely_remedy.course_gap_hours",
} as const;

export interface HomelyProtocolInput {
  readonly productName: string;
  readonly indication: string;
  readonly doseQuantity: number;
  readonly unitName: string;
  readonly minIntervalHours: number;
  readonly maxDailyQuantity: number;
  /** Days a course may last before the person's GP is asked. */
  readonly maxDays: number;
  readonly authorisedMemberIds: readonly string[];
  readonly approvedByName: string;
  readonly approvedByRole: "gp" | "pharmacist";
  readonly approvedOn: string;
  readonly reviewOn: string;
}

export type HomelyProtocolProblem =
  | "dose_not_positive"
  | "daily_below_dose"
  | "interval_not_positive"
  | "max_days_out_of_range"
  | "no_authorised_staff"
  | "approved_in_future"
  | "review_not_after_approval"
  | "review_too_far";

export const HOMELY_PROTOCOL_PROBLEM_WORDS: Record<HomelyProtocolProblem, string> = {
  dose_not_positive: "Give the dose as a number above zero.",
  daily_below_dose: "The most in 24 hours cannot be less than one dose.",
  interval_not_positive: "Give the shortest gap between doses in hours, above zero.",
  max_days_out_of_range:
    "Give the days before the GP is asked: at least one, and no more than your organisation allows.",
  no_authorised_staff: "Name the staff allowed to give it.",
  approved_in_future: "The agreement with the GP or pharmacist cannot be dated in the future.",
  review_not_after_approval: "The review must be after the agreement.",
  review_too_far: "The review is further away than your organisation allows.",
};

export function checkHomelyProtocol(
  input: HomelyProtocolInput,
  context: {
    readonly today: string;
    readonly maxDaysCeiling: number;
    readonly reviewMaxDays: number;
  },
): HomelyProtocolProblem[] {
  const problems: HomelyProtocolProblem[] = [];
  if (!(input.doseQuantity > 0)) problems.push("dose_not_positive");
  else if (input.maxDailyQuantity < input.doseQuantity) problems.push("daily_below_dose");
  if (!(input.minIntervalHours > 0)) problems.push("interval_not_positive");
  if (input.maxDays < 1 || input.maxDays > context.maxDaysCeiling)
    problems.push("max_days_out_of_range");
  if (input.authorisedMemberIds.length === 0) problems.push("no_authorised_staff");
  if (input.approvedOn > context.today) problems.push("approved_in_future");
  if (input.reviewOn <= input.approvedOn) problems.push("review_not_after_approval");
  else if (input.reviewOn > addDaysToDate(input.approvedOn, context.reviewMaxDays))
    problems.push("review_too_far");
  return problems;
}

export type HomelyDoseProblem =
  | "protocol_withdrawn"
  | "protocol_review_overdue"
  | "not_authorised"
  | "dose_differs"
  | "too_soon"
  | "over_daily_maximum"
  | "refer_to_gp"
  | "prescribed_same_product"
  | "given_in_future";

export const HOMELY_DOSE_PROBLEM_WORDS: Record<HomelyDoseProblem, string> = {
  protocol_withdrawn: "This homely remedy protocol has been withdrawn.",
  protocol_review_overdue:
    "This protocol is past its review date: it cannot be used until it is reviewed with the GP or pharmacist.",
  not_authorised: "You are not named on this protocol as allowed to give it.",
  dose_differs: "Give the dose the protocol states.",
  too_soon: "It is too soon after the last dose under this protocol.",
  over_daily_maximum: "This would be more than the protocol allows in 24 hours.",
  refer_to_gp: "The protocol's days have been used: ask the person's GP before giving any more.",
  prescribed_same_product:
    "The person has this product prescribed: give it from their prescription, not as a homely remedy.",
  given_in_future: "A dose cannot be recorded in the future.",
};

export interface HomelyDoseInput {
  readonly at: Date;
  readonly now: Date;
  readonly memberId: string;
  readonly quantity: number;
  readonly protocol: {
    readonly doseQuantity: number;
    readonly minIntervalHours: number;
    readonly maxDailyQuantity: number;
    readonly maxDays: number;
    readonly authorisedMemberIds: readonly string[];
    readonly withdrawn: boolean;
    readonly reviewOn: string;
    readonly vmpId: string | null;
  };
  /** The UK date of `at`. */
  readonly onDate: string;
  /** The person's earlier doses under any version of this protocol (latest records only). */
  readonly earlier: readonly { readonly at: Date; readonly quantity: number }[];
  /** dm+d products of the person's current medicines entries. */
  readonly prescribedVmpIds: readonly string[];
}

const HOUR = 3_600_000;

/**
 * Every problem with a homely remedy dose before it is given: a homely remedy is given only within
 * the home's protocol, by the staff it names (H-1356). An exact product match with a current entry
 * is refused; another product with the same ingredient is not caught (ADR-0082, H-1357).
 */
export function checkHomelyDose(
  input: HomelyDoseInput,
  context: { readonly courseGapHours: number },
): HomelyDoseProblem[] {
  const p = input.protocol;
  const problems: HomelyDoseProblem[] = [];
  if (input.at.getTime() > input.now.getTime()) problems.push("given_in_future");
  if (p.withdrawn) problems.push("protocol_withdrawn");
  else if (input.onDate > p.reviewOn) problems.push("protocol_review_overdue");
  if (!p.authorisedMemberIds.includes(input.memberId)) problems.push("not_authorised");
  if (input.quantity !== p.doseQuantity) problems.push("dose_differs");
  if (p.vmpId !== null && input.prescribedVmpIds.includes(p.vmpId))
    problems.push("prescribed_same_product");
  const before = input.earlier
    .filter((d) => d.at.getTime() <= input.at.getTime())
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  const last = before[0];
  if (last && input.at.getTime() - last.at.getTime() < p.minIntervalHours * HOUR)
    problems.push("too_soon");
  const inDay = before
    .filter((d) => input.at.getTime() - d.at.getTime() < 24 * HOUR)
    .reduce((sum, d) => sum + d.quantity, 0);
  if (inDay + input.quantity > p.maxDailyQuantity) problems.push("over_daily_maximum");
  // The course: back from this dose while each gap is at most the course gap.
  let start = input.at.getTime();
  for (const d of before) {
    if (start - d.at.getTime() > context.courseGapHours * HOUR) break;
    start = d.at.getTime();
  }
  if (input.at.getTime() - start >= p.maxDays * 24 * HOUR) problems.push("refer_to_gp");
  return problems;
}

/** A protocol's state on a UK date, in words for lists. */
export function homelyProtocolStatus(
  protocol: { readonly withdrawn: boolean; readonly reviewOn: string },
  today: string,
): "in_use" | "review_overdue" | "withdrawn" {
  if (protocol.withdrawn) return "withdrawn";
  return today > protocol.reviewOn ? "review_overdue" : "in_use";
}
