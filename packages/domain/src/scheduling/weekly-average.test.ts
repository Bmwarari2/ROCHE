import { describe, expect, it } from "vitest";
import {
  ADULT,
  CARE_HOME,
  check,
  findingsFor,
  HOUR,
  pattern,
  tableWorkingTimeRates,
  uk,
} from "../../test/working-time";
import type { ExcludedDay } from "./working-time-types";

const rates = tableWorkingTimeRates();
const limit = rates.weeklyMaxHours * HOUR;

// A 17-week reference period ending on Sunday 1 November 2026 starts on Monday 6 July.
const TEN_HOUR_WEEKDAYS = pattern(
  "d",
  "2026-07-06",
  "2026-11-06",
  [1, 2, 3, 4, 5],
  "08:00",
  "18:00",
);

function leaveWeek(reason: ExcludedDay["reason"]): ExcludedDay[] {
  return ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07"].map((date) => ({
    date,
    reason,
  }));
}

const WITHOUT_LEAVE_WEEK = TEN_HOUR_WEEKDAYS.filter((p) => !/2026-08-0[3-7]$/.test(p.id));

describe("the 48-hour average, (A + B) / C (reg 4(6); scheduling.md rule 1)", () => {
  it("is over the limit at 50 hours a week across the reference period", () => {
    const report = check(TEN_HOUR_WEEKDAYS, { on: "2026-11-01" });
    expect(report.weeklyAverage).toMatchObject([
      { from: "2026-07-06", to: "2026-11-01", weeks: rates.referencePeriodWeeks, status: "over" },
    ]);
    expect(report.weeklyAverage[0]?.averageMinutes).toBe(50 * HOUR);
    expect(findingsFor(report, "weekly_average")).toMatchObject([
      { outcome: "breach", limitMinutes: limit, actualMinutes: 50 * HOUR, basis: null },
    ]);
  });

  it("allows exactly the limit (it may not be exceeded)", () => {
    const fortyEight = pattern("d", "2026-07-06", "2026-11-01", [1, 2, 3, 4], "08:00", "20:00");
    const report = check(fortyEight, { on: "2026-11-01" });
    expect(report.weeklyAverage[0]?.averageMinutes).toBe(limit);
    expect(report.weeklyAverage[0]?.status).toBe("within");
    expect(findingsFor(report, "weekly_average")).toEqual([]);
  });

  it.each<ExcludedDay["reason"]>([
    "annual_leave",
    "sick_leave",
    "maternity_leave",
    "paternity_leave",
    "adoption_leave",
    "parental_leave",
  ])(
    "makes up %s days from the days worked after the period, never counting them as zero",
    (reason) => {
      const report = check(WITHOUT_LEAVE_WEEK, {
        on: "2026-11-01",
        excludedDays: leaveWeek(reason),
      });
      const [window] = report.weeklyAverage;
      expect(window).toMatchObject({
        workedMinutes: 800 * HOUR,
        excludedDays: 5,
        followingDays: 5,
        followingMinutes: 50 * HOUR,
        complete: true,
        status: "over",
      });
      // Counting the leave as zero hours would have shown 47 hours and hidden the breach.
      expect((window?.workedMinutes ?? 0) / rates.referencePeriodWeeks).toBeLessThan(limit);
    },
  );

  it("is provisional until the days standing in for leave are known, unless already over", () => {
    const report = check(WITHOUT_LEAVE_WEEK, {
      on: "2026-11-01",
      excludedDays: leaveWeek("annual_leave"),
      known: { start: uk("2026-01-01 00:00"), end: uk("2026-11-02 00:00") },
    });
    expect(report.weeklyAverage[0]).toMatchObject({
      followingDays: 0,
      complete: false,
      status: "provisional",
    });
    expect(findingsFor(report, "weekly_average")).toEqual([]);
    const over = check(TEN_HOUR_WEEKDAYS, {
      on: "2026-11-01",
      known: { start: uk("2026-01-01 00:00"), end: uk("2026-10-01 00:00") },
    });
    expect(over.weeklyAverage[0]).toMatchObject({ complete: false, status: "over" });
  });

  it("does not apply while an opt-out is in force for the whole period", () => {
    const optedOut = {
      ...ADULT,
      optOuts: [{ signedOn: "2026-01-05", endsOn: null, noticePeriod: null, noticeGivenOn: null }],
    };
    const report = check(TEN_HOUR_WEEKDAYS, { on: "2026-11-01", worker: optedOut });
    expect(report.weeklyAverage[0]?.status).toBe("opted_out");
    expect(findingsFor(report, "weekly_average")).toEqual([]);
  });

  it("treats days under an opt-out as excluded days, replaced by later days", () => {
    const withdrew = {
      ...ADULT,
      optOuts: [
        { signedOn: "2026-01-05", endsOn: null, noticePeriod: null, noticeGivenOn: "2026-10-12" },
      ],
    };
    const report = check(TEN_HOUR_WEEKDAYS, { on: "2026-11-01", worker: withdrew });
    // 6 July to 12 October is 99 days; the opt-out runs on for the notice period after that.
    const lastOptedOut = new Date("2026-10-12T00:00:00Z");
    lastOptedOut.setUTCDate(lastOptedOut.getUTCDate() + rates.optOutDefaultNoticeDays);
    const lastDay = lastOptedOut.toISOString().split("T")[0] as string;
    const hoursAfter = TEN_HOUR_WEEKDAYS.filter((p) => {
      const date = p.id.slice(2);
      return date > lastDay && date <= "2026-11-01";
    }).length;
    expect(report.weeklyAverage[0]).toMatchObject({
      excludedDays: 99 + rates.optOutDefaultNoticeDays,
      workedMinutes: hoursAfter * 10 * HOUR,
      complete: false,
      status: "provisional",
    });
  });

  it("uses the time since starting work while service is shorter than the period", () => {
    const starter = { ...ADULT, employmentStart: "2026-10-05" };
    const twelveHours = pattern("s", "2026-10-05", "2026-10-18", [1, 2, 3, 4, 5], "08:00", "20:00");
    const report = check(twelveHours, { on: "2026-10-17", to: "2026-10-18", worker: starter });
    expect(report.weeklyAverage).toMatchObject([
      { from: "2026-10-05", to: "2026-10-18", weeks: 2, averageMinutes: 60 * HOUR, status: "over" },
    ]);
  });

  it("averages over the longer special-case period in a care home (reg 4(5))", () => {
    const fortyHours = pattern("e", "2026-05-04", "2026-07-05", [1, 2, 3, 4], "08:00", "18:00");
    const periods = [...fortyHours, ...TEN_HOUR_WEEKDAYS];
    const standard = check(periods, { on: "2026-11-01" });
    expect(standard.weeklyAverage[0]?.status).toBe("over");
    const careHome = check(periods, { on: "2026-11-01", setting: CARE_HOME });
    expect(careHome.weeklyAverage).toMatchObject([
      { from: "2026-05-04", to: "2026-11-01", weeks: rates.specialCaseReferencePeriodWeeks },
    ]);
    expect(careHome.weeklyAverage[0]?.averageMinutes).toBe(((9 * 40 + 17 * 50) / 26) * HOUR);
    expect(findingsFor(careHome, "weekly_average")).toEqual([]);
  });

  it("uses successive periods from an agreement's date instead of rolling ones", () => {
    const setting = { ...CARE_HOME, successiveReferencePeriodsFrom: "2026-01-05", derogations: [] };
    const report = check(TEN_HOUR_WEEKDAYS, { on: "2026-11-01", to: "2026-11-03", setting });
    expect(report.weeklyAverage.map((w) => [w.from, w.to])).toEqual([["2026-08-31", "2026-12-27"]]);
  });

  it("reports a run of over-limit rolling periods once", () => {
    const report = check(TEN_HOUR_WEEKDAYS, { on: "2026-11-01", to: "2026-11-03" });
    expect(report.weeklyAverage).toHaveLength(3);
    const findings = findingsFor(report, "weekly_average");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.from).toEqual(uk("2026-07-06 00:00"));
    expect(findings[0]?.to).toEqual(uk("2026-11-04 00:00"));
  });
});
