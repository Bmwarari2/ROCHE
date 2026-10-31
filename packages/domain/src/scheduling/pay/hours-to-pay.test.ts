import { describe, expect, it } from "vitest";
import { readRateTable } from "../../../test/rate-table";
import { ADULT, check, HOUR, shift, tableWorkingTimeRates, uk } from "../../../test/working-time";
import { nmwMinutes, nmwMinutesIn } from "../classification";
import type { WorkPeriod } from "../working-time-types";
import { youngWorkerUntil } from "../young-workers";
import { ageOn, nmwCheck, nmwPayFromGross } from "./nmw";
import { grossPay, type PayRuleSet, type TimesheetEntry } from "./pay-rules";
import { resolvePayRates } from "./rates";

/**
 * Slice 5 decides which hours count; slice 6 checks the pay for them. One weekly pay reference
 * period (Monday 2 to Sunday 8 November 2026) for a worker who visits people at home and does a
 * sleep-in, fed from the working time periods into the minimum wage check.
 */

const rates = resolvePayRates(readRateTable(), "england", "2026-11-02", null);
const PRP = { start: uk("2026-11-02 00:00"), end: uk("2026-11-09 00:00") };

const sleepIn = (suitableSleepingFacilities: boolean): WorkPeriod => ({
  ...shift("sleep", "2026-11-03 22:00", "2026-11-04 07:00"),
  kind: "sleep_in",
  sleepIn: {
    expectedToSleep: true,
    suitableSleepingFacilities,
    awake: [{ start: uk("2026-11-04 02:00"), end: uk("2026-11-04 03:00") }],
  },
});

const WEEK: WorkPeriod[] = [
  {
    ...shift("home", "2026-11-02 07:30", "2026-11-02 08:00"),
    kind: "travel",
    travel: "home_to_first_assignment",
  },
  shift("visit-1", "2026-11-02 08:00", "2026-11-02 10:00"),
  {
    ...shift("between", "2026-11-02 10:00", "2026-11-02 10:30"),
    kind: "travel",
    travel: "between_assignments",
  },
  shift("visit-2", "2026-11-02 10:30", "2026-11-02 12:30"),
  sleepIn(true),
];

const SET: PayRuleSet = {
  id: "example-care",
  version: 1,
  roleRates: { care_worker: rates.nmw21Plus },
  enhancements: [],
  stackEnhancements: false,
  sleepInFlatPence: 4_000,
  mileagePencePerMile: 45,
  onCallFlatPence: 0,
};

/** Pay for the visits and the travel between them at the role rate, the sleep-in and mileage. */
function payFor(set: PayRuleSet) {
  const entries: TimesheetEntry[] = [
    { kind: "work", role: "care_worker", minutes: 4.5 * HOUR, enhancements: [] },
    { kind: "sleep_in" },
    { kind: "mileage", miles: 12 },
  ];
  return grossPay(set, entries);
}

function check48(periods: readonly WorkPeriod[]) {
  return check(periods, { on: "2026-11-08", worker: ADULT }).weeklyAverage[0];
}

describe("slice 5's hours feed slice 6's minimum wage check", () => {
  it("counts a sleep-in in full as working time but only its awake hour for the minimum wage", () => {
    expect(check48(WEEK)?.workedMinutes).toBe((0.5 + 2 + 0.5 + 2 + 9) * HOUR);
    expect(nmwMinutes(sleepIn(true))).toBe(HOUR);
    // Visits and travel between them, plus the awake hour; never home to the first visit.
    expect(nmwMinutesIn(WEEK, PRP)).toBe((2 + 0.5 + 2 + 1) * HOUR);
  });

  it.each([
    ["the sleep-in allowance covers the awake hour", SET, true, 0],
    [
      "no sleep-in allowance leaves the awake hour unpaid",
      { ...SET, sleepInFlatPence: 0 },
      true,
      null,
    ],
    ["without suitable sleeping facilities every sleep-in hour counts", SET, false, null],
  ] as const)("%s", (_name, set, facilities, shortfall) => {
    const periods = [...WEEK.slice(0, -1), sleepIn(facilities)];
    const gross = payFor(set);
    const result = nmwCheck(
      {
        dateOfBirth: ADULT.dateOfBirth,
        periodStart: "2026-11-02",
        apprenticeshipStartedOn: null,
        minutesCounted: nmwMinutesIn(periods, PRP),
        ...nmwPayFromGross(gross),
        employerUseDeductionsPence: 0,
        accommodation: null,
      },
      rates,
    );
    const required = Math.ceil((rates.nmw21Plus * nmwMinutesIn(periods, PRP)) / HOUR);
    expect(result.requiredPence).toBe(required);
    expect(result.shortfallPence).toBe(shortfall ?? required - result.countedPayPence);
    expect(result.compliant).toBe(shortfall === 0);
  });

  it("never counts mileage, an expense, as pay for the minimum wage", () => {
    const gross = payFor(SET);
    expect(gross.mileagePence).toBe(12 * SET.mileagePencePerMile);
    expect(nmwPayFromGross(gross).payPence).toBe(gross.totalPence - gross.mileagePence);
  });

  it("counts only this employer's hours, clipped to the pay reference period", () => {
    const other = {
      ...shift("other", "2026-11-05 09:00", "2026-11-05 13:00"),
      employer: "other" as const,
    };
    const straddling = shift("late", "2026-11-08 22:00", "2026-11-09 02:00");
    expect(nmwMinutesIn([...WEEK, other, straddling], PRP)).toBe(
      nmwMinutesIn(WEEK, PRP) + 2 * HOUR,
    );
  });

  it("agrees with the young worker rules on a 29 February birthday", () => {
    const wtr = tableWorkingTimeRates();
    const leapDay = { ...ADULT, dateOfBirth: "2008-02-29" };
    expect(youngWorkerUntil(leapDay, wtr)).toEqual(uk("2026-03-01 00:00"));
    expect(ageOn(leapDay.dateOfBirth, "2026-02-28")).toBe(wtr.youngUntilAgeYears - 1);
    expect(ageOn(leapDay.dateOfBirth, "2026-03-01")).toBe(wtr.youngUntilAgeYears);
  });
});
