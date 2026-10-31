/**
 * Complaints and compliments (safety.md Phase 2 rule 2; SAFE-011; Regulation 16 of the Health and
 * Social Care Act 2008 (Regulated Activities) Regulations 2014; the Local Government and Social Care
 * Ombudsman). Regulation 16 sets no times for independent providers, so acknowledgement and response
 * are tenant targets in working days, paused while waiting for the complainant. The final response
 * always signposts the Ombudsman with its time limit. A compliment never runs a clock.
 */

import { defineWorkflow } from "../platform/workflow";
import { addWorkingDays, type BankHolidays, isWorkingDay, ukIsoDate } from "../shared/working-days";
import type { SafetyPhase2Rates } from "./phase2-rates";

export type ComplaintState =
  | "received"
  | "acknowledged"
  | "investigating"
  | "responded"
  | "appealed"
  | "appeal_responded"
  | "closed";

export const COMPLAINT_WORKFLOW = defineWorkflow<ComplaintState>({
  key: "safety.complaint",
  version: 1,
  states: [
    "received",
    "acknowledged",
    "investigating",
    "responded",
    "appealed",
    "appeal_responded",
    "closed",
  ],
  initial: "received",
  terminal: ["closed"],
  transitions: [
    { from: "received", to: "acknowledged", permission: "safety.complaint.manage" },
    { from: "acknowledged", to: "investigating", permission: "safety.complaint.manage" },
    {
      from: ["acknowledged", "investigating"],
      to: "responded",
      permission: "safety.complaint.manage",
    },
    { from: "responded", to: "appealed", permission: "safety.complaint.manage" },
    { from: "appealed", to: "appeal_responded", permission: "safety.complaint.manage" },
    // Withdrawn by the complainant at any open stage: recorded with the reason.
    {
      from: ["received", "acknowledged", "investigating", "responded", "appeal_responded"],
      to: "closed",
      permission: "safety.complaint.manage",
      requiresReason: true,
    },
  ],
});

export interface ResponseView {
  readonly outcome: "upheld" | "partly_upheld" | "not_upheld" | null;
  readonly actionsTaken: string | null;
  readonly ombudsmanSignposted: boolean;
  readonly documentId: string | null;
}

/** What a response (first or after an appeal) needs before it goes. */
export function complaintResponseProblems(response: ResponseView): string[] {
  const problems: string[] = [];
  if (!response.outcome)
    problems.push("Record whether the complaint was upheld, partly upheld or not upheld.");
  if (!response.actionsTaken?.trim()) problems.push("Say what was done, or why nothing was.");
  if (!response.ombudsmanSignposted) {
    problems.push(
      "Tell the complainant they can go to the Local Government and Social Care Ombudsman, and the time limit.",
    );
  }
  if (!response.documentId) problems.push("Keep a copy of the response.");
  return problems;
}

export interface ComplaintPause {
  /** UK dates, inclusive: waiting for the complainant's consent or information. */
  readonly from: string;
  readonly to: string;
}

function workingDaysIn(pause: ComplaintPause, holidays: BankHolidays): number {
  let count = 0;
  const d = new Date(`${pause.from}T00:00:00Z`);
  const end = new Date(`${pause.to}T00:00:00Z`);
  while (d <= end) {
    if (isWorkingDay(d.toISOString().slice(0, 10), holidays)) count++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return count;
}

export interface ComplaintClocks {
  /** UK dates: the last day of each target. */
  readonly acknowledgeBy: string;
  readonly respondBy: string;
  readonly pausedWorkingDays: number;
  readonly wording: string;
}

export function complaintClocks(
  receivedAt: Date,
  pauses: readonly ComplaintPause[],
  rates: Pick<
    SafetyPhase2Rates,
    "complaintAcknowledgeWorkingDays" | "complaintResponseWorkingDays"
  >,
  holidays: BankHolidays,
): ComplaintClocks {
  const received = ukIsoDate(receivedAt);
  const paused = pauses.reduce((sum, p) => sum + workingDaysIn(p, holidays), 0);
  return {
    acknowledgeBy: addWorkingDays(received, rates.complaintAcknowledgeWorkingDays, holidays),
    respondBy: addWorkingDays(received, rates.complaintResponseWorkingDays + paused, holidays),
    pausedWorkingDays: paused,
    wording: `Targets: acknowledge within ${rates.complaintAcknowledgeWorkingDays} working days and respond within ${rates.complaintResponseWorkingDays}. These are your organisation's targets; Regulation 16 sets none.`,
  };
}

/** The last day the complainant would normally have to go to the Ombudsman. */
export function ombudsmanDeadline(
  knewOfMatterOn: string,
  rates: Pick<SafetyPhase2Rates, "lgscoTimeLimitMonths">,
): string {
  const [y, m, d] = knewOfMatterOn.split("-").map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m - 1 + rates.lgscoTimeLimitMonths, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last)))
    .toISOString()
    .slice(0, 10);
}
