import { addMonths } from "./dates";

/**
 * Observed competence (workforce.md rule 6; WORK-008; ADR-0085 for gating across modules). A
 * sign-off is valid from the day it was observed through the day before observed plus the
 * competence's refresh months. It counts only when the observer was someone else who held
 * `workforce.competence.observe` when they signed. An action that needs a competence is allowed only
 * with a valid sign-off; otherwise it is blocked with the reason, unless an override with a
 * justification is recorded (by whom is the calling module's rule, ADR-0085).
 */

export const OBSERVE_PERMISSION = "workforce.competence.observe";

export interface CompetenceSignOff {
  readonly competence: string;
  readonly workerId: string;
  readonly observedOn: string;
  readonly observerId: string;
  /** The observer's permissions when they signed. */
  readonly observerPermissions: readonly string[];
}

export type CompetenceBlock = "missing" | "expired" | "self_signed" | "observer_not_permitted";

export type CompetenceGate =
  | { readonly allowed: true; readonly validUntil: string }
  | {
      readonly allowed: false;
      readonly reason: CompetenceBlock;
      readonly validUntil: string | null;
    };

export function signOffValidUntil(signOff: CompetenceSignOff, refreshMonths: number): string {
  const end = new Date(`${addMonths(signOff.observedOn, refreshMonths)}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() - 1);
  return end.toISOString().slice(0, 10);
}

function signOffProblem(signOff: CompetenceSignOff): CompetenceBlock | null {
  if (signOff.observerId === signOff.workerId) return "self_signed";
  if (!signOff.observerPermissions.includes(OBSERVE_PERMISSION)) return "observer_not_permitted";
  return null;
}

/**
 * Whether `workerId` may do an action needing `competence` on `today`. The newest acceptable
 * sign-off counts; an unacceptable one (self-signed, observer without the permission) never does,
 * and is reported only when there is nothing better.
 */
export function competenceGate(
  workerId: string,
  competence: string,
  signOffs: readonly CompetenceSignOff[],
  today: string,
  refreshMonths: number,
): CompetenceGate {
  const mine = signOffs
    .filter((s) => s.workerId === workerId && s.competence === competence && s.observedOn <= today)
    .sort((a, b) => (a.observedOn < b.observedOn ? 1 : -1));
  const acceptable = mine.filter((s) => signOffProblem(s) === null);
  const best = acceptable[0];
  if (best) {
    const validUntil = signOffValidUntil(best, refreshMonths);
    return validUntil >= today
      ? { allowed: true, validUntil }
      : { allowed: false, reason: "expired", validUntil };
  }
  const rejected = mine[0];
  if (rejected) {
    return { allowed: false, reason: signOffProblem(rejected) ?? "missing", validUntil: null };
  }
  return { allowed: false, reason: "missing", validUntil: null };
}
