import { addDays, addMonths } from "./dates";
import type { WorkforceRates } from "./rates";

/**
 * The competence port's rule (ADR-0085; workforce.md sections 2b and 5; HZ-119, HZ-124). Medicines
 * and scheduling ask, on the server, whether a member may do an action that needs a competence on
 * a UK date; the answer comes from the member's stored sign-offs, never from the client. A stored
 * sign-off is already acceptable (observed by someone else who held
 * `workforce.competence.observe`: the database refuses any other), so the rule here is about
 * dates and withdrawals.
 */

/** Observed competences the organisation signs off. Medicines ones refresh on the medicines rate. */
export const COMPETENCES = [
  "medicines_administration",
  "controlled_drugs",
  "insulin_administration",
  "epilepsy_rescue_medication",
  "moving_and_handling_hoist",
  "catheter_care",
  "enteral_feeding",
  "oxygen_therapy",
] as const;
export type Competence = (typeof COMPETENCES)[number];

export const MEDICINES_COMPETENCES: ReadonlySet<Competence> = new Set([
  "medicines_administration",
  "controlled_drugs",
  "insulin_administration",
  "epilepsy_rescue_medication",
]);

export function isCompetence(value: string): value is Competence {
  return (COMPETENCES as readonly string[]).includes(value);
}

/** How long a sign-off for this competence lasts, in months, from the rate table. */
export function competenceRefreshMonths(competence: Competence, rates: WorkforceRates): number {
  return MEDICINES_COMPETENCES.has(competence)
    ? rates.medicinesCompetenceRefreshMonths
    : rates.competenceDefaultRefreshMonths;
}

/** The last valid day of a sign-off observed on `observedOn`: the day before the refresh. */
export function competenceValidUntil(observedOn: string, refreshMonths: number): string {
  return addDays(addMonths(observedOn, refreshMonths), -1);
}

export interface StoredSignOff {
  readonly observedOn: string;
  readonly validUntil: string;
  /** The UK date it was withdrawn, or null. */
  readonly withdrawnOn: string | null;
}

export type CompetenceDecision =
  | { readonly allowed: true; readonly validUntil: string }
  | {
      readonly allowed: false;
      readonly reason: "missing" | "expired" | "withdrawn";
      /** The last valid day of the newest sign-off in force, for an expired one. */
      readonly validUntil: string | null;
    };

/**
 * Whether the member may do the action on `today` (clinical safety review round 1, finding 1). A
 * withdrawal is about the member, not one sign-off: from the day of the latest withdrawal by today,
 * only a sign-off observed on or after that day counts. Then the newest sign-off in force (observed
 * on or before today, not itself withdrawn by today) allows the action through its valid-until day;
 * expired from the day after; `withdrawn` when a withdrawal left nothing in force; `missing`
 * otherwise.
 */
export function competenceDecision(
  signOffs: readonly StoredSignOff[],
  today: string,
): CompetenceDecision {
  const observed = signOffs.filter((s) => s.observedOn <= today);
  const lastWithdrawal = observed
    .map((s) => s.withdrawnOn)
    .filter((on): on is string => on !== null && on <= today)
    .sort()
    .at(-1);
  const inForce = observed.filter(
    (s) =>
      (s.withdrawnOn === null || s.withdrawnOn > today) &&
      (lastWithdrawal === undefined || s.observedOn >= lastWithdrawal),
  );
  const best = inForce
    .map((s) => s.validUntil)
    .sort()
    .at(-1);
  if (best !== undefined) {
    return best >= today
      ? { allowed: true, validUntil: best }
      : { allowed: false, reason: "expired", validUntil: best };
  }
  if (lastWithdrawal !== undefined)
    return { allowed: false, reason: "withdrawn", validUntil: null };
  return { allowed: false, reason: "missing", validUntil: null };
}

/**
 * The decision for an action at `serverNow`, and also at the time the device says it happened when
 * one is given (an administration recorded offline): blocked if either is (clinical safety review
 * round 1, finding 2; ADR-0085). A device's time can never allow what the server's time blocks.
 */
export function competenceDecisionAt(
  signOffs: readonly StoredSignOff[],
  serverToday: string,
  claimedDay: string | null,
): CompetenceDecision {
  const now = competenceDecision(signOffs, serverToday);
  if (!now.allowed || claimedDay === null || claimedDay === serverToday) return now;
  const claimed = competenceDecision(signOffs, claimedDay);
  return claimed.allowed ? now : claimed;
}
