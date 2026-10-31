import { describe, expect, it } from "vitest";
import { MIN_OVERRIDE_JUSTIFICATION, type RosterInput, rosterDecision } from "./rostering";

const ok: RosterInput = {
  dbs: { kind: "clear", updateServiceCheckDueOn: null },
  rightToWork: { kind: "valid", followUpDueOn: null },
  registrationCurrent: null,
  competences: [
    { competence: "medicines.administration", gate: { allowed: true, validUntil: "2027-01-01" } },
  ],
  shiftSupervised: false,
};
const reason = "Covering a sudden absence; the nurse in charge supervises every round.";

describe("hazard HZ-124 a worker without a required check cannot be rostered (workforce.md rule 10)", () => {
  it("hazard HZ-124 allows a worker with every check", () => {
    expect(rosterDecision(ok)).toEqual({ allowed: true, overridden: [] });
  });

  it.each<[string, Partial<RosterInput>, string]>([
    ["no DBS clearance", { dbs: { kind: "not_clear", reason: "no_certificate" } }, "dbs"],
    [
      "supervised-only DBS on an unsupervised shift",
      { dbs: { kind: "supervised_only" } },
      "dbs_supervised_only",
    ],
    [
      "a lapsed right to work",
      { rightToWork: { kind: "lapsed", lapsedOn: "2026-10-01" } },
      "right_to_work",
    ],
    ["no right to work", { rightToWork: { kind: "none" } }, "right_to_work"],
    ["a lapsed registration", { registrationCurrent: false }, "registration"],
    [
      "an expired competence",
      {
        competences: [
          {
            competence: "medicines.administration",
            gate: { allowed: false, reason: "expired", validUntil: "2026-10-01" },
          },
        ],
      },
      "competence",
    ],
  ])("hazard HZ-124 blocks %s", (_, change, kind) => {
    const decision = rosterDecision({ ...ok, ...change });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.blockers.map((b) => b.kind)).toEqual([kind]);
  });

  it("hazard HZ-124 allows supervised-only DBS on a supervised shift", () => {
    expect(
      rosterDecision({ ...ok, dbs: { kind: "supervised_only" }, shiftSupervised: true }).allowed,
    ).toBe(true);
  });

  it("hazard HZ-124 allows a right to work with a follow-up due", () => {
    expect(
      rosterDecision({
        ...ok,
        rightToWork: { kind: "follow_up_due", followUpDueOn: "2026-11-30", daysLeft: 30 },
      }).allowed,
    ).toBe(true);
  });

  it("hazard HZ-124 takes a manager's override with a justification, and lists what it overrode", () => {
    const decision = rosterDecision(
      { ...ok, dbs: { kind: "supervised_only" } },
      { justification: reason, byTenantUserId: "manager-1" },
    );
    expect(decision).toEqual({ allowed: true, overridden: [{ kind: "dbs_supervised_only" }] });
  });

  it("hazard HZ-124 refuses an override without a real justification", () => {
    const decision = rosterDecision(
      { ...ok, dbs: { kind: "supervised_only" } },
      { justification: "x".repeat(MIN_OVERRIDE_JUSTIFICATION - 1), byTenantUserId: "manager-1" },
    );
    expect(decision).toMatchObject({ allowed: false, overrideRefused: "justification_required" });
  });

  it.each<[string, Partial<Parameters<typeof rosterDecision>[0]>, string]>([
    [
      "no DBS certificate at all",
      { dbs: { kind: "not_clear", reason: "no_certificate" } },
      "no_dbs",
    ],
    ["a lapsed registration", { registrationCurrent: false }, "registration"],
    [
      "no DBS and a lapsed registration",
      { dbs: { kind: "not_clear", reason: "no_certificate" }, registrationCurrent: false },
      "no_dbs",
    ],
  ])("hazard HZ-124 never overrides %s (H-830)", (_name, input, refused) => {
    const decision = rosterDecision(
      { ...ok, ...input },
      { justification: reason, byTenantUserId: "manager-1" },
    );
    expect(decision).toMatchObject({
      allowed: false,
      overridable: false,
      overrideRefused: refused,
    });
  });

  it("hazard HZ-124 never overrides a missing right to work (illegal working)", () => {
    const decision = rosterDecision(
      { ...ok, rightToWork: { kind: "none" }, registrationCurrent: false },
      { justification: reason, byTenantUserId: "manager-1" },
    );
    expect(decision).toMatchObject({
      allowed: false,
      overridable: false,
      overrideRefused: "right_to_work",
    });
  });
});
