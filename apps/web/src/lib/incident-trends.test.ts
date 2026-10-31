import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import { monthLabel, trendMonths, trendsLimited, trendTable } from "./incident-trends";
import { INCIDENT_LIST_LIMIT } from "./incidents";

const t = createTranslator("en-GB");

describe("trendMonths", () => {
  it("gives the last six UK calendar months, oldest first, bounded at UK midnight", () => {
    const months = trendMonths(new Date("2026-10-31T12:00:00Z"));
    expect(months.map((m) => m.key)).toEqual([
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
      "2026-10",
    ]);
    // Summer time: midnight in the UK is 23:00 the day before in UTC.
    expect(months[0]?.from).toBe("2026-04-30T23:00:00.000Z");
    // The clocks went back on 25 October: November starts at midnight GMT.
    expect(months[5]).toMatchObject({
      from: "2026-09-30T23:00:00.000Z",
      to: "2026-11-01T00:00:00.000Z",
    });
  });

  it("crosses the year, and takes the UK date, not UTC's, late on the last evening of a month", () => {
    expect(trendMonths(new Date("2027-02-10T12:00:00Z"), 3).map((m) => m.key)).toEqual([
      "2026-12",
      "2027-01",
      "2027-02",
    ]);
    // 23:30 UTC on 31 May is 00:30 on 1 June in the UK.
    expect(trendMonths(new Date("2026-05-31T23:30:00Z"), 1)[0]?.key).toBe("2026-06");
  });

  it("names a month in words", () => {
    expect(monthLabel({ year: 2026, month: 10 }, t)).toBe("October 2026");
    expect(monthLabel({ year: 2027, month: 1 }, t)).toBe("January 2027");
  });
});

describe("trendsLimited (review L4)", () => {
  it("hazard HZ-073 tells a reader who sees only their own people that counts leave some out", () => {
    expect(trendsLimited("assigned")).toBe(true);
    expect(trendsLimited("none")).toBe(true);
    expect(trendsLimited("locations")).toBe(false);
    expect(trendsLimited("tenant")).toBe(false);
    expect(t("safety.trends.capped", { limit: 500 })).toContain("500 or more");
  });
});

describe("trendTable", () => {
  const months = trendMonths(new Date("2026-10-31T12:00:00Z"), 2);
  const of = (...types: string[]) => types.map((type) => ({ type })) as never[];

  it("hazard HZ-073 counts by type and month, the most first, with a row of totals", () => {
    const table = trendTable(
      months,
      [of("fall", "fall", "medication"), of("fall", "near_miss")],
      t,
    );
    expect(table.rows.map((r) => [r.label, r.counts, r.total])).toEqual([
      ["Fall", [2, 1], 3],
      ["Medication incident", [1, 0], 1],
      ["Near miss", [0, 1], 1],
    ]);
    expect(table.total).toMatchObject({ label: "Total", counts: [3, 2], total: 5 });
    expect(table.capped).toEqual([]);
  });

  it("hazard HZ-073 names a month whose read reached the API's limit, so it is said as at least", () => {
    const full = Array.from({ length: INCIDENT_LIST_LIMIT }, () => ({ type: "fall" })) as never[];
    expect(trendTable(months, [[], full], t).capped).toEqual(["2026-10"]);
    expect(t("safety.trends.atLeast", { count: 500 })).toBe("500 or more");
  });

  it("is empty with nothing recorded", () => {
    const table = trendTable(months, [[], []], t);
    expect(table.rows).toEqual([]);
    expect(table.total.total).toBe(0);
  });
});
