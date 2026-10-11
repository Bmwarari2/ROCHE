/**
 * Statutory figures lookup (section 18). Application code never contains a rate or threshold; it
 * asks for one by key, nation and date. A tenant override wins over the global row; a nation row
 * wins over a `uk` row, which wins over an `all` row. Unverified figures are flagged so screens
 * can say so.
 */

export type RateNation = "england" | "wales" | "scotland" | "northern_ireland" | "uk" | "all";

export interface RateRow {
  readonly key: string;
  readonly value: string | number;
  readonly unit: string;
  readonly nation: string;
  /** ISO date (yyyy-mm-dd), inclusive. */
  readonly validFrom: string;
  /** ISO date, exclusive; null for open-ended. */
  readonly validTo: string | null;
  readonly tenantId: string | null;
  readonly verificationStatus: string;
  readonly source: string;
}

export interface ResolvedRate {
  readonly key: string;
  readonly value: number;
  readonly unit: string;
  readonly nation: string;
  readonly verified: boolean;
  readonly source: string;
  readonly tenantOverride: boolean;
}

export class RateNotFoundError extends Error {
  constructor(key: string, nation: string, on: string) {
    super(`No rate for ${key} (${nation}) on ${on}`);
    this.name = "RateNotFoundError";
  }
}

const NATION_PRIORITY = (nation: string, requested: string): number => {
  if (nation === requested) return 3;
  if (nation === "uk") return 2;
  if (nation === "all") return 1;
  return 0;
};

/** Statuses that count as verified for display: confirmed on an official page or set in policy. */
const VERIFIED_STATUSES = new Set(["verified", "master-prompt", "tenant"]);

export function resolveRate(
  rows: readonly RateRow[],
  key: string,
  nation: Exclude<RateNation, "uk" | "all">,
  on: string,
  tenantId: string | null,
): ResolvedRate {
  const candidates = rows.filter(
    (r) =>
      r.key === key &&
      NATION_PRIORITY(r.nation, nation) > 0 &&
      r.validFrom <= on &&
      (r.validTo === null || r.validTo > on) &&
      (r.tenantId === null || r.tenantId === tenantId),
  );
  candidates.sort((a, b) => {
    const tenantDiff = Number(b.tenantId !== null) - Number(a.tenantId !== null);
    if (tenantDiff !== 0) return tenantDiff;
    return NATION_PRIORITY(b.nation, nation) - NATION_PRIORITY(a.nation, nation);
  });
  const best = candidates[0];
  if (!best) throw new RateNotFoundError(key, nation, on);
  return {
    key: best.key,
    value: Number(best.value),
    unit: best.unit,
    nation: best.nation,
    verified: VERIFIED_STATUSES.has(best.verificationStatus),
    source: best.source,
    tenantOverride: best.tenantId !== null,
  };
}

/**
 * The rate-table figures the platform completion rules read (platform-completions.md, rates.md).
 * Policy values, not statutory figures: the agency post-shift window (master prompt 4), how long a
 * ready export stays downloadable, the yearly DPIA review and the contractual sub-processor
 * notice. Callers resolve them once per request (tenant override first) and pass them in.
 */
export const PLATFORM_RATE_KEYS = {
  agencyPostShiftHours: "access.agency.post_shift_hours",
  exportLinkExpiryHours: "export.link_expiry_hours",
  dpiaReviewIntervalMonths: "dpia.review_interval_months",
  subProcessorNoticeDays: "sub_processor.notice_days",
} as const;

export type PlatformRateName = keyof typeof PLATFORM_RATE_KEYS;

export type PlatformRates = { readonly [K in PlatformRateName]: number };

/** Resolves every platform figure for a tenant on a date; fails loudly if one is missing. */
export function resolvePlatformRates(
  rows: readonly RateRow[],
  nation: Exclude<RateNation, "uk" | "all">,
  on: string,
  tenantId: string | null,
): PlatformRates {
  const entries = (Object.keys(PLATFORM_RATE_KEYS) as PlatformRateName[]).map(
    (name) =>
      [name, resolveRate(rows, PLATFORM_RATE_KEYS[name], nation, on, tenantId).value] as const,
  );
  return Object.fromEntries(entries) as PlatformRates;
}
