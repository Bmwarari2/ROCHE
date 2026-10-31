/**
 * Whole-pence arithmetic and the working every pay result carries (ADR-0086). Percentages are
 * applied once and rounded down to the penny, so nobody is shown more than a rule gives; the
 * rounding is said in the working.
 */

/** `percent` of an amount in pence, rounded down to the penny. */
export function percentOf(pence: number, percent: number): number {
  // Basis points avoid binary fractions: 12.07% is 1207 basis points.
  const basisPoints = Math.round(percent * 100);
  return Math.floor((pence * basisPoints) / 10_000);
}

/** "£1,234.56" for the working: British format, two decimals. */
export function formatPounds(pence: number): string {
  const sign = pence < 0 ? "-" : "";
  const abs = Math.abs(pence);
  const pounds = Math.floor(abs / 100).toLocaleString("en-GB");
  return `${sign}£${pounds}.${String(abs % 100).padStart(2, "0")}`;
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
