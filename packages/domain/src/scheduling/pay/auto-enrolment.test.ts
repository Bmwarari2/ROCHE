import { describe, expect, it } from "vitest";
import { readRateTable } from "../../../test/rate-table";
import { autoEnrolmentCategory, qualifyingEarningsPence } from "./auto-enrolment";
import { resolvePayRates } from "./rates";

const r = resolvePayRates(readRateTable(), "england", "2026-10-31", null);

describe("auto-enrolment flags (scheduling.md 4b rule 7)", () => {
  it.each([
    [
      "eligible: over the trigger, in the age band",
      r.aeEligibleMinAge,
      false,
      r.aeTriggerWeekly + 1,
      "eligible_jobholder",
    ],
    [
      "on the trigger exactly is not over it",
      r.aeEligibleMinAge,
      false,
      r.aeTriggerWeekly,
      "non_eligible_jobholder",
    ],
    [
      "too young to be eligible",
      r.aeEligibleMinAge - 1,
      false,
      r.aeTriggerWeekly + 1,
      "non_eligible_jobholder",
    ],
    ["past state pension age", 67, true, r.aeTriggerWeekly + 1, "non_eligible_jobholder"],
    [
      "between the lower level and the trigger",
      30,
      false,
      r.aeLowerWeekly + 1,
      "non_eligible_jobholder",
    ],
    ["at or below the lower level", 30, false, r.aeLowerWeekly, "entitled_worker"],
    ["under the minimum age", r.aeMinAge - 1, false, r.aeTriggerWeekly + 1, "outside_age_range"],
    ["over the maximum age", r.aeMaxAge + 1, true, r.aeTriggerWeekly + 1, "outside_age_range"],
  ] as const)("weekly: %s", (_, age, spa, earnings, category) => {
    expect(
      autoEnrolmentCategory(
        { age, reachedStatePensionAge: spa, earningsPence: earnings, period: "weekly" },
        r,
      ),
    ).toBe(category);
  });

  it("uses the monthly thresholds for a monthly period", () => {
    expect(
      autoEnrolmentCategory(
        {
          age: 30,
          reachedStatePensionAge: false,
          earningsPence: r.aeTriggerMonthly + 1,
          period: "monthly",
        },
        r,
      ),
    ).toBe("eligible_jobholder");
    expect(
      autoEnrolmentCategory(
        {
          age: 30,
          reachedStatePensionAge: false,
          earningsPence: r.aeTriggerWeekly + 1,
          period: "monthly",
        },
        r,
      ),
    ).toBe("entitled_worker");
  });

  it.each([
    [0, "weekly", 0],
    [r.aeLowerWeekly + 500, "weekly", 500],
    [r.aeUpperWeekly + 10_000, "weekly", r.aeUpperWeekly - r.aeLowerWeekly],
    [r.aeLowerMonthly + 100, "monthly", 100],
  ] as const)("qualifying earnings for %ip %s: %ip", (earnings, period, expected) => {
    expect(qualifyingEarningsPence(earnings, period, r)).toBe(expected);
  });
});
