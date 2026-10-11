/**
 * The rate-table figures the quality rules read (quality.md section 4, docs/specs/rates.md). The
 * evidence pack link figures are tenant policy defaults (nation `all`); the statement of purpose
 * notice period is statutory and England-only until the nation packs, so the two resolve
 * separately and a Welsh location can still send an evidence pack.
 */

import { type RateNation, type RateRow, resolveRate } from "../platform/rates";

type LookupNation = Exclude<RateNation, "uk" | "all">;

export const EVIDENCE_PACK_RATE_KEYS = {
  defaultLinkDays: "evidence_pack.link_expiry_days.default",
  maxLinkDays: "evidence_pack.link_expiry_days.max",
  codeValidMinutes: "evidence_pack.code_valid_minutes",
} as const;

export type EvidencePackPolicy = {
  readonly [K in keyof typeof EVIDENCE_PACK_RATE_KEYS]: number;
};

export const STATEMENT_OF_PURPOSE_RATE_KEYS = {
  revisionNoticeDays: "cqc.statement_of_purpose.revision_notice_days",
} as const;

export type StatementOfPurposeRates = {
  readonly [K in keyof typeof STATEMENT_OF_PURPOSE_RATE_KEYS]: number;
};

function resolveAll<K extends string>(
  keys: Readonly<Record<K, string>>,
  rows: readonly RateRow[],
  nation: LookupNation,
  on: string,
  tenantId: string | null,
): Readonly<Record<K, number>> {
  const entries = (Object.keys(keys) as K[]).map(
    (name) => [name, resolveRate(rows, keys[name], nation, on, tenantId).value] as const,
  );
  return Object.fromEntries(entries) as Record<K, number>;
}

/** The evidence pack link expiry default and maximum for a tenant; fails loudly if missing. */
export function resolveEvidencePackPolicy(
  rows: readonly RateRow[],
  nation: LookupNation,
  on: string,
  tenantId: string | null,
): EvidencePackPolicy {
  return resolveAll(EVIDENCE_PACK_RATE_KEYS, rows, nation, on, tenantId);
}

/** The statement of purpose figures; England only until the nation packs (fails loudly). */
export function resolveStatementOfPurposeRates(
  rows: readonly RateRow[],
  nation: LookupNation,
  on: string,
  tenantId: string | null,
): StatementOfPurposeRates {
  return resolveAll(STATEMENT_OF_PURPOSE_RATE_KEYS, rows, nation, on, tenantId);
}
