import type { PayRates } from "./rates";

/**
 * The Agency Workers Regulations clock (scheduling.md 4b rule 6; AWR 2010 regulation 7). Calendar
 * weeks, in order, from the first assignment with a hirer in a role. A week with any work in it
 * counts. A run of ordinary breaks longer than the reset limit resets the clock; shorter runs pause
 * it. Sickness or injury pauses it for up to its own limit, after which the weeks count as an
 * ordinary break. Pregnancy, maternity, paternity and adoption leave, annual leave and the hirer's
 * shutdown pause it with no limit. A substantively different role starts it again.
 */

export type AwrWeek =
  | { readonly week: string; readonly kind: "worked"; readonly newRole?: boolean }
  | {
      readonly week: string;
      readonly kind: "break";
      readonly reason: "none" | "sickness" | "protected_leave" | "annual_leave" | "shutdown";
    };

export interface AwrClock {
  readonly qualifyingWeeks: number;
  /** The week from which equal basic terms apply (the week after the last qualifying week). */
  readonly qualifiedFromWeek: string | null;
  readonly resets: readonly { readonly week: string; readonly reason: "break" | "new_role" }[];
}

function nextWeek(isoMonday: string): string {
  const d = new Date(`${isoMonday}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString().slice(0, 10);
}

export function awrClock(weeks: readonly AwrWeek[], rates: PayRates): AwrClock {
  let count = 0;
  let ordinaryRun = 0;
  let sicknessRun = 0;
  let qualifiedFromWeek: string | null = null;
  const resets: { week: string; reason: "break" | "new_role" }[] = [];
  const sorted = [...weeks].sort((a, b) => (a.week < b.week ? -1 : 1));
  for (const w of sorted) {
    if (w.kind === "worked") {
      if (w.newRole && count > 0) {
        count = 0;
        qualifiedFromWeek = null;
        resets.push({ week: w.week, reason: "new_role" });
      }
      ordinaryRun = 0;
      sicknessRun = 0;
      if (qualifiedFromWeek === null) {
        count++;
        if (count >= rates.awrQualifyingWeeks) qualifiedFromWeek = nextWeek(w.week);
      }
      continue;
    }
    let ordinary = w.reason === "none";
    if (w.reason === "sickness") {
      sicknessRun++;
      ordinary = sicknessRun > rates.awrSicknessPauseMaxWeeks;
    }
    if (!ordinary) continue;
    ordinaryRun++;
    if (ordinaryRun > rates.awrBreakResetWeeks && count > 0) {
      // Qualified or not, a long break means the next assignment counts from nothing again.
      count = 0;
      qualifiedFromWeek = null;
      resets.push({ week: w.week, reason: "break" });
    }
  }
  return { qualifyingWeeks: count, qualifiedFromWeek, resets };
}
