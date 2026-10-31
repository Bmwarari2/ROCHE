import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { checkWorkflowTransition } from "../platform/workflow";
import { workingDaysDeadline } from "../shared/working-days";
import { resolveSafetyPhase2Rates } from "./phase2-rates";
import {
  canReply,
  SPEAK_UP_WORKFLOW,
  speakUpAcknowledgeTarget,
  speakUpCloseProblems,
  storedIdentity,
} from "./whistleblowing";

const rates = resolveSafetyPhase2Rates(readRateTable(), "england", "2026-10-31", null);

describe("speaking up (safety.md Phase 2 rule 3)", () => {
  it("moves through its steps with the speak-up permission only", () => {
    const check = (permissions: Set<string>) =>
      checkWorkflowTransition(
        SPEAK_UP_WORKFLOW,
        { state: "received", createdBy: "x" },
        {
          to: "acknowledged",
          actorId: "lead",
          permissions,
          stepUpFresh: false,
        },
      ).ok;
    expect(check(new Set(["safety.whistleblowing.read"]))).toBe(true);
    expect(check(new Set(["safety.incident.manage"]))).toBe(false);
  });

  it("keeps no identity for an anonymous concern", () => {
    expect(storedIdentity({ kind: "anonymous", replyTokenHash: "h" })).toEqual({
      kind: "anonymous",
      replyTokenHash: "h",
    });
    expect(storedIdentity({ kind: "named", tenantUserId: "u1" })).toEqual({
      kind: "named",
      tenantUserId: "u1",
    });
  });

  it.each([
    [{ kind: "named", tenantUserId: "u1" } as const, true],
    [{ kind: "confidential", tenantUserId: "u1" } as const, true],
    [{ kind: "anonymous", replyTokenHash: "h" } as const, true],
    [{ kind: "anonymous", replyTokenHash: null } as const, false],
  ])("can reply to %j: %s", (identity, expected) => {
    expect(canReply(identity)).toBe(expected);
    expect(speakUpCloseProblems(identity, null)).toHaveLength(expected ? 1 : 0);
    expect(speakUpCloseProblems(identity, new Date())).toEqual([]);
  });

  it("sets the acknowledgement target in working days from the rate table", () => {
    const received = new Date("2026-12-23T09:00:00Z");
    const holidays = new Set(["2026-12-25", "2026-12-28"]);
    expect(speakUpAcknowledgeTarget(received, rates, holidays)).toEqual(
      workingDaysDeadline(received, rates.whistleblowingAcknowledgeWorkingDays, holidays),
    );
  });
});
