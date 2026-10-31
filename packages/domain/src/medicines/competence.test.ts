import { describe, expect, it } from "vitest";
import { tableMedicinesRates } from "../../test/rate-table";
import { addUkMonths, fromUkWallClock, ukStartOfDay } from "../shared/time";
import {
  type CompetenceOverride,
  type CompetenceProblem,
  checkCompetenceGate,
  medicinesCompetenceAt,
} from "./competence";

const rates = tableMedicinesRates();
const HOUR = 3_600_000;
const now = fromUkWallClock(2026, 11, 2, 9, 0);
const MEMBER = "member-carer";
const MANAGER = "member-manager";
const shiftStart = fromUkWallClock(2026, 11, 2, 7, 0);
const override = (overrides: Partial<CompetenceOverride> = {}): CompetenceOverride => ({
  memberId: MEMBER,
  approvedBy: MANAGER,
  reason: "Competence check booked for Friday; observed on the morning round",
  from: shiftStart,
  until: new Date(shiftStart.getTime() + rates.competenceOverrideMaxHours * HOUR),
  ...overrides,
});

describe("hazard HZ-119 medicines competence lasts the rate table's months from its sign-off", () => {
  const signedOff = "2025-11-02";
  const lapses = addUkMonths(ukStartOfDay(signedOff), rates.competenceRefreshMonths);

  it.each([
    ["the day it was signed off", ukStartOfDay(signedOff), "current"],
    ["the minute before it lapses", new Date(lapses.getTime() - 60_000), "current"],
    ["00:00 UK time on the day it lapses", lapses, "expired"],
    ["a week later", new Date(lapses.getTime() + 7 * 24 * HOUR), "expired"],
    ["before a sign-off dated later", new Date(ukStartOfDay(signedOff).getTime() - 1), "not_held"],
  ] as const)("on %s it is %s", (_name, at, state) => {
    expect(medicinesCompetenceAt(signedOff, at, rates).state).toBe(state);
  });

  it("is not held with no sign-off, and gives the time it lapses when there is one", () => {
    expect(medicinesCompetenceAt(null, now, rates)).toEqual({ state: "not_held", expiresAt: null });
    expect(medicinesCompetenceAt("01/11/2025", now, rates).state).toBe("not_held");
    expect(medicinesCompetenceAt(signedOff, now, rates).expiresAt).toEqual(lapses);
  });

  it("from 29 February lapses on the last day of February, never later", () => {
    const leap = medicinesCompetenceAt("2028-02-29", ukStartOfDay("2028-03-01"), rates);
    expect(leap.expiresAt?.getTime()).toBeLessThanOrEqual(
      addUkMonths(ukStartOfDay("2028-03-01"), rates.competenceRefreshMonths).getTime(),
    );
  });
});

describe("hazard HZ-119 expired medicines competence blocks an administration unless someone else overrides it", () => {
  it("lets a member with current competence go ahead", () => {
    expect(checkCompetenceGate(MEMBER, "current", null, now, rates)).toEqual({
      ok: true,
      overridden: false,
    });
  });

  it.each([
    ["expired", "competence_expired"],
    ["not_held", "competence_not_held"],
  ] as const)("blocks a member whose competence is %s, with no override", (competence, problem) => {
    expect(checkCompetenceGate(MEMBER, competence, null, now, rates)).toMatchObject({
      ok: false,
      problem,
    });
  });

  it("lets an override recorded by someone else, with a reason, in force, through: flagged for the report", () => {
    expect(checkCompetenceGate(MEMBER, "expired", override(), now, rates)).toEqual({
      ok: true,
      overridden: true,
    });
  });

  it.each<[string, Partial<CompetenceOverride>, CompetenceProblem]>([
    ["approved by the member themselves", { approvedBy: MEMBER }, "override_by_self"],
    ["for someone else", { memberId: "member-other" }, "override_for_someone_else"],
    ["with no reason", { reason: "  " }, "override_reason_required"],
    [
      "longer than the table allows",
      { until: new Date(shiftStart.getTime() + rates.competenceOverrideMaxHours * HOUR + 60_000) },
      "override_too_long",
    ],
    ["ending before it starts", { until: fromUkWallClock(2026, 11, 2, 6, 0) }, "override_too_long"],
    [
      "not yet in force",
      { from: fromUkWallClock(2026, 11, 2, 10, 0), until: fromUkWallClock(2026, 11, 2, 12, 0) },
      "override_not_in_force",
    ],
    [
      "ended",
      { from: fromUkWallClock(2026, 11, 2, 6, 0), until: fromUkWallClock(2026, 11, 2, 9, 0) },
      "override_not_in_force",
    ],
  ])("refuses an override %s", (_name, overrides, problem) => {
    expect(checkCompetenceGate(MEMBER, "expired", override(overrides), now, rates)).toMatchObject({
      ok: false,
      problem,
    });
  });
});
