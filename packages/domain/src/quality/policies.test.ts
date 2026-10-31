import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import {
  checkPolicyPublication,
  POLICY_WORKFLOW,
  type PolicySignature,
  type PolicyVersion,
  policyReviewStatus,
  readAndSignRemindersDue,
  readAndSignStatus,
  type StaffMember,
} from "./policies";
import { addDays, addMonths } from "./quality-dates";
import { resolveQualityPhase2Rates } from "./quality-rates";

const rates = resolveQualityPhase2Rates(readRateTable(), "england", "2026-10-31", null);
const MANAGE = ["quality.policy.manage"];

const policy = (over: Partial<PolicyVersion> = {}): PolicyVersion => ({
  policyKey: "medicines",
  version: 2,
  state: "draft",
  change: "major",
  authorId: "author",
  publishedOn: null,
  reviewDueOn: "2027-10-31",
  roles: ["carer", "nurse"],
  ...over,
});

describe("hazard HZ-128 policies and read-and-sign (quality.md 17.3 rules 25 to 28; QUAL-008)", () => {
  it("rule 25 moves draft to published to superseded or retired", () => {
    expect(POLICY_WORKFLOW.transitions.map((t) => `${t.from}>${t.to}`)).toEqual([
      "draft>published",
      "published>superseded",
      "published>retired",
    ]);
  });

  const publish = (over: Partial<Parameters<typeof checkPolicyPublication>[1]> = {}) => ({
    publisherId: "publisher",
    publishedOn: "2026-10-31",
    permissions: MANAGE,
    requireSecondReviewer: true,
    ...over,
  });

  it.each<
    [
      string,
      Partial<PolicyVersion>,
      Partial<Parameters<typeof checkPolicyPublication>[1]>,
      string[],
    ]
  >([
    ["a draft by another person", {}, {}, []],
    [
      "the author publishing alone where a second reviewer is required",
      {},
      { publisherId: "author" },
      ["second_reviewer_required"],
    ],
    [
      "the author publishing where the tenant does not require a second reviewer",
      {},
      { publisherId: "author", requireSecondReviewer: false },
      [],
    ],
    ["someone without the permission", {}, { permissions: [] }, ["missing_permission"]],
    ["a version already published", { state: "published" }, {}, ["not_draft"]],
    ["no roles to read it", { roles: [] }, {}, ["no_roles"]],
    ["no review date", { reviewDueOn: null }, {}, ["review_date_missing"]],
    [
      "a review date on the publication date",
      { reviewDueOn: "2026-10-31" },
      {},
      ["review_date_not_after_publication"],
    ],
    [
      "a review date past the tenant's longest interval",
      { reviewDueOn: addDays(addMonths("2026-10-31", rates.policyReviewIntervalMonthsMax), 1) },
      {},
      ["review_date_too_far"],
    ],
    [
      "a review date at the longest interval",
      { reviewDueOn: addMonths("2026-10-31", rates.policyReviewIntervalMonthsMax) },
      {},
      [],
    ],
  ])("rule 25 checks publishing %s", (_, over, pub, problems) => {
    expect(checkPolicyPublication(policy(over), publish(pub), rates)).toEqual(problems);
  });

  const staff: StaffMember[] = [
    { id: "carer-a", roles: ["carer"], startedOn: "2025-01-01", leftOn: null },
    { id: "carer-b", roles: ["carer"], startedOn: "2026-11-15", leftOn: null },
    { id: "nurse-c", roles: ["nurse"], startedOn: "2024-01-01", leftOn: null },
    { id: "cook-d", roles: ["cook"], startedOn: "2024-01-01", leftOn: null },
    { id: "left-e", roles: ["carer"], startedOn: "2024-01-01", leftOn: "2026-11-01" },
  ];
  const sig = (staffId: string, version: number): PolicySignature => ({
    staffId,
    policyKey: "medicines",
    version,
    signedOn: "2026-10-01",
  });
  const previous = policy({ version: 1, state: "superseded", publishedOn: "2025-10-01" });

  it("rule 26 lists who must sign, who has and who is outstanding since when", () => {
    const current = policy({ state: "published", publishedOn: "2026-11-01" });
    const status = readAndSignStatus(current, previous, staff, [sig("nurse-c", 2)], "2026-11-20");
    expect(status.required).toEqual(["carer-a", "carer-b", "nurse-c"]);
    expect(status.signed).toEqual(["nurse-c"]);
    expect(status.outstanding).toEqual([
      { staffId: "carer-a", dueFrom: "2026-11-01" },
      { staffId: "carer-b", dueFrom: "2026-11-15" },
    ]);
  });

  it.each<[string, "minor" | "major", string[]]>([
    ["after a minor change a signature on the last version still counts", "minor", ["carer-a"]],
    ["after a major change it does not", "major", []],
  ])("rule 26: %s", (_, change, signed) => {
    const current = policy({
      state: "published",
      publishedOn: "2026-11-01",
      change,
      roles: ["carer"],
    });
    const status = readAndSignStatus(current, previous, staff, [sig("carer-a", 1)], "2026-11-02");
    expect(status.signed).toEqual(signed);
  });

  it("rule 26 asks nothing of a draft", () => {
    expect(readAndSignStatus(policy(), previous, staff, [], "2026-11-02")).toEqual({
      required: [],
      signed: [],
      outstanding: [],
    });
  });

  it("rule 27 reminds those outstanding for the reminder period since publication or their last reminder", () => {
    const outstanding = [
      { staffId: "a", dueFrom: "2026-11-01" },
      { staffId: "b", dueFrom: "2026-11-01" },
      { staffId: "c", dueFrom: addDays("2026-11-30", -rates.readAndSignReminderDays + 1) },
    ];
    const due = readAndSignRemindersDue(
      outstanding,
      { b: addDays("2026-11-30", -rates.readAndSignReminderDays + 1) },
      "2026-11-30",
      rates,
    );
    expect(due).toEqual(["a"]);
  });

  it.each<[string, string | null, string]>([
    ["well before its review date", "2027-10-31", "current"],
    [
      "within the due-soon window",
      addDays("2026-10-31", rates.policyReviewDueSoonDays),
      "due_soon",
    ],
    ["on its review date", "2026-10-31", "due_soon"],
    ["after its review date", "2026-10-30", "overdue"],
    ["with no review date", null, "no_review_date"],
  ])("rule 28 says a policy %s is %s", (_, reviewDueOn, status) => {
    expect(policyReviewStatus({ reviewDueOn }, "2026-10-31", rates)).toBe(status);
  });
});
