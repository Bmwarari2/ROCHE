/**
 * PRN (when-required) protocols, outcome follow-up and the PRN frequency report (Phase 2 slice 28;
 * medicines.md section 16; MEDS-003; HZ-117). A protocol is the home's guidance for one
 * when-required medicine: what it is for, the signs that mean it may be needed, what to try first,
 * the order among the person's medicines for the same purpose and its review. The dose, the most
 * in 24 hours and the minimum interval stay the prescriber's, on the medicines entry (migration
 * 0123): the protocol shows them and never holds a second copy. Harbour counts, compares with the
 * protocol and displays; it never recommends a dose or a medicine.
 */

import { addDaysToDate } from "../care/assessment";
import { ukIsoDate } from "../shared/working-days";

export const PRN_RATE_KEYS = {
  protocolReviewMaxDays: "medicines.prn_protocol.review_max_days",
  reportMaxDays: "medicines.prn_report.max_days",
} as const;

export const PRN_AGREED_ROLES = ["prescriber", "pharmacist"] as const;
export type PrnAgreedRole = (typeof PRN_AGREED_ROLES)[number];

export interface PrnProtocolInput {
  /** The entry the protocol is for, as stored. */
  readonly entry: {
    readonly personId: string;
    readonly directions: string;
    readonly state: string;
  } | null;
  readonly personId: string;
  readonly purpose: string;
  readonly triggers: readonly string[];
  readonly nonDrugAlternatives: readonly string[];
  /** The group of the person's when-required medicines for one purpose, with this one's place. */
  readonly purposeGroup: string | null;
  readonly orderOfUse: number | null;
  readonly expectedEffect: string;
  readonly agreedWithName: string;
  readonly agreedWithRole: PrnAgreedRole;
  readonly agreedOn: string;
  readonly reviewOn: string;
  /** Places already taken in the same group by the person's other open protocols. */
  readonly takenOrders: readonly number[];
}

export type PrnProtocolProblem =
  | "entry_other_person"
  | "entry_not_when_required"
  | "entry_not_current"
  | "no_triggers"
  | "order_without_group"
  | "order_taken"
  | "agreed_in_future"
  | "review_not_after_agreement"
  | "review_too_far";

export const PRN_PROTOCOL_PROBLEM_WORDS: Record<PrnProtocolProblem, string> = {
  entry_other_person: "Choose one of this person's medicines.",
  entry_not_when_required: "A PRN protocol is for a when-required medicine.",
  entry_not_current: "The medicine has been stopped or replaced: choose the current entry.",
  no_triggers: "Say what signs mean it may be needed.",
  order_without_group: "Give the group of medicines this one is ordered within.",
  order_taken: "Another of this person's medicines already has that place in the group.",
  agreed_in_future: "The agreement cannot be dated in the future.",
  review_not_after_agreement: "The review must be after the agreement.",
  review_too_far: "The review is further away than your organisation allows.",
};

const CURRENT_STATES = new Set(["not_yet_checked", "checked", "difference_found"]);

/** Every problem with a PRN protocol; empty when it may be stored. */
export function checkPrnProtocol(
  input: PrnProtocolInput,
  context: { readonly today: string; readonly reviewMaxDays: number },
): PrnProtocolProblem[] {
  const problems: PrnProtocolProblem[] = [];
  const e = input.entry;
  if (!e || e.personId !== input.personId) problems.push("entry_other_person");
  else {
    if (e.directions !== "when_required") problems.push("entry_not_when_required");
    if (!CURRENT_STATES.has(e.state)) problems.push("entry_not_current");
  }
  if (input.triggers.filter((t) => t.trim() !== "").length === 0) problems.push("no_triggers");
  if (input.orderOfUse !== null) {
    if (input.purposeGroup === null || input.purposeGroup.trim() === "")
      problems.push("order_without_group");
    else if (input.takenOrders.includes(input.orderOfUse)) problems.push("order_taken");
  }
  if (input.agreedOn > context.today) problems.push("agreed_in_future");
  if (input.reviewOn <= input.agreedOn) problems.push("review_not_after_agreement");
  else if (input.reviewOn > addDaysToDate(input.agreedOn, context.reviewMaxDays))
    problems.push("review_too_far");
  return problems;
}

export type PrnProtocolStatus =
  | "in_use"
  | "review_overdue"
  | "medicine_stopped"
  | "not_when_required_now"
  | "withdrawn";

/**
 * A protocol's state on a UK date, read with the latest version of its entry: a protocol for a
 * medicine since stopped, or no longer prescribed when required, is not in use whatever its dates
 * (the prescription is the source; HZ-117).
 */
export function prnProtocolStatus(
  protocol: { readonly withdrawnOn: string | null; readonly reviewOn: string },
  today: string,
  entry: { readonly state: string; readonly directions: string } | null = null,
): PrnProtocolStatus {
  if (protocol.withdrawnOn !== null && protocol.withdrawnOn <= today) return "withdrawn";
  if (entry) {
    if (entry.state === "stopped" || entry.state === "replaced" || entry.state === "withdrawn")
      return "medicine_stopped";
    if (entry.directions !== "when_required") return "not_when_required_now";
  }
  return today > protocol.reviewOn ? "review_overdue" : "in_use";
}

export const PRN_PROTOCOL_STATUS_WORDS: Record<PrnProtocolStatus, string> = {
  in_use: "Protocol in use",
  review_overdue: "Protocol review overdue",
  medicine_stopped: "The medicine has been stopped: this protocol is not in use",
  not_when_required_now:
    "The medicine is no longer prescribed when required: review or withdraw this protocol",
  withdrawn: "Protocol withdrawn",
};

// Outcomes

export const PRN_OUTCOMES = [
  "effective",
  "partly_effective",
  "not_effective",
  "person_asleep",
  "could_not_assess",
] as const;
export type PrnOutcome = (typeof PRN_OUTCOMES)[number];

export const PRN_OUTCOME_WORDS: Record<PrnOutcome, string> = {
  effective: "It helped",
  partly_effective: "It helped a little",
  not_effective: "It did not help",
  person_asleep: "The person was asleep",
  could_not_assess: "Could not tell",
};

export type PrnOutcomeProblem = "not_when_required" | "not_given" | "before_dose" | "in_future";

export const PRN_OUTCOME_PROBLEM_WORDS: Record<PrnOutcomeProblem, string> = {
  not_when_required: "An outcome is recorded for a when-required dose.",
  not_given: "An outcome is recorded only for a dose that was given or taken.",
  before_dose: "The outcome cannot be seen before the dose was given.",
  in_future: "The outcome cannot be dated in the future.",
};

/** The outcomes of a dose that may have an outcome recorded. */
export const PRN_OUTCOME_DOSE_OUTCOMES = ["given", "self_administered", "given_by_family"] as const;

export function checkPrnOutcome(input: {
  readonly dose: { readonly dueAt: Date | null; readonly outcome: string; readonly givenAt: Date };
  readonly observedAt: Date;
  readonly now: Date;
}): PrnOutcomeProblem[] {
  const problems: PrnOutcomeProblem[] = [];
  if (input.dose.dueAt !== null) problems.push("not_when_required");
  if (!(PRN_OUTCOME_DOSE_OUTCOMES as readonly string[]).includes(input.dose.outcome))
    problems.push("not_given");
  if (input.observedAt.getTime() < input.dose.givenAt.getTime()) problems.push("before_dose");
  if (input.observedAt.getTime() > input.now.getTime()) problems.push("in_future");
  return problems;
}

// The PRN frequency report

export const PRN_REPORT_NOTE =
  "A count of when-required doses from the records, for the person's prescriber and pharmacist to review. It does not judge the person, the prescribing or the staff.";

export interface PrnReportDose {
  readonly personId: string;
  readonly medicineId: string;
  readonly at: Date;
  /** Psychotropic by the entry's tag or the tenant's list. */
  readonly psychotropic: boolean;
  /**
   * The protocol in force when it was given: `current`, `review_overdue` (in force but past its
   * review date), or `none`. In force from when it was recorded (never earlier, whatever date was
   * typed) until it was withdrawn.
   */
  readonly protocol: "current" | "review_overdue" | "none";
  readonly outcome: PrnOutcome | null;
  /** The outcome's check time has passed. */
  readonly outcomeDue: boolean;
}

export interface PrnReportLine {
  readonly personId: string;
  readonly medicineId: string;
  readonly psychotropic: boolean;
  readonly doses: number;
  /** Distinct UK days with a dose. */
  readonly daysWithDoses: number;
  /** The most doses on one calendar day, UK time (not the prescriber's rolling 24 hours). */
  readonly mostInOneDay: number;
  readonly withoutProtocol: number;
  /** Given under a protocol past its review date. */
  readonly underOverdueProtocol: number;
  readonly outcomes: Readonly<Record<PrnOutcome, number>>;
  /** Due and not recorded. */
  readonly outcomesOutstanding: number;
}

/** Counts per person and medicine, newest grouping order kept stable (person, medicine). */
export function prnFrequency(doses: readonly PrnReportDose[]): PrnReportLine[] {
  const groups = new Map<string, PrnReportDose[]>();
  for (const d of doses) {
    const key = `${d.personId}|${d.medicineId}`;
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  return [...groups.values()]
    .map((g) => {
      const first = g[0] as PrnReportDose;
      const perDay = new Map<string, number>();
      for (const d of g) {
        const day = ukIsoDate(d.at);
        perDay.set(day, (perDay.get(day) ?? 0) + 1);
      }
      const outcomes = Object.fromEntries(PRN_OUTCOMES.map((o) => [o, 0])) as Record<
        PrnOutcome,
        number
      >;
      for (const d of g) if (d.outcome) outcomes[d.outcome] += 1;
      return {
        personId: first.personId,
        medicineId: first.medicineId,
        psychotropic: g.some((d) => d.psychotropic),
        doses: g.length,
        daysWithDoses: perDay.size,
        mostInOneDay: Math.max(...perDay.values()),
        withoutProtocol: g.filter((d) => d.protocol === "none").length,
        underOverdueProtocol: g.filter((d) => d.protocol === "review_overdue").length,
        outcomes,
        outcomesOutstanding: g.filter((d) => d.outcome === null && d.outcomeDue).length,
      };
    })
    .sort((a, b) =>
      a.personId === b.personId
        ? a.medicineId.localeCompare(b.medicineId)
        : a.personId.localeCompare(b.personId),
    );
}

// The tenant's medicine lists (ADR-0082, H-514)

export type MedicineListProblem = "not_a_product" | "already_listed";

export const MEDICINE_LIST_PROBLEM_WORDS: Record<MedicineListProblem, string> = {
  not_a_product: "Choose a dm+d product (VMP).",
  already_listed: "This product is already on the list.",
};

export function checkMedicineListItem(
  vmpId: string,
  listed: ReadonlySet<string>,
): MedicineListProblem[] {
  if (!/^[0-9]{6,18}$/.test(vmpId)) return ["not_a_product"];
  return listed.has(vmpId) ? ["already_listed"] : [];
}

/**
 * Which protocol was in force at an instant: from when it was recorded (or the agreement date,
 * if later) until it was withdrawn. A date typed in can never make earlier doses count as under a
 * protocol (clinical review, 06/11/2026).
 */
export function protocolInForce(
  protocols: readonly {
    readonly recordedAt: Date;
    readonly agreedFrom: Date;
    readonly withdrawnAt: Date | null;
    /**
     * Each version's review date with the instant it took effect, so a review recorded late never
     * rewrites what was overdue at the time (clinical review, 06/11/2026).
     */
    readonly reviews: readonly { readonly from: Date; readonly reviewOn: string }[];
  }[],
  at: Date,
): "current" | "review_overdue" | "none" {
  const found = protocols.find(
    (p) =>
      Math.max(p.recordedAt.getTime(), p.agreedFrom.getTime()) <= at.getTime() &&
      (p.withdrawnAt === null || at.getTime() < p.withdrawnAt.getTime()),
  );
  if (!found) return "none";
  const review = [...found.reviews]
    .filter((v) => v.from.getTime() <= at.getTime())
    .sort((a, b) => b.from.getTime() - a.from.getTime())[0];
  // Before the first version's own time (a dose at the instant it was recorded), the first version.
  const reviewOn =
    review?.reviewOn ??
    [...found.reviews].sort((a, b) => a.from.getTime() - b.from.getTime())[0]?.reviewOn;
  if (reviewOn === undefined) return "current";
  return ukIsoDate(at) > reviewOn ? "review_overdue" : "current";
}
