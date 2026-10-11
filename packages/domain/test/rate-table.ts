/// <reference types="node" />
/**
 * Test support: reads the real rate table in docs/specs/rates.md so tests assert against the table,
 * never against a literal copy of a figure (section 7, section 20). The seed parser in packages/db
 * validates the file; this reader only needs the rows.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type DolsNation, type DolsRates, resolveDolsRates } from "../src/care/mca/dols";
import { type CareRates, resolveCareRates } from "../src/care/rates";
import { type OperationsRates, resolveOperationsRates } from "../src/operations/rates";
import type { RateRow } from "../src/platform/rates";
import {
  type EvidencePackPolicy,
  resolveEvidencePackPolicy,
  resolveStatementOfPurposeRates,
  type StatementOfPurposeRates,
} from "../src/quality/rates";
import { resolveSafetyRates, type SafetyRates } from "../src/safety/rates";

const RATES_PATH = fileURLToPath(new URL("../../../docs/specs/rates.md", import.meta.url));

function dayAfter(isoDate: string): string {
  const next = new Date(`${isoDate}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

export function readRateTable(): RateRow[] {
  const markdown = readFileSync(RATES_PATH, "utf8");
  const section = markdown.split("\n## Rate table\n")[1]?.split("\n## ")[0] ?? "";
  const lines = section.split("\n").filter((line) => line.startsWith("|"));
  return lines.slice(2).map((line) => {
    const [key, value, unit, validFrom, validTo, nation, source, status] = line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim()) as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    return {
      key,
      value,
      unit,
      nation,
      validFrom,
      validTo: validTo === "-" ? null : dayAfter(validTo),
      tenantId: null,
      verificationStatus: status,
      source,
    };
  });
}

/** The care figures for an English location on the day the tests describe. */
export function tableCareRates(on = "2026-10-11"): CareRates {
  return resolveCareRates(readRateTable(), "england", on, null);
}

const CALENDAR_PATH = fileURLToPath(new URL("../../../docs/specs/calendar.md", import.meta.url));

/** The bank holidays for a nation from docs/specs/calendar.md (the seed's source). */
export function tableBankHolidays(nation: string): ReadonlySet<string> {
  const markdown = readFileSync(CALENDAR_PATH, "utf8");
  const dates = markdown
    .split("\n")
    .map((line) => line.split("|").map((cell) => cell.trim()))
    .filter((cells) => cells[2] === nation && /^\d{4}-\d{2}-\d{2}$/.test(cells[1] ?? ""))
    .map((cells) => cells[1] as string);
  return new Set(dates);
}

/** The safety figures (classifier, clocks, outbreaks, falls) for an English location. */
export function tableSafetyRates(on = "2026-10-11"): SafetyRates {
  return resolveSafetyRates(readRateTable(), "england", on, null);
}

/** The DoLS figures for a location in England or Wales. */
export function tableDolsRates(nation: DolsNation = "england", on = "2026-10-11"): DolsRates {
  return resolveDolsRates(readRateTable(), nation, on, null);
}

/** The downtime pack and back-entry figures for an English location. */
export function tableOperationsRates(on = "2026-10-11"): OperationsRates {
  return resolveOperationsRates(readRateTable(), "england", on, null);
}

const RETENTION_PATH = fileURLToPath(new URL("../../../docs/specs/retention.md", import.meta.url));

/** One row of the retention schedule in docs/specs/retention.md (the seed's source). */
export function tableRetentionRule(recordClass: string): {
  readonly period: number;
  readonly unit: "years" | "months";
} {
  const row = readFileSync(RETENTION_PATH, "utf8")
    .split("\n")
    .find((line) => line.startsWith(`| ${recordClass} |`));
  const cells = row?.split("|").map((c) => c.trim()) ?? [];
  if (!row) throw new Error(`No retention row for ${recordClass}`);
  return { period: Number(cells[2]), unit: cells[3] as "years" | "months" };
}

/** The evidence pack link policy (tenant defaults) for an English location. */
export function tableEvidencePackPolicy(on = "2026-10-11"): EvidencePackPolicy {
  return resolveEvidencePackPolicy(readRateTable(), "england", on, null);
}

/** The statement of purpose figures (England). */
export function tableStatementOfPurposeRates(on = "2026-10-11"): StatementOfPurposeRates {
  return resolveStatementOfPurposeRates(readRateTable(), "england", on, null);
}
