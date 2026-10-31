import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { checkWorkflowTransition } from "../platform/workflow";
import { addWorkingDays } from "../shared/working-days";
import {
  COMPLAINT_WORKFLOW,
  complaintClocks,
  complaintResponseProblems,
  ombudsmanDeadline,
} from "./complaints";
import { resolveSafetyPhase2Rates } from "./phase2-rates";

const rates = resolveSafetyPhase2Rates(readRateTable(), "england", "2026-10-31", null);
const HOLIDAYS = new Set(["2026-12-25", "2026-12-28"]);

describe("complaints (safety.md Phase 2 rule 2)", () => {
  it.each([
    ["received", "acknowledged", null, true],
    ["acknowledged", "responded", null, true],
    ["responded", "appealed", null, true],
    ["appealed", "appeal_responded", null, true],
    ["received", "closed", null, false],
    ["received", "closed", "Withdrawn by the complainant", true],
    ["received", "responded", null, false],
  ] as const)("%s to %s: allowed %s", (from, to, reason, ok) => {
    const check = checkWorkflowTransition(
      COMPLAINT_WORKFLOW,
      { state: from, createdBy: "a" },
      {
        to,
        actorId: "b",
        permissions: new Set(["safety.complaint.manage"]),
        reason,
        stepUpFresh: false,
      },
    );
    expect(check.ok).toBe(ok);
  });

  it("counts the targets in working days from the UK date received, skipping bank holidays", () => {
    // 23:30 UTC on Thursday 17 December is still the 17th in the UK (GMT).
    const clocks = complaintClocks(new Date("2026-12-17T23:30:00Z"), [], rates, HOLIDAYS);
    expect(clocks.acknowledgeBy).toBe(
      addWorkingDays("2026-12-17", rates.complaintAcknowledgeWorkingDays, HOLIDAYS),
    );
    expect(clocks.respondBy).toBe(
      addWorkingDays("2026-12-17", rates.complaintResponseWorkingDays, HOLIDAYS),
    );
    expect(clocks.wording).toContain("Regulation 16 sets none");
  });

  it("takes the UK date of a complaint received just after midnight BST", () => {
    // 23:30 UTC on 24 October 2026 is 00:30 BST on the 25th.
    const clocks = complaintClocks(new Date("2026-10-24T23:30:00Z"), [], rates, new Set());
    expect(clocks.acknowledgeBy).toBe(
      addWorkingDays("2026-10-25", rates.complaintAcknowledgeWorkingDays, new Set()),
    );
  });

  it("extends the response target by the working days paused", () => {
    const clocks = complaintClocks(
      new Date("2026-11-02T10:00:00Z"),
      [{ from: "2026-11-06", to: "2026-11-10" }],
      rates,
      new Set(),
    );
    expect(clocks.pausedWorkingDays).toBe(3);
    expect(clocks.respondBy).toBe(
      addWorkingDays("2026-11-02", rates.complaintResponseWorkingDays + 3, new Set()),
    );
  });

  it("needs the outcome, what was done, the Ombudsman and a copy before a response goes", () => {
    expect(
      complaintResponseProblems({
        outcome: null,
        actionsTaken: null,
        ombudsmanSignposted: false,
        documentId: null,
      }),
    ).toHaveLength(4);
    expect(
      complaintResponseProblems({
        outcome: "partly_upheld",
        actionsTaken: "Night checks changed to hourly",
        ombudsmanSignposted: true,
        documentId: "doc-1",
      }),
    ).toEqual([]);
  });

  it("dates the Ombudsman's time limit from when the complainant knew, clamped to the month's end", () => {
    expect(ombudsmanDeadline("2026-03-31", { lgscoTimeLimitMonths: 11 })).toBe("2027-02-28");
    const deadline = ombudsmanDeadline("2026-10-31", rates);
    expect(deadline > "2026-10-31").toBe(true);
  });
});
