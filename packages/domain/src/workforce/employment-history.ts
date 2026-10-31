import { fromMonthIndex, monthIndex, type YearMonth } from "./dates";

/**
 * Employment history (workforce.md rule 4; Schedule 3 paragraph 7: a full employment history,
 * together with a satisfactory written explanation of any gaps). From the history's start to the
 * application month, every calendar month not covered by work, education or an explained gap is a
 * gap. Periods may overlap; months count inclusively; a period still open runs to the application.
 */

export interface HistoryPeriod {
  readonly from: YearMonth;
  /** Null while it is still going on. */
  readonly to: YearMonth | null;
  readonly kind: "employment" | "education" | "explained_gap";
  /** For an explained gap: the written explanation (required). */
  readonly explanation?: string;
}

export interface Gap {
  readonly from: YearMonth;
  readonly to: YearMonth;
  readonly months: number;
}

export function employmentGaps(
  periods: readonly HistoryPeriod[],
  historyStart: YearMonth,
  applicationMonth: YearMonth,
): readonly Gap[] {
  const start = monthIndex(historyStart);
  const end = monthIndex(applicationMonth);
  if (end < start) return [];
  const covered = new Set<number>();
  for (const period of periods) {
    if (period.kind === "explained_gap" && !period.explanation?.trim()) continue;
    const from = Math.max(monthIndex(period.from), start);
    const to = Math.min(period.to ? monthIndex(period.to) : end, end);
    for (let m = from; m <= to; m++) covered.add(m);
  }
  const gaps: Gap[] = [];
  let open: number | null = null;
  for (let m = start; m <= end + 1; m++) {
    const isGap = m <= end && !covered.has(m);
    if (isGap && open === null) open = m;
    if (!isGap && open !== null) {
      gaps.push({ from: fromMonthIndex(open), to: fromMonthIndex(m - 1), months: m - open });
      open = null;
    }
  }
  return gaps;
}
