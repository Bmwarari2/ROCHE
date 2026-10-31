import type { CompetenceGate } from "./competence";
import type { DbsClearance } from "./dbs";
import { mayWork, type RightToWorkStatus } from "./right-to-work";

/**
 * The rule that a worker without a required check cannot be rostered (workforce.md rule 10;
 * section 12; HZ-124 when the schema slice adds it). On the shift's UK date: DBS clear (or cleared
 * for supervised work and the shift is supervised), a right to work, a current registration where
 * the role needs one, and every competence the shift needs. Otherwise each blocker is listed; a
 * manager may override with a justification, which is logged and reported, except a missing right
 * to work: illegal working is never overridden.
 */

export type RosterBlocker =
  | { readonly kind: "dbs"; readonly reason: string }
  | { readonly kind: "dbs_supervised_only" }
  | { readonly kind: "right_to_work"; readonly reason: RightToWorkStatus["kind"] }
  | { readonly kind: "registration" }
  | { readonly kind: "competence"; readonly competence: string; readonly reason: string };

export interface RosterInput {
  readonly dbs: DbsClearance;
  readonly rightToWork: RightToWorkStatus;
  /** Null when the role needs no registration; otherwise whether it is current on the day. */
  readonly registrationCurrent: boolean | null;
  /** The competences the shift needs, each with the gate's answer for this worker on the day. */
  readonly competences: readonly { readonly competence: string; readonly gate: CompetenceGate }[];
  readonly shiftSupervised: boolean;
}

export interface Override {
  readonly justification: string;
  readonly byTenantUserId: string;
}

export type RosterDecision =
  | { readonly allowed: true; readonly overridden: readonly RosterBlocker[] }
  | {
      readonly allowed: false;
      readonly blockers: readonly RosterBlocker[];
      /** Whether a manager may override these blockers (never with a right to work blocker). */
      readonly overridable: boolean;
      readonly overrideRefused?: "justification_required" | "right_to_work";
    };

/** The shortest justification that counts: a short sentence, not a tick (a product rule). */
export const MIN_OVERRIDE_JUSTIFICATION = 10;

export function rosterBlockers(input: RosterInput): readonly RosterBlocker[] {
  const blockers: RosterBlocker[] = [];
  if (input.dbs.kind === "not_clear") blockers.push({ kind: "dbs", reason: input.dbs.reason });
  if (input.dbs.kind === "supervised_only" && !input.shiftSupervised) {
    blockers.push({ kind: "dbs_supervised_only" });
  }
  if (!mayWork(input.rightToWork)) {
    blockers.push({ kind: "right_to_work", reason: input.rightToWork.kind });
  }
  if (input.registrationCurrent === false) blockers.push({ kind: "registration" });
  for (const { competence, gate } of input.competences) {
    if (!gate.allowed) blockers.push({ kind: "competence", competence, reason: gate.reason });
  }
  return blockers;
}

export function rosterDecision(
  input: RosterInput,
  override: Override | null = null,
): RosterDecision {
  const blockers = rosterBlockers(input);
  if (blockers.length === 0) return { allowed: true, overridden: [] };
  const overridable = !blockers.some((b) => b.kind === "right_to_work");
  if (!override) return { allowed: false, blockers, overridable };
  if (!overridable) {
    return { allowed: false, blockers, overridable, overrideRefused: "right_to_work" };
  }
  if (override.justification.trim().length < MIN_OVERRIDE_JUSTIFICATION) {
    return { allowed: false, blockers, overridable, overrideRefused: "justification_required" };
  }
  return { allowed: true, overridden: blockers };
}
