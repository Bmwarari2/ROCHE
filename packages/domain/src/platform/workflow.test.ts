import { describe, expect, it } from "vitest";
import {
  availableTransitions,
  checkWorkflowTransition,
  defineWorkflow,
  slaDueAt,
  type WorkflowDefinition,
  WorkflowDefinitionError,
} from "./workflow";

type IncidentState = "open" | "under_review" | "closed";

const incident = defineWorkflow<IncidentState>({
  key: "test.incident",
  version: 1,
  states: ["open", "under_review", "closed"],
  initial: "open",
  terminal: ["closed"],
  transitions: [
    { from: "open", to: "under_review", permission: "safety.incident.manage" },
    {
      from: ["open", "under_review"],
      to: "closed",
      permission: "safety.incident.manage",
      requiresReason: true,
      distinctFromCreator: true,
    },
    { from: "under_review", to: "open", permission: "safety.notification.submit" },
  ],
  sla: { open: { hours: 24 }, under_review: { rateKey: "test.review_days", unit: "days" } },
});

const manager = new Set(["safety.incident.manage"]);
const submitter = new Set(["safety.incident.manage", "safety.notification.submit"]);

describe("workflow transitions", () => {
  it.each<
    [
      string,
      IncidentState,
      IncidentState,
      Partial<{ actorId: string; permissions: Set<string>; reason: string; stepUpFresh: boolean }>,
      string | null,
    ]
  >([
    ["review by a manager", "open", "under_review", {}, null],
    [
      "close by someone else with a reason",
      "under_review",
      "closed",
      { reason: "Learning shared" },
      null,
    ],
    ["close without a reason", "under_review", "closed", {}, "reason_required"],
    [
      "close by the reporter",
      "open",
      "closed",
      { actorId: "reporter", reason: "All fine" },
      "separation_of_duties",
    ],
    ["a step that does not exist", "open", "open", {}, "no_such_transition"],
    ["anything once closed", "closed", "open", {}, "terminal"],
    [
      "without the permission",
      "open",
      "under_review",
      { permissions: new Set() },
      "missing_permission",
    ],
    [
      "a step-up permission without step-up",
      "under_review",
      "open",
      { permissions: submitter },
      "step_up_required",
    ],
    [
      "a step-up permission with step-up",
      "under_review",
      "open",
      { permissions: submitter, stepUpFresh: true },
      null,
    ],
  ])("%s", (_label, from, to, overrides, expected) => {
    const result = checkWorkflowTransition(
      incident,
      { state: from, createdBy: "reporter" },
      { to, actorId: "manager", permissions: manager, stepUpFresh: false, ...overrides },
    );
    if (expected === null) expect(result.ok).toBe(true);
    else expect(result).toMatchObject({ ok: false, problem: expected });
  });

  it("lists only the steps the actor may take", () => {
    expect(
      availableTransitions(incident, { state: "open", createdBy: "reporter" }, "manager", manager),
    ).toEqual(["under_review", "closed"]);
    expect(
      availableTransitions(incident, { state: "open", createdBy: "reporter" }, "reporter", manager),
    ).toEqual(["under_review"]);
    expect(
      availableTransitions(
        incident,
        { state: "closed", createdBy: "reporter" },
        "manager",
        submitter,
      ),
    ).toEqual([]);
  });
});

describe("workflow service levels", () => {
  const entered = new Date("2026-10-24T10:00:00Z");

  it("adds fixed hours", () => {
    expect(slaDueAt(incident, "open", entered, () => 0)?.toISOString()).toBe(
      "2026-10-25T10:00:00.000Z",
    );
  });

  it("reads days from the rate table and keeps UK local time across the clock change", () => {
    const due = slaDueAt(incident, "under_review", entered, (key) =>
      key === "test.review_days" ? 2 : 0,
    );
    // 11:00 BST on 24 October becomes 11:00 GMT on 26 October, after the clocks go back.
    expect(due?.toISOString()).toBe("2026-10-26T11:00:00.000Z");
  });

  it("has no deadline for a state without an SLA", () => {
    expect(slaDueAt(incident, "closed", entered, () => 0)).toBeNull();
  });

  it("refuses a rate that is not positive", () => {
    expect(() => slaDueAt(incident, "under_review", entered, () => 0)).toThrow(
      WorkflowDefinitionError,
    );
  });
});

describe("workflow definitions are checked when they load", () => {
  const base: WorkflowDefinition<"a" | "b"> = {
    key: "test.bad",
    version: 1,
    states: ["a", "b"],
    initial: "a",
    terminal: ["b"],
    transitions: [{ from: "a", to: "b", permission: "safety.incident.manage" }],
  };

  it.each<[string, Partial<WorkflowDefinition<"a" | "b">>, string]>([
    ["duplicate states", { states: ["a", "a"] as unknown as ["a", "b"] }, "unique"],
    ["an unknown initial state", { initial: "c" as "a" }, "initial state"],
    ["an unknown terminal state", { terminal: ["c" as "b"] }, "terminal state c"],
    [
      "a transition out of a terminal state",
      { transitions: [{ from: "b", to: "a", permission: "safety.incident.manage" }] },
      "cannot have transitions",
    ],
    [
      "a transition to an unknown state",
      { transitions: [{ from: "a", to: "c" as "b", permission: "safety.incident.manage" }] },
      "unknown state c",
    ],
    [
      "an unknown permission",
      {
        transitions: [
          { from: "a", to: "b", permission: "made.up.thing" as "safety.incident.manage" },
        ],
      },
      "unknown permission",
    ],
    [
      "an SLA on an unknown state",
      { sla: { c: { hours: 2 } } as unknown as WorkflowDefinition<"a" | "b">["sla"] },
      "SLA for unknown",
    ],
    ["a zero-hour SLA", { sla: { a: { hours: 0 } } }, "positive"],
  ])("refuses %s", (_label, change, message) => {
    expect(() => defineWorkflow({ ...base, ...change })).toThrow(message);
  });
});
