import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { builtinRole } from "../platform/roles";
import { addYears } from "./dates";
import { resolveWorkforceRates } from "./rates";
import {
  checkConfirmerNaming,
  checkRevalidationConfirmation,
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

describe("the revalidation confirmation is the named confirmer's (rule 8; H-693)", () => {
  const NURSE = "u-nurse";
  const HR = "u-hr";
  const MANAGER = "u-manager";
  const permissionsOf = (key: string) => builtinRole(key)?.permissions ?? [];
  const hr = permissionsOf("hr");
  const manager = permissionsOf("registered_manager");
  const base = {
    workerId: NURSE,
    confirmerId: MANAGER as string | null,
    reviewState: "reviewed" as const,
    confirmed: false,
  };
  it.each([
    ["the named confirmer, a line manager", { actorId: MANAGER, actorPermissions: manager }, null],
    ["HR, not named", { actorId: HR, actorPermissions: hr }, "not_the_confirmer"],
    ["HR, named by someone else", { actorId: HR, actorPermissions: hr, confirmerId: HR }, null],
    [
      "the nurse",
      { actorId: NURSE, actorPermissions: permissionsOf("clinical_lead") },
      "own_record",
    ],
    [
      "the named confirmer without a confirming permission",
      { actorId: MANAGER, actorPermissions: permissionsOf("team_leader") },
      "not_permitted",
    ],
    [
      "anyone, before a confirmer is named",
      { actorId: MANAGER, actorPermissions: manager, confirmerId: null },
      "no_confirmer",
    ],
    [
      "the named confirmer, before HR's review",
      { actorId: MANAGER, actorPermissions: manager, reviewState: "submitted" as const },
      "not_reviewed",
    ],
    [
      "the named confirmer, a second time",
      { actorId: MANAGER, actorPermissions: manager, confirmed: true },
      "already_confirmed",
    ],
  ] as const)("%s", (_name, overrides, problem) => {
    const result = checkRevalidationConfirmation({ ...base, ...overrides });
    expect(result).toEqual(problem === null ? { ok: true } : { ok: false, problem });
  });

  it.each([
    ["HR names a line manager", { actorId: HR, actorPermissions: hr }, null],
    ["HR names themselves", { actorId: HR, actorPermissions: hr, confirmerId: HR }, "names_self"],
    [
      "HR names the nurse",
      { actorId: HR, actorPermissions: hr, confirmerId: NURSE },
      "names_worker",
    ],
    ["the nurse names someone", { actorId: NURSE, actorPermissions: hr }, "own_record"],
    [
      "a line manager without HR's permission",
      { actorId: MANAGER, actorPermissions: permissionsOf("clinical_lead") },
      "not_permitted",
    ],
    [
      "HR, once confirmed",
      { actorId: HR, actorPermissions: hr, confirmed: true },
      "already_confirmed",
    ],
  ] as const)("naming the confirmer: %s", (_name, overrides, problem) => {
    const result = checkConfirmerNaming({
      workerId: NURSE,
      confirmerId: MANAGER,
      confirmed: false,
      ...overrides,
    });
    expect(result).toEqual(problem === null ? { ok: true } : { ok: false, problem });
  });
});
