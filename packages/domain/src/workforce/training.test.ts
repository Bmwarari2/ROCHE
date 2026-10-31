import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { addDays, addYears } from "./dates";
import { resolveWorkforceRates } from "./rates";
import {
  type TrainingRecord,
  type TrainingRequirement,
  trainingMatrix,
  trainingState,
} from "./training";

const rows = readRateTable();
const england = resolveWorkforceRates(rows, "england", "2026-10-31", null);
const wales = resolveWorkforceRates(rows, "wales", "2026-10-31", null);
const TODAY = "2026-10-31";
const dayBefore = (iso: string) => addDays(iso, -1);

const fire: TrainingRequirement = { topic: "fire_safety", refreshYears: null };

describe("training matrix (workforce.md rule 5)", () => {
  it("is missing with no record, or only a record completed after today", () => {
    expect(trainingState(fire, [], TODAY, england).status).toBe("missing");
    const future: TrainingRecord = {
      topic: "fire_safety",
      completedOn: "2026-11-01",
      expiresOn: null,
    };
    expect(trainingState(fire, [future], TODAY, england).status).toBe("missing");
  });

  it("is valid through the day before completion plus the default refresh years", () => {
    const completed = "2025-06-01";
    const state = trainingState(
      fire,
      [{ topic: "fire_safety", completedOn: completed, expiresOn: null }],
      TODAY,
      england,
    );
    expect(state.validUntil).toBe(
      dayBefore(addYears(completed, england.trainingDefaultRefreshYears)),
    );
    expect(state.status).toBe("valid");
  });

  it("uses the topic's own refresh and a certificate's own expiry first", () => {
    const yearly: TrainingRequirement = { topic: "basic_life_support", refreshYears: 1 };
    const state = trainingState(
      yearly,
      [{ topic: "basic_life_support", completedOn: "2025-10-31", expiresOn: null }],
      TODAY,
      england,
    );
    expect(state.validUntil).toBe("2026-10-30");
    expect(state.status).toBe("expired");
    const certified = trainingState(
      yearly,
      [{ topic: "basic_life_support", completedOn: "2025-10-31", expiresOn: "2027-01-31" }],
      TODAY,
      england,
    );
    expect(certified.validUntil).toBe("2027-01-31");
  });

  it.each([
    [england.reminderDaysFirst + 1, "valid"],
    [england.reminderDaysFirst, "due_soon"],
    [0, "due_soon"],
    [-1, "expired"],
  ] as const)("%i days before its expiry it is %s", (daysLeft, status) => {
    const record: TrainingRecord = {
      topic: "fire_safety",
      completedOn: "2024-01-01",
      expiresOn: addDays(TODAY, daysLeft),
    };
    expect(trainingState(fire, [record], TODAY, england).status).toBe(status);
  });

  it("takes the newest valid record", () => {
    const records: TrainingRecord[] = [
      { topic: "fire_safety", completedOn: "2020-01-01", expiresOn: null },
      { topic: "fire_safety", completedOn: "2026-01-01", expiresOn: null },
    ];
    expect(trainingState(fire, records, TODAY, england).status).toBe("valid");
  });

  describe("Oliver McGowan tiers", () => {
    const tier2: TrainingRequirement = { topic: "oliver_mcgowan", refreshYears: null, tier: 2 };
    const tier1: TrainingRequirement = { topic: "oliver_mcgowan", refreshYears: null, tier: 1 };
    const did = (tier: 1 | 2): TrainingRecord => ({
      topic: "oliver_mcgowan",
      completedOn: "2026-01-15",
      expiresOn: null,
      tier,
    });

    it.each([
      [tier1, did(1), "valid"],
      [tier1, did(2), "valid"],
      [tier2, did(2), "valid"],
      [tier2, did(1), "missing"],
    ] as const)("requirement tier %#: %s", (requirement, record, status) => {
      expect(trainingState(requirement, [record], TODAY, england).status).toBe(status);
    });

    it("refreshes on England's Oliver McGowan figure, and the default elsewhere", () => {
      const record = did(2);
      expect(trainingState(tier2, [record], TODAY, england).validUntil).toBe(
        dayBefore(addYears(record.completedOn, england.oliverMcGowanRefreshYears ?? 0)),
      );
      expect(wales.oliverMcGowanRefreshYears).toBeNull();
      expect(trainingState(tier2, [record], TODAY, wales).validUntil).toBe(
        dayBefore(addYears(record.completedOn, wales.trainingDefaultRefreshYears)),
      );
    });
  });

  it("puts missing and expired topics first in the matrix", () => {
    const matrix = trainingMatrix(
      [
        fire,
        { topic: "food_hygiene", refreshYears: null },
        { topic: "medicines", refreshYears: 1 },
      ],
      [
        { topic: "fire_safety", completedOn: "2026-01-01", expiresOn: null },
        { topic: "medicines", completedOn: "2024-01-01", expiresOn: null },
      ],
      TODAY,
      england,
    );
    expect(matrix.map((m) => [m.topic, m.status])).toEqual([
      ["food_hygiene", "missing"],
      ["medicines", "expired"],
      ["fire_safety", "valid"],
    ]);
  });
});
