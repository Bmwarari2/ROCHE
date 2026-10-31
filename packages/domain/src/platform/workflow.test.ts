import { describe, expect, it } from "vitest";
import {
  availableTransitions,
  checkWorkflowTransition,
  defineWorkflow,
  slaDueAt,
  type WorkflowDefinition,
  WorkflowDefinitionError,
  type WorkflowSlaState,
  workflowActorView,
  workflowPermissions,
  workflowSlaState,
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

  it("counts working days to the end of the due day, skipping bank holidays", () => {
    const written = defineWorkflow<"open" | "written" | "done">({
      key: "test.written",
      version: 1,
      states: ["open", "written", "done"],
      initial: "open",
      terminal: ["done"],
      transitions: [{ from: "open", to: "done", permission: "safety.incident.manage" }],
      sla: { open: { rateKey: "test.working_days", unit: "working_days" } },
    });
    // Thursday 24 December 2026 plus 2 working days, with Christmas and the substitute Boxing Day.
    const due = slaDueAt(
      written,
      "open",
      new Date("2026-12-24T10:00:00Z"),
      () => 2,
      new Set(["2026-12-25", "2026-12-28"]),
    );
    expect(due?.toISOString()).toBe("2026-12-31T00:00:00.000Z");
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

describe("workflow service-level state for approval lists (PLAT-011)", () => {
  // 31/10/2026 is a Saturday in GMT (the clocks went back on 25/10/2026).
  const now = new Date("2026-10-31T10:00:00Z");
  it.each<[string, string | null, WorkflowSlaState]>([
    ["no deadline", null, "none"],
    ["a deadline already passed", "2026-10-31T09:59:59Z", "overdue"],
    ["a deadline at this very moment", "2026-10-31T10:00:00Z", "overdue"],
    ["a deadline later today", "2026-10-31T23:59:59Z", "due_today"],
    ["a deadline just after midnight UK time", "2026-11-01T00:00:00Z", "on_track"],
    ["a deadline next week", "2026-11-07T10:00:00Z", "on_track"],
    ["a deadline yesterday", "2026-10-30T12:00:00Z", "overdue"],
  ])("%s reads %s", (_label, due, expected) => {
    expect(workflowSlaState(due ? new Date(due) : null, now)).toBe(expected);
  });

  it("uses the UK day in summer time, not the UTC day", () => {
    // 23:30 UTC on 30/06/2026 is 00:30 on 01/07/2026 in London (BST).
    const summer = new Date("2026-06-30T22:00:00Z"); // 23:00 BST on 30/06
    expect(workflowSlaState(new Date("2026-06-30T23:30:00Z"), summer)).toBe("on_track");
    expect(workflowSlaState(new Date("2026-06-30T22:30:00Z"), summer)).toBe("due_today");
  });
});

describe("what an actor may do with a workflow instance (PLAT-011 approvals)", () => {
  it.each<
    [
      string,
      IncidentState,
      string,
      ReadonlySet<string>,
      { moves: string[]; awaitingYourApproval: boolean; raisedByYou: boolean },
    ]
  >([
    [
      "a manager who did not raise it may approve closing",
      "under_review",
      "manager",
      manager,
      { moves: ["closed"], awaitingYourApproval: true, raisedByYou: false },
    ],
    [
      "the person who raised it is never offered the approval",
      "under_review",
      "reporter",
      manager,
      { moves: [], awaitingYourApproval: false, raisedByYou: true },
    ],
    [
      "someone holding both permissions also sees the step back",
      "under_review",
      "manager",
      submitter,
      { moves: ["closed", "open"], awaitingYourApproval: true, raisedByYou: false },
    ],
    [
      "someone without the approval permission waits on others",
      "under_review",
      "reader",
      new Set(["safety.incident.read"]),
      { moves: [], awaitingYourApproval: false, raisedByYou: false },
    ],
    [
      "a closed record offers nothing",
      "closed",
      "manager",
      submitter,
      { moves: [], awaitingYourApproval: false, raisedByYou: false },
    ],
  ])("%s", (_label, state, actor, permissions, expected) => {
    const view = workflowActorView(incident, { state, createdBy: "reporter" }, actor, permissions);
    expect({
      moves: view.moves.map((m) => m.to),
      awaitingYourApproval: view.awaitingYourApproval,
      raisedByYou: view.raisedByYou,
    }).toEqual(expected);
  });

  it("says which step is the approval and what each step needs", () => {
    const view = workflowActorView(
      incident,
      { state: "under_review", createdBy: "reporter" },
      "manager",
      submitter,
    );
    expect(view.moves).toEqual([
      { to: "closed", approval: true, requiresReason: true, requiresStepUp: false },
      { to: "open", approval: false, requiresReason: false, requiresStepUp: true },
    ]);
  });

  it("lists every permission any step of the workflow needs", () => {
    expect([...workflowPermissions(incident)].sort()).toEqual([
      "safety.incident.manage",
      "safety.notification.submit",
    ]);
  });
});
