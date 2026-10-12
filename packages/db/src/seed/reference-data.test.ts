import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  findOverlaps,
  parseBankHolidays,
  parseRates,
  parseRetention,
  ReferenceDataError,
} from "./reference-data";

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
    // A device turns these into one sync bucket per day: 1 to 31 whole days only (L3).
    ["| mobile.offline_window_days | 0 | days | 2000-01-01 | - | all | s | verified |", /1 to 31/],
    ["| mobile.offline_window_days | 32 | days | 2000-01-01 | - | all | s | verified |", /1 to 31/],
    [
      "| mobile.offline_window_days | 7.5 | days | 2000-01-01 | - | all | s | verified |",
      /1 to 31/,
    ],
    ["| mobile.offline_window_days | 7 | hours | 2000-01-01 | - | all | s | verified |", /1 to 31/],
    [
      "| mobile.held_entries_max_days | 99 | days | 2000-01-01 | - | all | s | to-verify |",
      /1 to 31/,
    ],
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

describe("parseBankHolidays", () => {
  const md = (rows: string) =>
    `## Bank holidays\n\n| date | nation | name |\n| --- | --- | --- |\n${rows}\n`;

  it("parses rows", () => {
    expect(parseBankHolidays(md("| 2027-03-26 | england | Good Friday |"))).toEqual([
      { date: "2027-03-26", nation: "england", name: "Good Friday" },
    ]);
  });

  it.each([
    ["| 2027-02-30 | england | x |", /bad date/],
    ["| 27-03-26 | england | x |", /bad date/],
    ["| 2027-13-01 | england | x |", /bad date/],
    ["| 2027-03-26 | uk | x |", /unknown nation/],
    ["| 2027-03-26 | england | |", /missing name/],
    ["| 2027-03-26 | england |", /3 columns/],
    ["| 2027-03-26 | england | a |\n| 2027-03-26 | england | b |", /listed twice/],
  ])("rejects %s", (rows, message) => {
    expect(() => parseBankHolidays(md(rows))).toThrow(message);
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

  it("calendar.md lists bank holidays for every nation in every year it covers", () => {
    const rows = parseBankHolidays(readFileSync(`${docs}calendar.md`, "utf8"));
    const years = [...new Set(rows.map((r) => r.date.slice(0, 4)))].sort();
    expect(years.length).toBeGreaterThanOrEqual(3);
    for (const nation of ["england", "wales", "scotland", "northern_ireland"]) {
      for (const year of years) {
        const count = rows.filter((r) => r.nation === nation && r.date.startsWith(year)).length;
        // Every UK nation has at least eight bank holidays a year.
        expect(count, `${nation} ${year}`).toBeGreaterThanOrEqual(8);
      }
    }
    // England and Wales share one list.
    const dates = (nation: string) =>
      rows
        .filter((r) => r.nation === nation)
        .map((r) => r.date)
        .join();
    expect(dates("wales")).toBe(dates("england"));
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
