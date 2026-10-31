import type { IncidentSummary } from "@harbour/contracts";
import { ukDayBounds } from "@harbour/domain";
import type { Translator } from "@harbour/i18n";
import { INCIDENT_LIST_LIMIT } from "./incidents";
import { ukToday } from "./uk-time";

/**
 * The incident trend view (register row SAFE-010; safety.md section 5): how many incidents and
 * near misses were recorded each UK calendar month, by type, from the incidents the reader can
 * list. Counts only: nothing here says what a count means, scores it or predicts anything
 * (medical-device boundary, section 4). Pure and unit tested.
 */

/** How many months the view shows, this month included. */
export const TREND_MONTHS = 6;

export interface TrendMonth {
  /** "2026-10". */
  readonly key: string;
  readonly year: number;
  readonly month: number;
  /** The month's first instant in UK time, and the next month's, for the API's `from` and `to`. */
  readonly from: string;
  readonly to: string;
}

/** The last `count` UK calendar months, oldest first, this month last. */
export function trendMonths(now: Date, count: number = TREND_MONTHS): TrendMonth[] {
  const [year, month] = ukToday(now).split("-").map(Number) as [number, number];
  const months: TrendMonth[] = [];
  for (let back = count - 1; back >= 0; back -= 1) {
    const start = new Date(Date.UTC(year, month - 1 - back, 1));
    const next = new Date(Date.UTC(year, month - back, 1));
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    months.push({
      key: iso(start).slice(0, 7),
      year: start.getUTCFullYear(),
      month: start.getUTCMonth() + 1,
      from: ukDayBounds(iso(start)).startsAt.toISOString(),
      to: ukDayBounds(iso(next)).startsAt.toISOString(),
    });
  }
  return months;
}

/** "October 2026", in the catalogue's words. */
export function monthLabel(month: Pick<TrendMonth, "year" | "month">, t: Translator): string {
  return t("safety.trends.month", { month: month.month, year: String(month.year) });
}

export interface TrendRow {
  /** The incident type, or "total" for the row of totals. */
  readonly type: string;
  readonly label: string;
  /** One count per month, in the months' order. */
  readonly counts: readonly number[];
  readonly total: number;
}

export interface TrendTable {
  readonly rows: readonly TrendRow[];
  readonly total: TrendRow;
  /** Months whose read reached the API's limit: their counts are at least what is shown. */
  readonly capped: readonly string[];
}

/**
 * Counts by type and month from one list per month (each as the API returned it), the types with
 * the most incidents first, then by name; a month whose list reached the API's limit of 500 is
 * named in `capped`, so the page says its counts are at least that.
 */
export function trendTable(
  months: readonly TrendMonth[],
  lists: readonly (readonly Pick<IncidentSummary, "type">[])[],
  t: Translator,
): TrendTable {
  const byType = new Map<string, number[]>();
  lists.forEach((list, i) => {
    for (const item of list) {
      const counts = byType.get(item.type) ?? months.map(() => 0);
      counts[i] = (counts[i] ?? 0) + 1;
      byType.set(item.type, counts);
    }
  });
  const sum = (counts: readonly number[]) => counts.reduce((a, b) => a + b, 0);
  const rows = [...byType]
    .map(([type, counts]) => ({
      type,
      label: t("safety.incident.type", { type }),
      counts,
      total: sum(counts),
    }))
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label, "en-GB"));
  const totals = months.map((_, i) => lists[i]?.length ?? 0);
  return {
    rows,
    total: { type: "total", label: t("safety.trends.total"), counts: totals, total: sum(totals) },
    capped: months
      .filter((_, i) => (lists[i]?.length ?? 0) >= INCIDENT_LIST_LIMIT)
      .map((m) => m.key),
  };
}
