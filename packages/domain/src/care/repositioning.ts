/**
 * Repositioning chart (care.md section 4 rule 6). The default interval follows the person's skin
 * risk: `repositioning.interval_hours.at_risk` or `repositioning.interval_hours.high_risk` from the
 * rate table (tenant defaults after NICE CG179). An interval written in the person's care plan
 * by their clinical lead replaces the default. Intervals are elapsed time, so a clock change
 * never stretches or shortens one.
 */

import type { CareRates } from "./rates";

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

/** The person's recorded skin risk, set by staff from their assessment and clinical judgement. */
export type SkinRisk = "not_at_risk" | "at_risk" | "high_risk";

export type RepositioningInterval =
  | { readonly kind: "none" }
  | { readonly kind: "every"; readonly hours: number; readonly source: "care_plan" | "default" };

export function repositioningInterval(
  person: { readonly skinRisk: SkinRisk; readonly carePlanIntervalHours?: number | null },
  rates: Pick<CareRates, "repositioningAtRiskHours" | "repositioningHighRiskHours">,
): RepositioningInterval {
  const planned = person.carePlanIntervalHours;
  if (planned !== null && planned !== undefined) {
    if (!(planned > 0)) throw new RangeError("A repositioning interval must be more than 0 hours");
    return { kind: "every", hours: planned, source: "care_plan" };
  }
  if (person.skinRisk === "high_risk") {
    return { kind: "every", hours: rates.repositioningHighRiskHours, source: "default" };
  }
  if (person.skinRisk === "at_risk") {
    return { kind: "every", hours: rates.repositioningAtRiskHours, source: "default" };
  }
  return { kind: "none" };
}

export interface RepositioningStatus {
  readonly dueAt: Date;
  readonly overdue: boolean;
  /** Whole minutes past the due time; 0 when not overdue. */
  readonly overdueMinutes: number;
}

/**
 * When the next repositioning is due and whether it is overdue. `since` is the last recorded
 * repositioning, or the start of the chart when there is none yet. Due exactly now is not overdue.
 */
export function repositioningStatus(
  since: Date,
  intervalHours: number,
  now: Date,
): RepositioningStatus {
  if (!(intervalHours > 0)) {
    throw new RangeError("A repositioning interval must be more than 0 hours");
  }
  const dueAt = new Date(since.getTime() + intervalHours * MS_PER_HOUR);
  const lateMs = now.getTime() - dueAt.getTime();
  return {
    dueAt,
    overdue: lateMs > 0,
    overdueMinutes: lateMs > 0 ? Math.floor(lateMs / MS_PER_MINUTE) : 0,
  };
}
