import type { WorkflowInstanceItem } from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import {
  approvalGroups,
  approvalsShown,
  isIncidentApproval,
  raisedByLine,
  slaChip,
  workflowLabel,
  workflowLink,
  workflowStateChip,
} from "./approvals";
import { t } from "./i18n";

const base: WorkflowInstanceItem = {
  id: "0194d000-0000-7000-8000-00000000a001",
  definitionKey: "safety.incident",
  subjectType: "incident",
  subjectId: "0194d000-0000-7000-8000-00000000b001",
  personId: null,
  incidentId: null,
  locationId: null,
  state: "under_review",
  enteredStateAt: "2026-10-30T09:00:00.000Z",
  slaDueAt: null,
  slaState: "none",
  createdBy: {
    id: "0194d000-0000-7000-8000-000000000302",
    displayName: "Mo Manager",
    jobTitle: null,
  },
  moves: [{ to: "closed", approval: true, requiresReason: true, requiresStepUp: false }],
  awaitingYourApproval: true,
  raisedByYou: false,
};
const item = (change: Partial<WorkflowInstanceItem>): WorkflowInstanceItem => ({
  ...base,
  ...change,
});

describe("approvals screen (PLAT-011)", () => {
  it.each<[string, readonly string[], boolean]>([
    ["a manager of incidents", ["safety.incident.manage"], true],
    ["a holder of the statutory submission permission", ["safety.notification.submit"], true],
    ["someone who manages downtime", ["operations.downtime.manage"], true],
    [
      "a care worker",
      ["people.person.read", "safety.incident.report", "safety.incident.read"],
      false,
    ],
    ["nobody", [], false],
  ])("is shown to %s: %s", (_label, permissions, shown) => {
    expect(approvalsShown(permissions)).toBe(shown);
  });

  it("groups each record once: yours, raised by you, then the rest", () => {
    const yours = item({ id: "a" });
    const raised = item({ id: "b", awaitingYourApproval: false, raisedByYou: true, moves: [] });
    const other = item({ id: "c", awaitingYourApproval: false, moves: [] });
    const groups = approvalGroups([yours, raised], [yours, raised, other]);
    expect(groups.yours.map((i) => i.id)).toEqual(["a"]);
    expect(groups.raised.map((i) => i.id)).toEqual(["b"]);
    expect(groups.other.map((i) => i.id)).toEqual(["c"]);
  });

  it.each<[string, string]>([
    ["safety.incident", "Incident"],
    ["safety.statutory_notification", "Statutory notification"],
    ["safety.candour", "Duty of candour"],
    ["care.dols_legal_change_review", "DoLS review after the legal change"],
    ["operations.outage", "Outage"],
    ["people.discharge", "Discharge"],
    ["people.death", "Death"],
    ["something.new", "Record"],
  ])("names %s as %s", (key, label) => {
    expect(workflowLabel(key, t)).toBe(label);
  });

  it.each<[string, Partial<WorkflowInstanceItem>, { status: string; label: string }]>([
    ["under review", {}, { status: "info", label: "Under review" }],
    ["a draft notification", { state: "draft" }, { status: "info", label: "Draft" }],
    [
      "an outage that has ended",
      { definitionKey: "operations.outage", state: "closed" },
      { status: "due", label: "Ended, to reconcile" },
    ],
    [
      "a state the web does not know",
      { state: "somewhere_new" },
      { status: "overdue", label: "State could not be read" },
    ],
  ])("says the state of %s with an icon and a word", (_label, change, expected) => {
    const chip = workflowStateChip(item(change), t);
    expect({ status: chip.status, label: chip.label }).toEqual(expected);
    expect(chip.icon).toBeTruthy();
  });

  it.each<[string, Partial<WorkflowInstanceItem>, { status: string; label: string }]>([
    [
      "overdue",
      { slaState: "overdue", slaDueAt: "2026-10-30T10:00:00.000Z" },
      { status: "overdue", label: "Overdue since 30/10/2026 10:00" },
    ],
    [
      "due today",
      { slaState: "due_today", slaDueAt: "2026-10-31T16:30:00.000Z" },
      { status: "due", label: "Due today by 16:30" },
    ],
    [
      "on track (summer time shown in UK time)",
      { slaState: "on_track", slaDueAt: "2026-07-01T08:00:00.000Z" },
      { status: "neutral", label: "Due by 01/07/2026 09:00" },
    ],
    ["without a deadline", { slaState: "none" }, { status: "neutral", label: "No deadline" }],
    [
      "in a state the web does not know",
      { slaState: "later" as WorkflowInstanceItem["slaState"] },
      { status: "overdue", label: "State could not be read" },
    ],
  ])("says the deadline when %s", (_label, change, expected) => {
    const chip = slaChip(item(change), t);
    expect({ status: chip.status, label: chip.label }).toEqual(expected);
  });

  it.each<[string, Partial<WorkflowInstanceItem>, string | null]>([
    ["an incident", {}, "/incidents/0194d000-0000-7000-8000-00000000b001"],
    [
      "a candour record, by its incident",
      { subjectType: "candour_record", incidentId: "0194d000-0000-7000-8000-00000000c001" },
      "/incidents/0194d000-0000-7000-8000-00000000c001",
    ],
    [
      "a statutory notification",
      { subjectType: "statutory_notification" },
      "/notifications/statutory/0194d000-0000-7000-8000-00000000b001",
    ],
    [
      "an outage, at its home",
      { subjectType: "outage", locationId: "0194d000-0000-7000-8000-000000000101" },
      "/downtime/0194d000-0000-7000-8000-000000000101/outages/0194d000-0000-7000-8000-00000000b001",
    ],
    [
      "a DoLS review, on the person's DoLS tab",
      { subjectType: "dols_legal_change_review", personId: "0194d000-0000-7000-8600-000000000001" },
      "/people/0194d000-0000-7000-8600-000000000001/dols",
    ],
    ["a type the web does not know", { subjectType: "mystery" }, null],
  ])("links %s to its own page", (_label, change, href) => {
    expect(workflowLink(item(change))).toBe(href);
  });

  it("says who raised it, or that Harbour started it", () => {
    expect(raisedByLine(base, t)).toBe("Raised by Mo Manager");
    expect(raisedByLine(item({ createdBy: null }), t)).toBe("Started by Harbour");
  });

  it("offers closing here only for an incident waiting for the reader's approval", () => {
    expect(isIncidentApproval(base)).toBe(true);
    expect(
      isIncidentApproval(item({ awaitingYourApproval: false, raisedByYou: true, moves: [] })),
    ).toBe(false);
    expect(isIncidentApproval(item({ subjectType: "statutory_notification" }))).toBe(false);
  });
});
