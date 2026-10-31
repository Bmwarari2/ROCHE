import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { checkWorkflowTransition } from "../platform/workflow";
import { resolveSafetyPhase2Rates } from "./phase2-rates";
import {
  protectiveMeasuresFor,
  SAFEGUARDING_WORKFLOW,
  type SafeguardingRecordView,
  safeguardingClock,
  safeguardingReferralTarget,
  safeguardingStepProblems,
} from "./safeguarding";

const rates = resolveSafetyPhase2Rates(readRateTable(), "england", "2026-10-31", null);
const MANAGER = new Set(["safety.safeguarding.manage"]);
const empty: SafeguardingRecordView = {
  referral: null,
  enquiry: null,
  finding: null,
  personalOutcomes: null,
  staffRemovedForHarm: false,
  dbsReferral: null,
};
const complete: SafeguardingRecordView = {
  referral: {
    localAuthority: "Example Council",
    method: "phone",
    referredAt: new Date("2026-10-20T10:00:00Z"),
    reference: "SG-1",
  },
  enquiry: { kind: "s42_local_authority", openedAt: new Date("2026-10-21T10:00:00Z") },
  finding: "substantiated",
  personalOutcomes: {
    asked: true,
    notAskedReason: null,
    desiredOutcomes: "To feel safe at night",
    achieved: "partly",
  },
  staffRemovedForHarm: false,
  dbsReferral: null,
};
const move = (
  state: Parameters<typeof checkWorkflowTransition>[1]["state"],
  to: string,
  reason: string | null = null,
  permissions = MANAGER,
) =>
  checkWorkflowTransition(SAFEGUARDING_WORKFLOW, { state, createdBy: "staff-1" } as never, {
    to: to as never,
    actorId: "manager-1",
    permissions,
    reason,
    stepUpFresh: false,
  });

describe("hazard HZ-013 the safeguarding log (safety.md Phase 2 rule 1)", () => {
  it.each([
    ["concern", "referred", null, true],
    ["concern", "no_referral", null, false],
    [
      "concern",
      "no_referral",
      "No abuse or neglect: the bruise was recorded by the GP as from a known fall",
      true,
    ],
    ["referred", "enquiry", null, true],
    ["referred", "outcome", null, true],
    ["outcome", "closed", "Closed with the local authority's agreement", true],
    ["concern", "closed", "Skipping ahead", false],
  ] as const)("%s to %s (reason %s): allowed %s", (from, to, reason, ok) => {
    expect(move(from, to, reason).ok).toBe(ok);
  });

  it("needs the safeguarding permission", () => {
    expect(move("concern", "referred", null, new Set())).toMatchObject({
      ok: false,
      problem: "missing_permission",
    });
  });

  it.each([
    ["referred", "Record the referral: the local authority, how and when."],
    [
      "enquiry",
      "Record the enquiry: by the local authority, or caused to the provider, and when it opened.",
    ],
    ["outcome", "Record the enquiry's finding, or that the local authority made no s.42 enquiry."],
    [
      "closed",
      "Record what the person wanted from the enquiry and whether it was achieved (Making Safeguarding Personal).",
    ],
  ] as const)("refuses %s without its record", (to, problem) => {
    expect(safeguardingStepProblems(to, empty)).toEqual([problem]);
  });

  it("closes a complete record", () => {
    expect(safeguardingStepProblems("closed", complete)).toEqual([]);
  });

  it("closes when the person was not asked only with the reason why", () => {
    const notAsked = {
      ...complete,
      personalOutcomes: {
        asked: false,
        notAskedReason: null,
        desiredOutcomes: null,
        achieved: null,
      },
    };
    expect(safeguardingStepProblems("closed", notAsked)).toHaveLength(1);
    expect(
      safeguardingStepProblems("closed", {
        ...notAsked,
        personalOutcomes: {
          ...notAsked.personalOutcomes,
          notAskedReason: "Lacks capacity; no advocate was available in time",
        },
      }),
    ).toEqual([]);
  });

  it("needs a DBS referral decision when a member of staff was removed for harm", () => {
    const removed = { ...complete, staffRemovedForHarm: true };
    expect(safeguardingStepProblems("closed", removed)[0]).toContain("DBS referral decision");
    expect(
      safeguardingStepProblems("closed", {
        ...removed,
        dbsReferral: { decision: "not_required", reason: null, at: new Date() },
      }),
    ).toEqual(["Say why a DBS referral is not required."]);
    expect(
      safeguardingStepProblems("closed", {
        ...removed,
        dbsReferral: { decision: "referred", reason: null, at: new Date() },
      }),
    ).toEqual([]);
  });

  it("needs the DBS referral decision even when no s.42 referral is made", () => {
    expect(
      safeguardingStepProblems("no_referral", { ...empty, staffRemovedForHarm: true })[0],
    ).toContain("DBS referral decision");
    expect(safeguardingStepProblems("no_referral", empty)).toEqual([]);
  });

  it("names the local authority", () => {
    const blank = {
      ...complete,
      referral: {
        ...(complete.referral as NonNullable<SafeguardingRecordView["referral"]>),
        localAuthority: " ",
      },
    };
    expect(safeguardingStepProblems("referred", blank)).toEqual([
      "Name the local authority referred to.",
    ]);
  });

  it("sets the referral target from the rate table and says it is a target", () => {
    const raised = new Date("2026-10-24T22:00:00Z");
    const target = safeguardingReferralTarget(raised, rates);
    expect(target.dueAt.getTime() - raised.getTime()).toBe(
      rates.safeguardingReferralHours * 3_600_000,
    );
    expect(target.wording).toContain("without delay");
  });
});

describe("hazard HZ-126 a safeguarding concern is progressed and its protective measures are seen", () => {
  const raised = new Date("2026-10-31T09:00:00Z");
  const due = new Date(raised.getTime() + rates.safeguardingReferralHours * 3_600_000);

  it.each([
    ["concern", new Date("2026-10-31T10:00:00Z"), "due"],
    ["concern", due, "overdue"],
    ["concern", new Date("2026-11-03T09:00:00Z"), "overdue"],
    ["referred", new Date("2026-11-03T09:00:00Z"), "referred"],
    ["enquiry", new Date("2026-11-03T09:00:00Z"), "referred"],
    ["closed", new Date("2026-11-03T09:00:00Z"), "referred"],
    ["no_referral", new Date("2026-11-03T09:00:00Z"), "not_referred"],
  ] as const)("hazard HZ-126 shows a %s concern at %s as %s", (state, now, status) => {
    const clock = safeguardingClock(state, due, now, rates);
    expect(clock.status).toBe(status);
    expect(clock.dueAt).toEqual(due);
    expect(clock.wording).toContain("The law says refer without delay.");
  });

  it("hazard HZ-126 shows the protective measures of every open concern, newest first", () => {
    const view = protectiveMeasuresFor([
      {
        state: "concern",
        protectiveMeasures: "Two staff for personal care",
        protectiveMeasuresUpdatedAt: new Date("2026-10-30T10:00:00Z"),
      },
      {
        state: "enquiry",
        protectiveMeasures: " No visits from the named visitor ",
        protectiveMeasuresUpdatedAt: new Date("2026-10-31T10:00:00Z"),
      },
      {
        state: "closed",
        protectiveMeasures: "Old measure",
        protectiveMeasuresUpdatedAt: new Date("2026-10-31T11:00:00Z"),
      },
      {
        state: "no_referral",
        protectiveMeasures: "Not referred",
        protectiveMeasuresUpdatedAt: new Date("2026-10-31T11:00:00Z"),
      },
    ]);
    expect(view.measures.map((m) => m.text)).toEqual([
      "No visits from the named visitor",
      "Two staff for personal care",
    ]);
    expect(view.openWithoutMeasures).toBe(0);
  });

  it("hazard HZ-126 counts an open concern with no measures, so the screen never shows nothing", () => {
    const view = protectiveMeasuresFor([
      { state: "concern", protectiveMeasures: null, protectiveMeasuresUpdatedAt: null },
      { state: "referred", protectiveMeasures: "  ", protectiveMeasuresUpdatedAt: new Date() },
    ]);
    expect(view.measures).toEqual([]);
    expect(view.openWithoutMeasures).toBe(2);
  });
});
