import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { addYears } from "./dates";
import { resolveWorkforceRates } from "./rates";
import {
  nextRevalidationDue,
  type Registration,
  type RevalidationEvidence,
  registrationCurrent,
  revalidationPlan,
} from "./registration";

const rates = resolveWorkforceRates(readRateTable(), "england", "2026-10-31", null);
const TODAY = "2026-10-31";
const nmc: Registration = {
  body: "nmc",
  pin: "99A9999E",
  renewalDueOn: "2027-03-31",
  revalidationDueOn: "2027-03-31",
};
const met: RevalidationEvidence = {
  practiceHours: rates.nmcPracticeHours,
  cpdHours: rates.nmcCpdHours,
  participatoryCpdHours: rates.nmcParticipatoryCpdHours,
  feedbackPieces: rates.nmcFeedbackCount,
  reflectiveAccounts: rates.nmcReflectiveAccounts,
  reflectiveDiscussion: true,
  healthAndCharacterDeclaration: true,
  professionalIndemnity: true,
  confirmation: true,
};

describe("qualifications and NMC revalidation (workforce.md rule 8)", () => {
  it.each([
    ["before the renewal date", nmc, "2027-03-30", true],
    ["on the renewal date", nmc, "2027-03-31", true],
    ["the day after", nmc, "2027-04-01", false],
    ["marked lapsed", { ...nmc, lapsed: true }, TODAY, false],
  ] as const)("registration %s is current: %s", (_, registration, today, current) => {
    expect(registrationCurrent(registration, today)).toBe(current);
  });

  it("is ready with every requirement met at the rate table's figures", () => {
    expect(revalidationPlan("2027-03-31", met, TODAY, rates)).toMatchObject({
      ready: true,
      outstanding: [],
      daysLeft: 151,
    });
  });

  it.each<[keyof RevalidationEvidence, unknown, string]>([
    ["practiceHours", rates.nmcPracticeHours - 1, "practice_hours"],
    ["cpdHours", rates.nmcCpdHours - 1, "cpd_hours"],
    ["participatoryCpdHours", rates.nmcParticipatoryCpdHours - 1, "participatory_cpd_hours"],
    ["feedbackPieces", rates.nmcFeedbackCount - 1, "feedback"],
    ["reflectiveAccounts", rates.nmcReflectiveAccounts - 1, "reflective_accounts"],
    ["reflectiveDiscussion", false, "reflective_discussion"],
    ["healthAndCharacterDeclaration", false, "health_and_character"],
    ["professionalIndemnity", false, "professional_indemnity"],
    ["confirmation", false, "confirmation"],
  ])("lists %s short of its figure as outstanding", (field, value, requirement) => {
    const plan = revalidationPlan("2027-03-31", { ...met, [field]: value }, TODAY, rates);
    expect(plan.ready).toBe(false);
    expect(plan.outstanding).toEqual([requirement]);
  });

  it("dates the next revalidation one cycle on", () => {
    expect(nextRevalidationDue("2027-03-31", rates)).toBe(
      addYears("2027-03-31", rates.nmcCycleYears),
    );
  });
});
