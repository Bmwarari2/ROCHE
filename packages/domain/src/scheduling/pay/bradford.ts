import { DAYS_PER_WEEK, plusDays } from "../intervals";
import type { PayRates } from "./rates";

/**
 * The Bradford factor (scheduling.md 4b rule 8): spells of absence times spells times days, over
 * the last `absence.bradford.window_weeks` weeks. Consecutive absence days are one spell, and so are
 * days separated only by days the worker was not due to work. The score is shown with its parts and
 * never triggers an action by itself (no solely automated decision, section 5.1).
 */

export interface BradfordScore {
  readonly spells: number;
  readonly days: number;
  readonly score: number;
  readonly windowStart: string;
}

export function bradfordFactor(
  absenceDays: readonly string[],
  nonWorkingDays: ReadonlySet<string>,
  today: string,
  rates: PayRates,
): BradfordScore {
  const windowStart = plusDays(today, 1 - rates.bradfordWindowWeeks * DAYS_PER_WEEK);
  const days = [...new Set(absenceDays)].filter((d) => d >= windowStart && d <= today).sort();
  let spells = 0;
  let previous: string | null = null;
  for (const day of days) {
    let joined = false;
    if (previous) {
      let cursor = plusDays(previous, 1);
      while (cursor < day && nonWorkingDays.has(cursor)) cursor = plusDays(cursor, 1);
      joined = cursor === day;
    }
    if (!joined) spells++;
    previous = day;
  }
  return { spells, days: days.length, score: spells * spells * days.length, windowStart };
}
