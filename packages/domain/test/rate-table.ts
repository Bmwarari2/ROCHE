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
import type { RateRow } from "../src/platform/rates";

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

/** The DoLS figures for a location in England or Wales. */
export function tableDolsRates(nation: DolsNation = "england", on = "2026-10-11"): DolsRates {
  return resolveDolsRates(readRateTable(), nation, on, null);
}
