import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import {
  type CompetenceSignOff,
  competenceGate,
  OBSERVE_PERMISSION,
  signOffValidUntil,
} from "./competence";
import { addDays, addMonths } from "./dates";
import { resolveWorkforceRates } from "./rates";

const months = resolveWorkforceRates(
  readRateTable(),
  "england",
  "2026-10-31",
  null,
).medicinesCompetenceRefreshMonths;
const WORKER = "worker-1";
const OBSERVER = "observer-1";
const signOff = (overrides: Partial<CompetenceSignOff> = {}): CompetenceSignOff => ({
  competence: "medicines.administration",
  workerId: WORKER,
  observedOn: "2026-03-01",
  observerId: OBSERVER,
  observerPermissions: [OBSERVE_PERMISSION],
  ...overrides,
});
const gate = (signOffs: CompetenceSignOff[], today: string) =>
  competenceGate(WORKER, "medicines.administration", signOffs, today, months);

describe("observed competence gates actions (workforce.md rule 6)", () => {
  const lastDay = addDays(addMonths("2026-03-01", months), -1);

  it("is valid through the day before the refresh, from the rate table", () => {
    expect(signOffValidUntil(signOff(), months)).toBe(lastDay);
    expect(gate([signOff()], lastDay)).toEqual({ allowed: true, validUntil: lastDay });
    expect(gate([signOff()], addDays(lastDay, 1))).toEqual({
      allowed: false,
      reason: "expired",
      validUntil: lastDay,
    });
  });

  it.each<[string, CompetenceSignOff[], string]>([
    ["no sign-off", [], "missing"],
    [
      "a sign-off for another competence",
      [signOff({ competence: "moving_and_handling.hoist" })],
      "missing",
    ],
    ["a sign-off for someone else", [signOff({ workerId: "worker-2" })], "missing"],
    ["a sign-off dated after today", [signOff({ observedOn: "2026-11-01" })], "missing"],
    ["the worker signing themselves off", [signOff({ observerId: WORKER })], "self_signed"],
    [
      "an observer without the permission",
      [signOff({ observerPermissions: [] })],
      "observer_not_permitted",
    ],
  ])("blocks %s (%s)", (_, signOffs, reason) => {
    const result = gate(signOffs, "2026-10-31");
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe(reason);
  });

  it("counts the newest acceptable sign-off and ignores an unacceptable newer one", () => {
    const result = gate(
      [signOff(), signOff({ observedOn: "2026-10-01", observerId: WORKER })],
      "2026-10-31",
    );
    expect(result.allowed).toBe(true);
  });

  it("reads the day in UK time: valid on the last day across the clock change", () => {
    const march = signOff({ observedOn: "2025-10-26" });
    const end = signOffValidUntil(march, months);
    expect(gate([march], end).allowed).toBe(true);
  });
});
