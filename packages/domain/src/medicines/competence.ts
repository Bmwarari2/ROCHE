/**
 * Medicines competence gating (medicines.md rules 21 and 22; HZ-119; ADR-0085 default). Workforce
 * owns the observed competence sign-offs (slice 17) and publishes them through its port; on the
 * device the member's own rows are synced. This module reads a sign-off date against
 * `competence.medicines.refresh_months` and decides whether a medicines action may go ahead. An
 * expired competence blocks every administration unless someone else, who holds
 * `medicines.override.approve` (checked by the API), records an override with a reason for a
 * bounded time (`medicines.competence_override.max_hours`); every use is flagged for the override
 * report (slice 45), so the override cannot quietly become routine. A member never signed off
 * (`not_held`) is refused outright: staff not assessed as competent must not give medicines (NICE
 * SC1 1.18, as the master prompt cites it), so only a lapsed competence may be overridden (H-1061).
 */

import { addUkMonths, ukStartOfDay } from "../shared/time";
import type { MedicinesCompetence } from "./mar-entry";
import type { MedicinesRates } from "./rates";

const HOUR_MS = 3_600_000;

export interface CompetenceReading {
  readonly state: MedicinesCompetence;
  /** 00:00 UK time on the day the competence lapses, when there is a sign-off. */
  readonly expiresAt: Date | null;
}

/**
 * Medicines competence at an instant, from the date of the last observed sign-off: current until
 * 00:00 UK time on the same date `competence.medicines.refresh_months` later (the last day of a
 * shorter month, so it never lasts longer); none before a sign-off, or for one dated later.
 */
export function medicinesCompetenceAt(
  lastSignedOffOn: string | null,
  at: Date,
  rates: Pick<MedicinesRates, "competenceRefreshMonths">,
): CompetenceReading {
  if (lastSignedOffOn === null || !/^\d{4}-\d{2}-\d{2}$/.test(lastSignedOffOn)) {
    return { state: "not_held", expiresAt: null };
  }
  const signedOff = ukStartOfDay(lastSignedOffOn);
  if (at.getTime() < signedOff.getTime()) return { state: "not_held", expiresAt: null };
  const expiresAt = addUkMonths(signedOff, rates.competenceRefreshMonths);
  return { state: at.getTime() < expiresAt.getTime() ? "current" : "expired", expiresAt };
}

/** A manager's override of a member's lapsed (expired) medicines competence, for a bounded time. */
export interface CompetenceOverride {
  readonly memberId: string;
  readonly approvedBy: string;
  readonly reason: string;
  readonly from: Date;
  readonly until: Date;
}

export type CompetenceProblem =
  | "competence_expired"
  | "competence_not_held"
  | "override_for_someone_else"
  | "override_by_self"
  | "override_reason_required"
  | "override_too_long"
  | "override_not_in_force";

export type MedicinesCompetenceGate =
  | { readonly ok: true; readonly overridden: boolean }
  | { readonly ok: false; readonly problem: CompetenceProblem; readonly message: string };

const refused = (problem: CompetenceProblem, message: string): MedicinesCompetenceGate => ({
  ok: false,
  problem,
  message,
});

/**
 * Whether a member may carry out a medicines action at `at`: with current competence, or, when it
 * has expired, under an override in force that someone else approved with a reason. A member with
 * no sign-off is refused whatever override is offered.
 */
export function checkCompetenceGate(
  memberId: string,
  competence: MedicinesCompetence,
  override: CompetenceOverride | null,
  at: Date,
  rates: Pick<MedicinesRates, "competenceOverrideMaxHours">,
): MedicinesCompetenceGate {
  if (competence === "current") return { ok: true, overridden: false };
  if (competence === "not_held") {
    return refused(
      "competence_not_held",
      "You have no medicines competence sign-off, so you cannot record medicines. This cannot be overridden: ask for your competence to be assessed.",
    );
  }
  if (override === null) {
    return refused(
      "competence_expired",
      "Your medicines competence has expired. Ask a manager who can approve overrides, and book your competence check.",
    );
  }
  if (override.memberId !== memberId) {
    return refused("override_for_someone_else", "This override is for someone else.");
  }
  if (override.approvedBy === memberId) {
    return refused(
      "override_by_self",
      "Someone else must approve an override of your own competence.",
    );
  }
  if (override.reason.trim() === "") {
    return refused("override_reason_required", "The manager must say why the override is needed.");
  }
  const length = override.until.getTime() - override.from.getTime();
  if (length <= 0 || length > rates.competenceOverrideMaxHours * HOUR_MS) {
    return refused(
      "override_too_long",
      `An override lasts at most ${rates.competenceOverrideMaxHours} hours. Ask the manager to record a new one.`,
    );
  }
  if (at.getTime() < override.from.getTime() || at.getTime() >= override.until.getTime()) {
    return refused("override_not_in_force", "The override is not in force at this time.");
  }
  return { ok: true, overridden: true };
}
