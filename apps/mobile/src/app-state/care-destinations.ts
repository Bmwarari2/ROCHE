/**
 * Which Care mode destinations a member has, from their permissions (ADR-0138). The tab bar holds
 * five at most, as both platforms require: Today, Round, Medicines (when they give medicines),
 * People and More. More holds the rest: Handover, Shifts and Training when the member has them,
 * and Settings always.
 */

/** Who reads their own training, and so has Training (H-1365). */
export const TRAINING_SELF = "workforce.self.read";

/** Who takes part in the handover, as the API and the handover streams decide (care.md rule 14). */
export const HANDOVER_PERMISSION = "care.handover.manage";

/** Who has a Medicines tab: those the medicines streams reach (slice 69; ADR-0130). */
export const MEDICINES_PERMISSION = "medicines.emar.administer";

/** Who has Shifts: those who clock their own time or work alone (scheduling.md section 18). */
export const SHIFTS_PERMISSIONS = ["scheduling.timesheet.self", "scheduling.lone_worker.check_in"];

export interface CareDestinations {
  readonly medicines: boolean;
  readonly handover: boolean;
  readonly shifts: boolean;
  /** The member's own training (H-1365). */
  readonly training: boolean;
}

export function careDestinations(permissions: readonly string[]): CareDestinations {
  return {
    medicines: permissions.includes(MEDICINES_PERMISSION),
    handover: permissions.includes(HANDOVER_PERMISSION),
    shifts: SHIFTS_PERMISSIONS.some((p) => permissions.includes(p)),
    training: permissions.includes(TRAINING_SELF),
  };
}

/** The tabs, in order. Never more than five. */
export function careTabs(destinations: CareDestinations): ReadonlyArray<string> {
  return ["today", "round", ...(destinations.medicines ? ["medicines"] : []), "people", "more"];
}
