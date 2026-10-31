/**
 * Whole-pence arithmetic and the working every pay result carries (ADR-0086). Percentages are
 * applied once and rounded down to the penny, so nobody is shown more than a rule gives, except
 * where a regulation says a statutory payment is rounded up (SSP, maternity, paternity, adoption,
 * shared parental and parental bereavement pay): those use the exact amount, rounded up once. The
 * rounding is said in the working.
 */

// why: money units, not statutory figures (those come from the rate table).
export const PENCE_PER_POUND = 100;
/** A percentage in basis points (12.07% is 1207) avoids binary fractions. */
const BASIS_POINTS_PER_PERCENT = 100;
export const BASIS_POINTS_IN_WHOLE = BASIS_POINTS_PER_PERCENT * 100;

export function basisPoints(percent: number): number {
  return Math.round(percent * BASIS_POINTS_PER_PERCENT);
}

/** `percent` of an amount in pence, rounded down to the penny. */
export function percentOf(pence: number, percent: number): number {
  return Math.floor((pence * basisPoints(percent)) / BASIS_POINTS_IN_WHOLE);
}

/**
 * `numerator / denominator` pence rounded up to the next whole penny: a statutory payment that
 * "includes a fraction of a penny" is rounded up (for example SSP (General) Regulations 1982
 * reg 11, SMP (General) Regulations 1986 reg 28).
 */
export function roundUpPence(numerator: number, denominator: number): number {
  return Math.ceil(numerator / denominator);
}

/** "£1,234.56" for the working: British format, two decimals. */
export function formatPounds(pence: number): string {
  const sign = pence < 0 ? "-" : "";
  const abs = Math.abs(pence);
  const pounds = Math.floor(abs / PENCE_PER_POUND).toLocaleString("en-GB");
  return `${sign}£${pounds}.${String(abs % PENCE_PER_POUND).padStart(2, "0")}`;
}

/** A line of working: what was done, the figure, and the rule or rate it came from. */
export interface WorkingLine {
  readonly step: string;
  readonly pence?: number;
  readonly rateKey?: string;
}

/**
 * A deterministic serialisation of a result's inputs: keys sorted at every level, so the same
 * inputs always give the same text. The API stores its SHA-256 with the result (ADR-0086).
 */
export function canonicalInput(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value));
}
