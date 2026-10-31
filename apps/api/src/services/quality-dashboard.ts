import { qualityIndicatorTarget, type Transaction } from "@harbour/db";
import {
  dashboardIndicator,
  INDICATOR_SOURCES,
  type IndicatorDefinition,
  type IndicatorInput,
  PIR_QUESTION_SET,
  type PirValue,
  phase2Indicators,
  pirPrefill,
  type QualityIndicatorKey,
  type QualityPhase2Rates,
  type StoredTarget,
} from "@harbour/domain";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { HttpProblem, problems } from "../http/problem";

/**
 * The quality dashboard and PIR prefill (QUAL-005, QUAL-006; quality.md section 22; ADR-0108).
 * The counts come from `app.quality_indicator_counts`, which checks the caller's permission at the
 * location itself and returns numbers only; the rules (38 to 43) are the domain's.
 */

type Tx = Transaction;

export const QUALITY_DASHBOARD_PERMISSION = "quality.audit.manage";

/** The most whole calendar months one view covers (rule 42; the function checks it too). */
export const MAX_PERIOD_MONTHS = 12;

export interface IndicatorCounts {
  readonly since: string;
  readonly today: string;
  readonly incidents: number;
  readonly falls: number;
  readonly medicationErrors: number;
  readonly pressureUlcers: number;
  readonly bedDays: number;
  readonly reviewsDue: number;
  readonly reviewsOverdue: number;
  readonly incidentsDecided: number;
  readonly incidentsReviewedInTime: number;
  readonly careNotes: number;
  readonly peopleWithoutReviewDate: number;
  readonly openOutages: number;
}

const DAY = 86_400_000;
const dayNumber = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / DAY;
const isoOf = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);
export const addDays = (iso: string, days: number) => isoOf(dayNumber(iso) + days);
export const daysBetween = (from: string, to: string) => dayNumber(to) - dayNumber(from);

/**
 * Rule 41: whether a location's target is at least as strict as the organisation default, in
 * the indicator's direction (green and amber each), so a home cannot mark its own work more kindly
 * than the organisation does (slice 47 clinical review).
 */
export function noLooserThan(
  direction: "lower_is_better" | "higher_is_better",
  target: { readonly green: number; readonly amber: number },
  organisation: { readonly green: number; readonly amber: number } | null,
): boolean {
  if (!organisation) return true;
  const atLeastAsStrict = (mine: number, theirs: number) =>
    direction === "lower_is_better" ? mine <= theirs : mine >= theirs;
  return (
    atLeastAsStrict(target.green, organisation.green) &&
    atLeastAsStrict(target.amber, organisation.amber)
  );
}

const monthsSpanned = (from: string, to: string) =>
  (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
  (Number(to.slice(5, 7)) - Number(from.slice(5, 7))) +
  1;

/**
 * Rule 42: whole calendar months that have ended, at most twelve, so no two views can be
 * subtracted to single out a day (slice 47 security review). The function checks it again.
 */
export function checkPeriod(from: string, to: string, today: string): void {
  if (daysBetween(from, to) < 0) {
    throw new HttpProblem(
      422,
      "period_order",
      "The period must end on or after the day it starts.",
    );
  }
  if (!from.endsWith("-01") || !addDays(to, 1).endsWith("-01")) {
    throw new HttpProblem(
      422,
      "period_not_months",
      "Choose whole months: from the first day of a month to the last day of a month.",
    );
  }
  if (daysBetween(to, today) <= 0) {
    throw new HttpProblem(422, "period_not_ended", "Choose months that have ended.");
  }
  if (monthsSpanned(from, to) > MAX_PERIOD_MONTHS) {
    throw new HttpProblem(422, "period_too_long", `Choose ${MAX_PERIOD_MONTHS} months or fewer.`);
  }
}

/** The counts for one location and period; a refusal by the function is a 403. */
export async function indicatorCounts(
  tx: Tx,
  locationId: string,
  from: string,
  to: string,
  targetDays: number,
): Promise<IndicatorCounts> {
  try {
    // Bounded: a view that cannot be counted quickly fails rather than holding the connection.
    await tx.execute(sql`SET LOCAL statement_timeout = '10s'`);
    const result = await tx.execute<{ c: IndicatorCounts }>(
      sql`SELECT app.quality_indicator_counts(${locationId}::uuid, ${from}::date, ${to}::date, ${targetDays}::integer) AS c`,
    );
    const counts = result.rows[0]?.c;
    if (!counts) throw problems.forbidden();
    return counts;
  } catch (error) {
    const code =
      (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
    if (code === "42501") throw problems.forbidden();
    throw error;
  }
}

/** The live targets for a location and the organisation defaults. */
export async function targetsFor(tx: Tx, locationId: string): Promise<StoredTarget[]> {
  const rows = await tx
    .select()
    .from(qualityIndicatorTarget)
    .where(
      and(
        isNull(qualityIndicatorTarget.deletedAt),
        or(
          eq(qualityIndicatorTarget.locationId, locationId),
          isNull(qualityIndicatorTarget.locationId),
        ),
      ),
    );
  return rows.map((r) => ({
    locationId: r.locationId,
    indicatorKey: r.indicatorKey,
    green: Number(r.green),
    amber: Number(r.amber),
  }));
}

interface Figures {
  readonly input: IndicatorInput;
  readonly period: { readonly from: string; readonly to: string };
}

/**
 * Rules 38 and 39: each built indicator's numerator, denominator, period and coverage. A period
 * counts in full only when it is over and wholly after the location started using Harbour.
 */
function figuresFor(
  key: QualityIndicatorKey,
  counts: IndicatorCounts,
  period: { readonly from: string; readonly to: string },
): Figures | null {
  // Over, wholly after the location started recording in Harbour, and no downtime still to be
  // reconciled (rule 38; the function gives the start and the outages).
  const complete =
    daysBetween(counts.since, period.from) >= 0 &&
    daysBetween(period.to, counts.today) > 0 &&
    counts.openOutages === 0;
  const coverage = complete ? 1 : 0;
  const over = (numerator: number, denominator: number): Figures => ({
    input: { numerator, denominator, coverage },
    period,
  });
  switch (key) {
    case "falls":
      return over(counts.falls, counts.bedDays);
    case "pressure_ulcers":
      return over(counts.pressureUlcers, counts.bedDays);
    case "medication_errors":
      return over(counts.medicationErrors, counts.bedDays);
    case "incident_response":
      return over(counts.incidentsReviewedInTime, counts.incidentsDecided);
    case "overdue_reviews":
      // As at today, whatever the period: today's figure is complete.
      return {
        input: { numerator: counts.reviewsOverdue, denominator: counts.reviewsDue, coverage: 1 },
        period: { from: counts.today, to: counts.today },
      };
    default:
      return null;
  }
}

export function dashboardOut(
  rates: QualityPhase2Rates,
  counts: IndicatorCounts,
  targets: readonly StoredTarget[],
  locationId: string,
  period: { readonly from: string; readonly to: string },
) {
  return phase2Indicators(rates).map((definition: IndicatorDefinition) => {
    const key = definition.key as QualityIndicatorKey;
    const figures = figuresFor(key, counts, period);
    const own = targets.find((t) => t.indicatorKey === key && t.locationId === locationId);
    const organisation = targets.find((t) => t.indicatorKey === key && t.locationId === null);
    const chosen = own ?? organisation ?? null;
    const target = chosen ? { green: chosen.green, amber: chosen.amber } : null;
    const result = dashboardIndicator(
      definition,
      figures?.input ?? { numerator: null, denominator: null, coverage: 0 },
      target,
      {
        minGroupSize: rates.minGroupSize,
        built: figures !== null && INDICATOR_SOURCES[key] !== null,
      },
    );
    return {
      key,
      title: definition.title,
      unit: definition.unit,
      direction: definition.direction,
      multiplier: definition.multiplier,
      method: result.method,
      source: INDICATOR_SOURCES[key],
      numerator: result.numerator,
      denominator: result.denominator,
      period: figures?.period ?? period,
      value: result.value,
      display: result.display,
      status: result.status,
      reasonCode: result.reasonCode,
      reason: result.reason,
      target: chosen
        ? {
            green: chosen.green,
            amber: chosen.amber,
            // Shown beside a location's own target, so an override is never read alone.
            organisationDefault:
              own && organisation ? { green: organisation.green, amber: organisation.amber } : null,
            level: own ? ("location" as const) : ("organisation" as const),
          }
        : null,
    };
  });
}

/** Rule 43: the last 12 whole calendar months, so the figures do not move day by day. */
export function pirPeriod(today: string): { from: string; to: string } {
  const to = addDays(`${today.slice(0, 7)}-01`, -1);
  const year = Number(to.slice(0, 4));
  const month = Number(to.slice(5, 7));
  const fromMonth = month === 12 ? 1 : month + 1;
  const fromYear = month === 12 ? year : year - 1;
  return { from: `${fromYear}-${String(fromMonth).padStart(2, "0")}-01`, to };
}

export function pirOut(
  counts: IndicatorCounts,
  period: { readonly from: string; readonly to: string },
  minGroupSize: number,
) {
  // A count from a year Harbour was not in use for in full is not the year's count (rule 38).
  const whole = daysBetween(counts.since, period.from) >= 0 && counts.openOutages === 0;
  const count = (value: number): PirValue | null =>
    whole ? { value, asOf: period.to, records: value } : null;
  const values: Record<string, PirValue | null> = {
    incidents: count(counts.incidents),
    medication_errors: count(counts.medicationErrors),
    // No care notes is not "no": it is no data.
    digital_care_records:
      counts.careNotes > 0 ? { value: true, asOf: period.to, records: counts.careNotes } : null,
  };
  // A small number of records behind a yes is withheld too (rule 40; security review L1).
  const records = (value: PirValue | null) =>
    value && value.records >= 1 && value.records < minGroupSize ? null : (value?.records ?? null);
  return {
    questionSet: { ...PIR_QUESTION_SET },
    period,
    asOf: period.to,
    items: pirPrefill(values, { minGroupSize }).map((item) => ({
      key: item.dataPoint.key,
      area: item.dataPoint.area,
      label: item.dataPoint.label,
      unit: item.dataPoint.unit,
      source: item.dataPoint.source,
      status: item.status,
      value: item.value?.value ?? null,
      asOf: item.value?.asOf ?? null,
      records: records(item.value),
      reasonCode: item.reasonCode,
      reason: item.reason,
    })),
  };
}
