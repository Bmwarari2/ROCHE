import { type HrPayUnit, type HrRate, outboundProblems, realDay } from "./thapsus-hr";

/**
 * Pay through Thapsus-HR (integrations.md section 11.5 rules 11 and 12; slice 89; ADR-0131;
 * HZ-133, HZ-140). Thapsus-HR's pay periods become the pay reference periods; its hourly rates are
 * read only for the minimum wage check; Harbour sends units by pay code, never money. Pure rules,
 * no I/O.
 */

const IDENT = /^[A-Za-z0-9_-]{1,64}$/;
/** The most days a pay run may span (`pay_run_period`: at most 30 days apart). */
const MAX_PERIOD_DAYS = 31;
/** The highest hourly rate taken as real (pence); anything above is refused, not trusted. */
export const HR_RATE_MAX_PENCE = 100_000;

/** A unit kind this product sends: paid hours by enhancement, and counted items. */
export const PAY_UNIT_KIND =
  /^(hours(_(bank_holiday|night|overtime|weekend))*|sleep_in|on_call|mileage)$/;
/** A tenant's pay code in Thapsus-HR. */
export const PAY_CODE = /^[A-Za-z0-9_.-]{1,32}$/;

export interface HrPayPeriod {
  readonly id: string;
  readonly frequency: "weekly" | "monthly";
  readonly startsOn: string;
  readonly endsOn: string;
}

const days = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

/**
 * A pay period as it may enter Harbour: identifier, frequency and real dates only, at most 31
 * days. Anything else is refused (null) and raised, never guessed.
 */
export function inboundPayPeriod(raw: Readonly<Record<string, unknown>>): HrPayPeriod | null {
  const s = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : null);
  const id = s("id");
  const startsOn = s("startsOn");
  const endsOn = s("endsOn");
  const frequency = s("frequency");
  if (!id || !IDENT.test(id)) return null;
  if (frequency !== "weekly" && frequency !== "monthly") return null;
  if (!startsOn || !endsOn || !realDay(startsOn) || !realDay(endsOn)) return null;
  if (endsOn < startsOn || days(startsOn, endsOn) > MAX_PERIOD_DAYS) return null;
  return { id, frequency, startsOn, endsOn };
}

/** An hourly rate as it may enter Harbour: employee, whole pence and a real day only. */
export function inboundRate(raw: Readonly<Record<string, unknown>>): HrRate | null {
  const { employeeId, hourlyPence, effectiveFrom } = raw;
  if (typeof employeeId !== "string" || !IDENT.test(employeeId)) return null;
  if (
    typeof hourlyPence !== "number" ||
    !Number.isInteger(hourlyPence) ||
    hourlyPence < 1 ||
    hourlyPence > HR_RATE_MAX_PENCE
  ) {
    return null;
  }
  if (typeof effectiveFrom !== "string" || !realDay(effectiveFrom)) return null;
  return { employeeId, hourlyPence, effectiveFrom };
}

/**
 * The rate in force on a day: the latest that took effect on or before it. Null when none had, so
 * the minimum wage check stops for a person rather than guessing a rate.
 */
export function rateOn(rates: readonly HrRate[], day: string): HrRate | null {
  let best: HrRate | null = null;
  for (const r of rates) {
    if (r.effectiveFrom <= day && (best === null || r.effectiveFrom > best.effectiveFrom)) best = r;
  }
  return best;
}

/**
 * The lowest rate in force on any day of a period, for the minimum wage check (rule 11; HZ-140):
 * the rate on its first day and any that took effect during it, so a cut part-way through is never
 * missed; for a starter whose rate begins during the period, the lowest of those. Null when no rate
 * had taken effect by the period's last day.
 */
export function lowestRateIn(rates: readonly HrRate[], start: string, end: string): HrRate | null {
  const inForce = [
    rateOn(rates, start),
    ...rates.filter((r) => r.effectiveFrom > start && r.effectiveFrom <= end),
  ];
  let low: HrRate | null = null;
  for (const r of inForce) if (r && (low === null || r.hourlyPence < low.hourlyPence)) low = r;
  return low;
}

/** A pay run's period matches a Thapsus-HR pay period exactly (dates and frequency). */
export function matchesHrPayPeriod(
  run: { readonly frequency: string; readonly periodStart: string; readonly periodEnd: string },
  periods: readonly HrPayPeriod[],
): HrPayPeriod | null {
  return (
    periods.find(
      (p) =>
        p.frequency === run.frequency &&
        p.startsOn === run.periodStart &&
        p.endsOn === run.periodEnd,
    ) ?? null
  );
}

export interface MemberUnits {
  readonly employeeId: string;
  readonly units: readonly { readonly kind: string; readonly quantity: number }[];
}

export interface HrPayUnitsPlan {
  /** What goes out: one row per employee and pay code, units summed. */
  readonly units: readonly HrPayUnit[];
  /** Unit kinds with no pay code: nothing goes out until a person maps them (never dropped). */
  readonly unmapped: readonly string[];
}

/**
 * Units by pay code for a Thapsus-HR pay period (rule 11): kinds mapped to the tenant's pay codes,
 * summed per employee and code, rounded to 2 places. A kind with no pay code stops the whole
 * period, so nobody is paid short without a person knowing.
 */
export function hrPayUnits(
  payPeriodId: string,
  members: readonly MemberUnits[],
  payCodes: Readonly<Record<string, string>>,
): HrPayUnitsPlan {
  const unmapped = new Set<string>();
  const sums = new Map<string, { employeeId: string; payCode: string; units: number }>();
  for (const m of members) {
    for (const u of m.units) {
      if (!(u.quantity > 0)) continue;
      const code = Object.hasOwn(payCodes, u.kind) ? payCodes[u.kind] : undefined;
      if (!code || !PAY_CODE.test(code)) {
        unmapped.add(u.kind);
        continue;
      }
      const key = `${m.employeeId}\u0000${code}`;
      const s = sums.get(key) ?? { employeeId: m.employeeId, payCode: code, units: 0 };
      s.units += u.quantity;
      sums.set(key, s);
    }
  }
  if (unmapped.size > 0) return { units: [], unmapped: [...unmapped].sort() };
  const units = [...sums.values()]
    .sort((a, b) =>
      a.employeeId === b.employeeId
        ? a.payCode.localeCompare(b.payCode)
        : a.employeeId.localeCompare(b.employeeId),
    )
    .map((s) => ({
      employeeId: s.employeeId,
      payPeriodId,
      payCode: s.payCode,
      units: Math.round(s.units * 100) / 100,
    }));
  for (const u of units) {
    if (outboundProblems("pay_units", u).length > 0) {
      throw new Error("pay unit outside the allow-list");
    }
  }
  return { units, unmapped: [] };
}

/** Pay code mapping as a tenant sets it: known unit kinds to well-formed codes only. */
export function payCodesProblem(payCodes: Readonly<Record<string, unknown>>): string | null {
  for (const [kind, code] of Object.entries(payCodes)) {
    if (!PAY_UNIT_KIND.test(kind)) return `unknown unit kind ${kind.slice(0, 40)}`;
    if (typeof code !== "string" || !PAY_CODE.test(code)) return `pay code for ${kind}`;
  }
  return null;
}
