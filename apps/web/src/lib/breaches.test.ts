import { describe, expect, it } from "vitest";
import {
  againstSuggestion,
  type Breach,
  breachChip,
  breachClockWords,
  breachForms,
  breachStage,
  noticeNumbers,
  readPeopleAffected,
  reportIsLate,
  suggestionWords,
} from "./breaches";
import { dataProtectionProblem } from "./data-protection-refusals";
import { t } from "./i18n";

const ID = "0194d000-0000-7000-8000-00000000b001";
const USER = "0194d000-0000-7000-8000-00000000c001";

/** An invented entry: the deadline (from the API) is 14:00 UK time on 02/11/2026 (GMT). */
function breach(overrides: Partial<Breach> = {}): Breach {
  return {
    id: ID,
    locationId: null,
    source: "tenant",
    summary: "A letter about one person went to the wrong address",
    awareAt: "2026-10-30T14:00:00.000Z",
    occurredAt: null,
    factors: null,
    suggestion: null,
    decision: null,
    report: null,
    individuals: null,
    status: "open",
    lessons: null,
    closedAt: null,
    clock: {
      deadline: "2026-11-02T14:00:00.000Z",
      state: "open",
      hoursLeft: 20,
      delayReasonRequired: false,
    },
    notices: [],
    createdAt: "2026-10-30T14:05:00.000Z",
    version: 1,
    ...overrides,
  };
}

const factors = {
  peopleAffected: 1,
  identifiable: true,
  specialCategory: true,
  safeguardingOrLocationAtRisk: false,
  disclosedOutsideOrganisation: true,
  careRecordsUnavailable: false,
  contained: false,
};
const suggestion = {
  severity: "high" as const,
  reasons: ["outside_organisation", "not_contained", "special_category"],
  considerReportingToIco: true,
  considerTellingIndividuals: true,
};
const decision = (reportToIco: boolean, tellIndividuals: boolean) => ({
  reportToIco,
  tellIndividuals,
  reasoning: "Health data went to a stranger and was not recovered.",
  acknowledgedSuggestion: false,
  decidedBy: USER,
  decidedAt: "2026-10-30T16:00:00.000Z",
});
const report = {
  reportedAt: "2026-10-31T09:30:00.000Z",
  icoReference: "IC-000000",
  delayReason: null,
};

describe("PLAT-022 the breach register: the ICO clock in words", () => {
  it.each([
    [
      "open, with the hours from the API",
      breach(),
      "due",
      "ICO report due",
      "Report to the ICO by 14:00 on 02/11/2026: 20 hours left",
    ],
    [
      "open, in the last hour",
      breach({ clock: { ...breach().clock, hoursLeft: 0 } }),
      "due",
      "ICO report due",
      "Report to the ICO by 14:00 on 02/11/2026: less than 1 hour left",
    ],
    [
      "open, one hour left",
      breach({ clock: { ...breach().clock, hoursLeft: 1 } }),
      "due",
      "ICO report due",
      "Report to the ICO by 14:00 on 02/11/2026: 1 hour left",
    ],
    [
      "overdue",
      breach({ clock: { ...breach().clock, state: "overdue", hoursLeft: 0 } }),
      "overdue",
      "ICO report overdue",
      "Overdue: the ICO deadline passed at 14:00 on 02/11/2026",
    ],
    [
      "reported on time",
      breach({
        report,
        decision: decision(true, false),
        clock: { ...breach().clock, state: "reported_on_time", hoursLeft: null },
      }),
      "done",
      "Reported on time",
      "Reported on time: the ICO was told 31/10/2026 09:30",
    ],
    [
      "reported late",
      breach({
        report: { ...report, reportedAt: "2026-11-03T10:00:00.000Z", delayReason: "Systems down" },
        decision: decision(true, false),
        clock: { ...breach().clock, state: "reported_late", hoursLeft: null },
      }),
      "done",
      "Reported late",
      "Reported late: the ICO was told 03/11/2026 10:00, after the deadline of 14:00 on 02/11/2026",
    ],
    [
      "decided not to report, while the API's clock still runs",
      breach({ decision: decision(false, false) }),
      "notApplicable",
      "No report needed",
      "No report needed: the decision is not to report this breach to the ICO",
    ],
    [
      "decided not to report, after the deadline",
      breach({
        decision: decision(false, false),
        clock: { ...breach().clock, state: "overdue", hoursLeft: 0 },
      }),
      "notApplicable",
      "No report needed",
      "No report needed: the decision is not to report this breach to the ICO",
    ],
    [
      "a state the screen does not know, never said as done",
      breach({
        clock: { ...breach().clock, state: "paused" as unknown as Breach["clock"]["state"] },
      }),
      "overdue",
      "Check the ICO clock",
      "Check the ICO clock with Harbour support",
    ],
  ])("%s", (_name, entry, status, label, words) => {
    expect(breachClockWords(entry, t)).toEqual({ status, label, words });
  });

  it("follows the API's deadline in BST too, never a figure of its own", () => {
    const entry = breach({
      clock: {
        deadline: "2026-07-03T13:00:00.000Z",
        state: "open",
        hoursLeft: 50,
        delayReasonRequired: false,
      },
    });
    expect(breachClockWords(entry, t).words).toBe(
      "Report to the ICO by 14:00 on 03/07/2026: 50 hours left",
    );
  });

  it.each([
    ["2026-11-02T14:00:00.000Z", false],
    ["2026-11-02T14:00:01.000Z", true],
    ["2026-11-01T09:00:00.000Z", false],
  ])("a report at %s is late: %s", (reportedAt, late) => {
    expect(reportIsLate("2026-11-02T14:00:00.000Z", reportedAt)).toBe(late);
  });
});

describe("PLAT-022 the breach register: stages and the forms offered", () => {
  const assessed = { factors, suggestion };
  it.each([
    ["new", breach(), "assess", "info", "To assess", [true, false, false, false, false]],
    [
      "assessed",
      breach(assessed),
      "decide",
      "info",
      "To decide",
      [true, true, false, false, false],
    ],
    [
      "decided to report and tell",
      breach({ ...assessed, decision: decision(true, true) }),
      "report",
      "info",
      "To report to the ICO",
      [false, true, true, true, false],
    ],
    [
      "reported, not yet told",
      breach({ ...assessed, decision: decision(true, true), report }),
      "tell",
      "info",
      "To tell the people affected",
      [false, false, false, true, false],
    ],
    [
      "reported and told",
      breach({
        ...assessed,
        decision: decision(true, true),
        report,
        individuals: { notice: "Dear Ada Example, we are writing", toldOn: "2026-10-31" },
      }),
      "close",
      "info",
      "Ready to close",
      [false, false, false, false, true],
    ],
    [
      "decided not to report or tell",
      breach({ ...assessed, decision: decision(false, false) }),
      "close",
      "info",
      "Ready to close",
      [false, true, false, false, true],
    ],
    [
      "closed",
      breach({ ...assessed, decision: decision(false, false), status: "closed", lessons: "Check" }),
      "closed",
      "done",
      "Closed",
      [false, false, false, false, false],
    ],
  ] as const)("%s", (_name, entry, stage, status, label, offered) => {
    expect(breachStage(entry)).toBe(stage);
    expect(breachChip(entry, t)).toEqual({ status, label });
    const forms = breachForms(entry);
    expect([forms.assess, forms.decide, forms.report, forms.tell, forms.close]).toEqual(offered);
  });
});

describe("PLAT-022 the breach register: Harbour's suggestion is decision support only", () => {
  it.each([
    [{ reportToIco: true, tellIndividuals: true }, false],
    [{ reportToIco: false, tellIndividuals: true }, true],
    [{ reportToIco: true, tellIndividuals: false }, true],
    [{ reportToIco: false, tellIndividuals: false }, true],
  ])("against a high suggestion, %o is against it: %s", (choice, against) => {
    expect(againstSuggestion(suggestion, choice)).toBe(against);
  });

  it.each([
    [{ reportToIco: true, tellIndividuals: true }, false],
    [{ reportToIco: false, tellIndividuals: false }, false],
  ])("doing more than a low suggestion is never against it: %o", (choice, against) => {
    const low = { considerReportingToIco: false, considerTellingIndividuals: false };
    expect(againstSuggestion(low, choice)).toBe(against);
  });

  it("says the suggestion as Harbour's, with the decision the person's, and each reason in words", () => {
    expect(suggestionWords(suggestion, t)).toEqual({
      headline:
        "Harbour suggests a high severity breach: consider reporting it to the ICO, and consider telling the people affected; the decision is yours.",
      reasons: [
        "Identifiable data went outside the organisation",
        "Special category data has not been contained",
        "It includes health, care or other special category data",
      ],
    });
    expect(
      suggestionWords(
        {
          severity: "low",
          reasons: ["not_identifiable", "a_new_reason"],
          considerReportingToIco: false,
          considerTellingIndividuals: false,
        },
        t,
      ),
    ).toEqual({
      headline:
        "Harbour suggests a low severity breach: a report to the ICO may not be needed; the decision is yours.",
      reasons: [
        "The people cannot be identified from what was affected",
        "Another reason Harbour does not describe yet",
      ],
    });
  });
});

describe("PLAT-022 the breach register: reading the form", () => {
  it.each([
    ["12", 12],
    ["0", 0],
    [" 1,200 ", 1200],
    ["10000000", 10_000_000],
    ["10000001", null],
    ["-1", null],
    ["1.5", null],
    ["", null],
    ["twelve", null],
  ])("reads %j people affected as %j", (typed, read) => {
    expect(readPeopleAffected(typed)).toBe(read);
  });

  it.each([
    [{ approxPeople: 12, approxRecords: 40 }, "About 12 people, about 40 records"],
    [{ approxPeople: 1, approxRecords: null }, "About 1 person"],
    [{ approxPeople: null, approxRecords: 1 }, "about 1 record"],
    [{ approxPeople: null, approxRecords: null }, null],
  ])("says a Thapsus notice's numbers %o as %j", (numbers, words) => {
    expect(noticeNumbers(numbers, t)).toBe(words);
  });
});

describe("PLAT-022 refusals from the data protection routes", () => {
  it.each([
    ["delay_reason_required", "delayReason", /after the deadline: give the reasons/],
    ["acknowledgement_required", "acknowledgedSuggestion", /tick the box/],
    ["reasoning_required", "reasoning", /reasons for the decision/],
    ["notice_unfinished", "notice", /square brackets/],
    ["ico_right_required", "icoRightStated", /complain to the ICO/],
    ["outcome_required", "outcome", /outcome first/],
    ["aware_at_fixed", "awareAt", /cannot change now/],
  ])("says %s at its field", (code, field, words) => {
    const problem = dataProtectionProblem({ code, detail: "API words" }, t);
    expect(problem.code).toBe(code);
    expect(problem.message).toMatch(words);
    expect(problem.fields?.[field]).toBe(problem.message);
  });

  it.each([
    ["breach_closed", "This breach is closed and cannot be changed."],
    ["not_decided_to_report", "Record a decision to report before recording the report."],
    ["not_told", "Record the notice to the people affected first."],
    ["already_acknowledged", "This has already been acknowledged."],
    ["not_acknowledged", "Record the acknowledgement first."],
    ["not_allowed", "That change is not allowed for this record."],
  ])("says %s in plain words", (code, message) => {
    expect(dataProtectionProblem({ code }, t)).toEqual({ code, message });
  });

  it("says a database guard on the two tables as not allowed, never its code", () => {
    expect(dataProtectionProblem({ code: "dp_breach_aware_at_fixed" }, t)).toEqual({
      code: "not_allowed",
      message: "That change is not allowed for this record.",
    });
  });

  it.each([
    ["step_up_required", "step_up_required"],
    ["version_conflict", "version_conflict"],
    ["missing_permission", "missing_permission"],
    ["something_else", "unavailable"],
  ])("leaves %s to the shared refusals", (code, said) => {
    expect(dataProtectionProblem({ code }, t).code).toBe(said);
  });

  it("says a request that never reached the API as unavailable", () => {
    expect(dataProtectionProblem(undefined, t).code).toBe("unavailable");
  });
});
