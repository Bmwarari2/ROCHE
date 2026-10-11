import { describe, expect, it } from "vitest";
import {
  type AdmissionReadinessInput,
  type ChecklistItemState,
  checkAdmissionReadiness,
  checkWelcomeChecklistDefinition,
  DEFAULT_WELCOME_CHECKLIST,
  type WelcomeChecklistItemDefinition,
  welcomeChecklistStatus,
} from "./admission";
import type { BedMovePlan } from "./occupancy";
import type { AdmissionDecision } from "./pre-admission";

const decision: AdmissionDecision = {
  canMeetNeeds: "yes_with_conditions",
  admit: true,
  reasons: "Needs can be met once the mattress is delivered.",
  conditions: ["Pressure-relieving mattress delivered"],
  decidedBy: "manager-1",
  decidedAt: new Date("2026-10-06T09:00:00Z"),
  plannedAdmissionOn: "2026-10-12",
  trialEndsOn: null,
};

const freeBed: BedMovePlan = {
  ok: true,
  close: null,
  open: { personId: "p", roomId: "r1", bed: 1, from: "2026-10-12", to: null },
  backdated: false,
};

function input(overrides: Partial<AdmissionReadinessInput> = {}): AdmissionReadinessInput {
  return {
    decision,
    conditionsMet: [true],
    placement: { type: "permanent", startDate: "2026-10-12" },
    bed: freeBed,
    ...overrides,
  };
}

describe("admission readiness", () => {
  it("is ready with a positive decision, conditions met and a free bed", () => {
    expect(checkAdmissionReadiness(input())).toEqual({ ready: true });
  });

  it("does not need a bed for a care package", () => {
    expect(
      checkAdmissionReadiness(
        input({ bed: null, placement: { type: "package", startDate: "2026-10-12" } }),
      ),
    ).toEqual({ ready: true });
  });

  it("takes the trial end from the decision", () => {
    expect(
      checkAdmissionReadiness(
        input({
          decision: { ...decision, trialEndsOn: "2026-11-09" },
          placement: { type: "trial", startDate: "2026-10-12" },
        }),
      ),
    ).toEqual({ ready: true });
  });

  it.each<[string, Partial<AdmissionReadinessInput>, readonly string[]]>([
    ["no decision", { decision: null }, ["no_decision"]],
    [
      "a declined decision",
      { decision: { ...decision, admit: false, canMeetNeeds: "no" } },
      ["decision_declined"],
    ],
    ["a condition not yet met", { conditionsMet: [false] }, ["conditions_not_met"]],
    ["conditions not confirmed at all", { conditionsMet: [] }, ["conditions_not_met"]],
    [
      "an impossible start date",
      { placement: { type: "permanent", startDate: "2026-02-30" } },
      ["invalid_start_date"],
    ],
    [
      "a trial with no end date",
      { placement: { type: "trial", startDate: "2026-10-12" } },
      ["trial_end_required"],
    ],
    [
      "a trial ending before it starts",
      { placement: { type: "trial", startDate: "2026-10-12", trialEndsOn: "2026-10-01" } },
      ["trial_ends_before_start"],
    ],
    ["no bed for a residential placement", { bed: null }, ["bed_required"]],
    [
      "an occupied bed",
      { bed: { ok: false, problem: "bed_occupied", message: "Occupied" } },
      ["bed_not_available"],
    ],
  ])("is not ready with %s", (_label, overrides, problems) => {
    expect(checkAdmissionReadiness(input(overrides))).toEqual({ ready: false, problems });
  });
});

describe("welcome checklist", () => {
  const at = new Date("2026-10-12T15:00:00Z");
  const done: ChecklistItemState = { status: "done", by: "senior-1", at };
  const allDone = Object.fromEntries(DEFAULT_WELCOME_CHECKLIST.map((i) => [i.key, done]));

  it("is complete when every required item is done", () => {
    const optional = DEFAULT_WELCOME_CHECKLIST.filter((i) => !i.required).map((i) => i.key);
    const states = Object.fromEntries(
      Object.entries(allDone).filter(([k]) => !optional.includes(k)),
    );
    expect(welcomeChecklistStatus(DEFAULT_WELCOME_CHECKLIST, states)).toEqual({
      complete: true,
      outstanding: [],
      safetyCriticalOutstanding: [],
      invalid: [],
    });
  });

  it("lists safety-critical items first", () => {
    const status = welcomeChecklistStatus(DEFAULT_WELCOME_CHECKLIST, {});
    expect(status.complete).toBe(false);
    expect(status.safetyCriticalOutstanding).toEqual([
      "photo_taken",
      "allergies_confirmed",
      "medicines_received_and_checked",
      "diet_and_textures_shared_with_kitchen",
      "evacuation_plan_completed",
    ]);
    expect(status.outstanding.slice(0, 5)).toEqual(status.safetyCriticalOutstanding);
    expect(status.outstanding).not.toContain("keys_issued");
  });

  it.each<[string, string, ChecklistItemState, boolean]>([
    [
      "hazard HZ-007 refuses allergies as not applicable",
      "allergies_confirmed",
      { status: "not_applicable", reason: "None known", by: "s", at },
      false,
    ],
    [
      "hazard HZ-001 accepts no photo with a reason",
      "photo_taken",
      { status: "not_applicable", reason: "Declined; description recorded instead", by: "s", at },
      true,
    ],
    [
      "refuses not applicable without a reason",
      "call_bell_explained",
      { status: "not_applicable", reason: "", by: "s", at },
      false,
    ],
    ["treats pending as outstanding", "key_worker_introduced", { status: "pending" }, false],
  ])("%s", (_label, key, state, satisfied) => {
    const status = welcomeChecklistStatus(DEFAULT_WELCOME_CHECKLIST, { ...allDone, [key]: state });
    expect(status.complete).toBe(satisfied);
    expect(status.outstanding.includes(key)).toBe(!satisfied);
  });

  it("reports invalid optional items without blocking completion", () => {
    const status = welcomeChecklistStatus(DEFAULT_WELCOME_CHECKLIST, {
      ...allDone,
      keys_issued: { status: "not_applicable", reason: "", by: "s", at },
    });
    expect(status).toMatchObject({ complete: true, invalid: ["keys_issued"] });
  });
});

describe("tenant welcome checklists", () => {
  const extra: WelcomeChecklistItemDefinition = {
    key: "hairdresser_booked",
    title: "Hairdresser appointment offered",
    required: false,
    safetyCritical: false,
    allowNotApplicable: true,
    hazardIds: [],
  };

  it("accepts the default plus tenant items", () => {
    expect(checkWelcomeChecklistDefinition([...DEFAULT_WELCOME_CHECKLIST, extra])).toEqual([]);
  });

  it("refuses a list without a safety-critical item", () => {
    const without = DEFAULT_WELCOME_CHECKLIST.filter((i) => i.key !== "evacuation_plan_completed");
    expect(checkWelcomeChecklistDefinition(without)).toEqual([
      { kind: "safety_item_missing", key: "evacuation_plan_completed" },
    ]);
  });

  it.each<[string, Partial<WelcomeChecklistItemDefinition>]>([
    ["made optional", { required: false }],
    ["no longer safety-critical", { safetyCritical: false }],
    ["allowed to be not applicable", { allowNotApplicable: true }],
  ])("refuses a safety-critical item %s", (_label, change) => {
    const weakened = DEFAULT_WELCOME_CHECKLIST.map((i) =>
      i.key === "allergies_confirmed" ? { ...i, ...change } : i,
    );
    expect(checkWelcomeChecklistDefinition(weakened)).toEqual([
      { kind: "safety_item_weakened", key: "allergies_confirmed" },
    ]);
  });

  it("refuses duplicate keys", () => {
    expect(checkWelcomeChecklistDefinition([...DEFAULT_WELCOME_CHECKLIST, extra, extra])).toEqual([
      { kind: "duplicate_key", key: "hairdresser_booked" },
    ]);
  });
});
