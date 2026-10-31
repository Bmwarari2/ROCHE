import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { ukIsoDate } from "../shared/working-days";
import {
  COMPETENCES,
  competenceDecision,
  competenceDecisionAt,
  competenceRefreshMonths,
  competenceValidUntil,
  isCompetence,
  MEDICINES_COMPETENCES,
  type StoredSignOff,
} from "./competence-port";
import { addDays } from "./dates";
import { resolveWorkforceRates } from "./rates";

const TODAY = "2026-10-31";
const rates = resolveWorkforceRates(readRateTable(), "england", TODAY, null);
const signOff = (observedOn: string, validUntil: string, withdrawnOn: string | null = null) =>
  ({ observedOn, validUntil, withdrawnOn }) satisfies StoredSignOff;

describe("hazard HZ-119 the competence port's decision (ADR-0085)", () => {
  it.each<
    [string, StoredSignOff[], { allowed: boolean; reason?: string; validUntil: string | null }]
  >([
    ["no sign-off", [], { allowed: false, reason: "missing", validUntil: null }],
    [
      "valid through its last day",
      [signOff("2025-11-01", TODAY)],
      { allowed: true, validUntil: TODAY },
    ],
    [
      "expired from the day after",
      [signOff("2025-10-31", addDays(TODAY, -1))],
      { allowed: false, reason: "expired", validUntil: addDays(TODAY, -1) },
    ],
    [
      "withdrawn today",
      [signOff("2026-06-01", "2027-05-31", TODAY)],
      { allowed: false, reason: "withdrawn", validUntil: null },
    ],
    [
      "withdrawn tomorrow still counts today",
      [signOff("2026-06-01", "2027-05-31", addDays(TODAY, 1))],
      { allowed: true, validUntil: "2027-05-31" },
    ],
    [
      "observed tomorrow does not count today",
      [signOff(addDays(TODAY, 1), "2027-10-31")],
      { allowed: false, reason: "missing", validUntil: null },
    ],
    [
      "a newer sign-off after a withdrawn one",
      [signOff("2026-01-01", "2026-12-31", "2026-03-01"), signOff("2026-04-01", "2027-03-31")],
      { allowed: true, validUntil: "2027-03-31" },
    ],
    [
      "the newest in force counts, whatever the list order",
      [signOff("2026-04-01", "2027-03-31"), signOff("2025-01-01", "2025-12-31")],
      { allowed: true, validUntil: "2027-03-31" },
    ],
    [
      "an expired one beside a withdrawn later one",
      [signOff("2025-01-01", "2025-12-31"), signOff("2026-04-01", "2027-03-31", "2026-05-01")],
      { allowed: false, reason: "withdrawn", validUntil: null },
    ],
    [
      "an older sign-off still in date when a newer one is withdrawn",
      [signOff("2026-01-10", "2027-01-09"), signOff("2026-09-01", "2027-08-31", "2026-10-15")],
      { allowed: false, reason: "withdrawn", validUntil: null },
    ],
    [
      "a sign-off observed on the day of the withdrawal, after it",
      [signOff("2026-01-10", "2027-01-09", "2026-10-15"), signOff("2026-10-15", "2027-10-14")],
      { allowed: true, validUntil: "2027-10-14" },
    ],
    [
      "a sign-off backdated to before the withdrawal",
      [signOff("2026-09-01", "2027-08-31", "2026-10-15"), signOff("2026-10-01", "2027-09-30")],
      { allowed: false, reason: "withdrawn", validUntil: null },
    ],
  ])("hazard HZ-119 %s", (_, signOffs, expected) => {
    expect(competenceDecision(signOffs, TODAY)).toEqual(expected);
  });
});

describe("competence refresh (workforce.md section 2b)", () => {
  it("refreshes medicines competences on the medicines rate and others on the default", () => {
    for (const competence of COMPETENCES) {
      expect(competenceRefreshMonths(competence, rates)).toBe(
        MEDICINES_COMPETENCES.has(competence)
          ? rates.medicinesCompetenceRefreshMonths
          : rates.competenceDefaultRefreshMonths,
      );
    }
  });

  it.each([
    ["2026-01-15", 12, "2027-01-14"],
    ["2024-02-29", 12, "2025-02-27"],
    ["2026-03-31", 1, "2026-04-29"],
  ])("a sign-off observed on %s for %i months is valid until %s", (observed, months, until) => {
    expect(competenceValidUntil(observed, months)).toBe(until);
  });

  it("knows its competences", () => {
    expect(isCompetence("medicines_administration")).toBe(true);
    expect(isCompetence("juggling")).toBe(false);
  });
});

describe("hazard HZ-119 the time the decision is made at (ADR-0085)", () => {
  const signOffs = [signOff("2025-11-01", "2026-10-30")];

  it("hazard HZ-119 never lets a device's earlier time allow what the server's time blocks", () => {
    expect(competenceDecisionAt(signOffs, TODAY, "2026-10-01")).toMatchObject({
      allowed: false,
      reason: "expired",
    });
  });

  it("hazard HZ-119 blocks when the claimed time is outside, even if the server's is inside", () => {
    const later = [signOff("2026-10-20", "2027-10-19")];
    expect(competenceDecisionAt(later, TODAY, "2026-10-01")).toMatchObject({
      allowed: false,
      reason: "missing",
    });
    expect(competenceDecisionAt(later, TODAY, null)).toMatchObject({ allowed: true });
  });

  it("hazard HZ-119 counts the UK day across the autumn clock change", () => {
    // 23:30 UTC on 24 October 2026 is 00:30 on 25 October in British Summer Time.
    const day = ukIsoDate(new Date("2026-10-24T23:30:00Z"));
    expect(day).toBe("2026-10-25");
    expect(competenceDecision([signOff("2025-10-25", "2026-10-24")], day)).toMatchObject({
      allowed: false,
      reason: "expired",
    });
  });
});
