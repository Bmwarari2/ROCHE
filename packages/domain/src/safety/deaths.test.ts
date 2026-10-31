import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { addUkDays } from "../shared/time";
import { type DeathFacts, deathPlan, outstandingDeathSteps } from "./deaths";
import { resolveSafetyPhase2Rates } from "./phase2-rates";

const rates = resolveSafetyPhase2Rates(readRateTable(), "england", "2026-10-31", null);
const base: DeathFacts = {
  diedAt: new Date("2026-10-25T01:30:00Z"),
  expected: true,
  learningDisabilityOrAutism: false,
  possiblyUnnatural: false,
};

describe("deaths (safety.md Phase 2 rule 4)", () => {
  it.each<[string, Partial<DeathFacts>, string[]]>([
    [
      "an expected death",
      {},
      [
        "verification_of_death",
        "family_informed",
        "medical_examiner_pack",
        "cqc_reg16_notification",
        "mortality_review",
      ],
    ],
    [
      "a person with a learning disability",
      { learningDisabilityOrAutism: true },
      [
        "verification_of_death",
        "family_informed",
        "medical_examiner_pack",
        "cqc_reg16_notification",
        "leder_notification",
        "mortality_review",
      ],
    ],
    [
      "an unexpected death",
      { expected: false },
      [
        "verification_of_death",
        "family_informed",
        "medical_examiner_pack",
        "cqc_reg16_notification",
        "police_informed",
        "preserve_room_and_equipment",
        "mortality_review",
      ],
    ],
    [
      "an expected death that may be unnatural",
      { possiblyUnnatural: true },
      [
        "verification_of_death",
        "family_informed",
        "medical_examiner_pack",
        "cqc_reg16_notification",
        "police_informed",
        "preserve_room_and_equipment",
        "mortality_review",
      ],
    ],
  ])("lists the steps for %s", (_, change, steps) => {
    expect(deathPlan({ ...base, ...change }, rates).steps).toEqual(steps);
  });

  it("gives every step that needs one its reason", () => {
    const plan = deathPlan(
      { ...base, expected: false, learningDisabilityOrAutism: true, possiblyUnnatural: true },
      rates,
    );
    for (const step of [
      "medical_examiner_pack",
      "cqc_reg16_notification",
      "leder_notification",
      "police_informed",
      "mortality_review",
    ] as const) {
      expect(plan.reasons[step], step).toBeTruthy();
    }
    expect(plan.reasons.police_informed).toContain("coroner");
  });

  it("dates the mortality review in UK days across the autumn clock change", () => {
    const plan = deathPlan(base, rates);
    expect(plan.mortalityReviewDueAt).toEqual(addUkDays(base.diedAt, rates.mortalityReviewDueDays));
  });

  it("lists what is still to do in plan order", () => {
    const plan = deathPlan(base, rates);
    expect(
      outstandingDeathSteps(plan, new Set(["verification_of_death", "medical_examiner_pack"])),
    ).toEqual(["family_informed", "cqc_reg16_notification", "mortality_review"]);
  });
});
