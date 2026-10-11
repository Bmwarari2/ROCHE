import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findOverlaps, parseRates, parseRetention, ReferenceDataError } from "./reference-data";

const RATES = `
# Rates

## Rate table

| key | value | unit | valid_from | valid_to | nation | source | status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| nmw.hourly.21_plus | 12.71 | GBP_per_hour | 2026-04-01 | - | uk | gov.uk | verified |
| nmw.hourly.21_plus | 12.21 | GBP_per_hour | 2025-04-01 | 2026-03-31 | uk | gov.uk | verified |

Notes follow.
`;

const RETENTION = `
## Retention schedule

| record_class | period | unit | trigger | source | notes |
| --- | --- | --- | --- | --- | --- |
| care_record | 8 | years | care_ended | Records Code | - |
| cctv | 0 | months | tenant_policy | Tenant policy | Set locally |
`;

describe("parseRates", () => {
  it("parses rows and converts the inclusive end date to an exclusive one", () => {
    expect(parseRates(RATES)).toEqual([
      {
        key: "nmw.hourly.21_plus",
        value: "12.71",
        unit: "GBP_per_hour",
        nation: "uk",
        validFrom: "2026-04-01",
        validTo: null,
        source: "gov.uk",
        verificationStatus: "verified",
      },
      {
        key: "nmw.hourly.21_plus",
        value: "12.21",
        unit: "GBP_per_hour",
        nation: "uk",
        validFrom: "2025-04-01",
        validTo: "2026-04-01",
        source: "gov.uk",
        verificationStatus: "verified",
      },
    ]);
  });

  it.each([
    ["| Bad Key | 1 | x | 2026-01-01 | - | uk | s | verified |", /bad key/],
    ["| a.b | £1 | x | 2026-01-01 | - | uk | s | verified |", /not a number/],
    ["| a.b | 1 | x | 01/01/2026 | - | uk | s | verified |", /valid_from/],
    ["| a.b | 1 | x | 2026-01-01 | soon | uk | s | verified |", /valid_to/],
    ["| a.b | 1 | x | 2026-01-01 | - | france | s | verified |", /nation/],
    ["| a.b | 1 | x | 2026-01-01 | - | uk | s | guessed |", /status/],
    ["| a.b | 1 |  | 2026-01-01 | - | uk | s | verified |", /unit/],
    ["| a.b | 1 | x | 2026-01-01 | - | uk |", /8 columns/],
  ])("rejects %s", (row, message) => {
    const md = `## Rate table\n\n| h |\n| - |\n${row}\n`;
    expect(() => parseRates(md)).toThrow(message);
  });

  it("requires the heading and a table", () => {
    expect(() => parseRates("# nothing")).toThrow(ReferenceDataError);
    expect(() => parseRates("## Rate table\n\nNo table here\n## Next")).toThrow(/No table/);
  });
});

describe("parseRetention", () => {
  it("parses rows", () => {
    expect(parseRetention(RETENTION)).toEqual([
      {
        recordClass: "care_record",
        period: 8,
        unit: "years",
        trigger: "care_ended",
        source: "Records Code",
        notes: null,
      },
      {
        recordClass: "cctv",
        period: 0,
        unit: "months",
        trigger: "tenant_policy",
        source: "Tenant policy",
        notes: "Set locally",
      },
    ]);
  });

  it.each([
    ["| Care Record | 8 | years | care_ended | s | - |", /bad class/],
    ["| a | eight | years | care_ended | s | - |", /whole number/],
    ["| a | 8 | decades | care_ended | s | - |", /bad unit/],
    ["| a | 8 | years | whenever | s | - |", /unknown trigger/],
    ["| a | 8 | years |", /6 columns/],
  ])("rejects %s", (row, message) => {
    const md = `## Retention schedule\n\n| h |\n| - |\n${row}\n`;
    expect(() => parseRetention(md)).toThrow(message);
  });
});

describe("findOverlaps", () => {
  it("reports overlapping periods for the same key and nation", () => {
    const rows = parseRates(RATES);
    expect(findOverlaps(rows)).toEqual([]);
    expect(findOverlaps([...rows, { ...rows[0], validFrom: "2026-06-01" } as never])).toHaveLength(
      1,
    );
  });
});

describe("the real documents", () => {
  const docs = fileURLToPath(new URL("../../../../docs/specs/", import.meta.url));

  it("rates.md parses with no overlapping periods", () => {
    const rows = parseRates(readFileSync(`${docs}rates.md`, "utf8"));
    expect(rows.length).toBeGreaterThan(20);
    expect(findOverlaps(rows)).toEqual([]);
  });

  it("retention.md parses and covers the section 5.1 classes", () => {
    const rows = parseRetention(readFileSync(`${docs}retention.md`, "utf8"));
    const classes = rows.map((r) => r.recordClass);
    for (const required of [
      "care_record",
      "mar_chart",
      "controlled_drugs_register",
      "complaint",
      "serious_incident",
      "riddor_report",
      "training_record",
      "rota_and_timesheet",
      "working_time_record",
      "financial_record",
    ]) {
      expect(classes).toContain(required);
    }
  });
});
