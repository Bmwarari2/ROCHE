import { DAYS_PER_WEEK, plusDays } from "../intervals";
import type { PayRates } from "./rates";

/**
 * The Agency Workers Regulations clock (scheduling.md 4b rule 6; AWR 2010 regulation 7, read on
 * legislation.gov.uk on 31 October 2026). Calendar weeks, in order, from the first assignment with
 * a hirer in a role; a week with any work in it counts (reg 7(4)). A break keeps the weeks before
 * it only if the break as a whole is covered by reg 7(8): any break of up to the reset limit; or a
 * break wholly for sickness or injury of up to its own limit (reg 7(9)), for protected leave, annual
 * or other leave, the hirer's shutdown or industrial action, or for several of those reasons. A
 * break with any uncovered week that runs past the reset limit, or a sickness break past its limit,
 * resets the clock, as does a substantively different role (reg 7(3)). Pregnancy, maternity,
 * adoption and paternity leave within the assignment's original or likely length count as weeks
 * worked (reg 7(6)); the caller marks those weeks `deemedWorking`.
 */

export type AwrBreakReason =
  /** No reason that reg 7(8)(b) to (g) covers. */
  | "none"
  /** Incapable of working through sickness or injury (reg 7(8)(b), (9)). */
  | "sickness"
  /** Pregnancy, childbirth or maternity in the protected period; maternity, adoption or paternity leave (reg 7(8)(c), (d)(i) to (iii)). */
  | "protected_leave"
  /** Other statutory or contractual leave the worker is entitled to (reg 7(8)(d)(iv)). */
  | "annual_leave"
  /** The hirer's customary shutdown (reg 7(8)(f)). */
  | "shutdown"
  /** A strike, lock-out or other industrial action at the hirer (reg 7(8)(g)). */
  | "industrial_action";

export type AwrWeek =
  | { readonly week: string; readonly kind: "worked"; readonly newRole?: boolean }
  | {
      readonly week: string;
      readonly kind: "break";
      readonly reason: AwrBreakReason;
      /** Protected leave within the assignment's original or likely length (reg 7(6)). */
      readonly deemedWorking?: boolean;
    };

export interface AwrClock {
  readonly qualifyingWeeks: number;
  /** The week from which equal basic terms apply (the week after the last qualifying week). */
  readonly qualifiedFromWeek: string | null;
  readonly resets: readonly { readonly week: string; readonly reason: "break" | "new_role" }[];
}

export function awrClock(weeks: readonly AwrWeek[], rates: PayRates): AwrClock {
  let count = 0;
  let qualifiedFromWeek: string | null = null;
  const resets: { week: string; reason: "break" | "new_role" }[] = [];
  let run = { weeks: 0, sickness: 0, uncovered: false, reset: false };
  const countWeek = (week: string) => {
    run = { weeks: 0, sickness: 0, uncovered: false, reset: false };
    if (qualifiedFromWeek !== null) return;
    count++;
    if (count >= rates.awrQualifyingWeeks) qualifiedFromWeek = plusDays(week, DAYS_PER_WEEK);
  };
  const sorted = [...weeks].sort((a, b) => (a.week < b.week ? -1 : 1));
  for (const w of sorted) {
    if (w.kind === "worked") {
      if (w.newRole && count > 0) {
        count = 0;
        qualifiedFromWeek = null;
        resets.push({ week: w.week, reason: "new_role" });
      }
      countWeek(w.week);
      continue;
    }
    if (w.deemedWorking) {
      if (w.reason !== "protected_leave") {
        throw new RangeError("Only protected leave can be deemed working (AWR reg 7(6)).");
      }
      countWeek(w.week);
      continue;
    }
    run.weeks++;
    if (w.reason === "none") run.uncovered = true;
    if (w.reason === "sickness") run.sickness++;
    const covered =
      run.weeks <= rates.awrBreakResetWeeks ||
      (!run.uncovered && run.sickness <= rates.awrSicknessPauseMaxWeeks);
    if (!covered && !run.reset && count > 0) {
      // Qualified or not, the next assignment counts from nothing again.
      count = 0;
      qualifiedFromWeek = null;
      run.reset = true;
      resets.push({ week: w.week, reason: "break" });
    }
  }
  return { qualifyingWeeks: count, qualifiedFromWeek, resets };
}
