import { describe, expect, it } from "vitest";
import {
  assessBreach,
  BREACH_REASONING_MIN,
  type BreachFactors,
  breachClock,
  checkBreachDecision,
  checkComplaintClosure,
  complaintClock,
  DATA_RIGHTS_RATE_KEYS,
  type DsarInput,
  dsarClock,
  resolveDataRightsRates,
  resolveOptionalRate,
} from "./data-rights";
import type { RateRow } from "./rates";

/**
 * Data rights rules (platform.md, Phase 2: data rights, imports and single sign-on, rules 1 to 10;
 * PLAT-022). Periods come from the rate table; the figures below stand in for the rows in rates.md.
 */

const RATES = { responseMonths: 1, extensionMonths: 2, dueSoonDays: 7 };
/** England and Wales bank holidays used in these cases (the real ones come from the table). */
const HOLIDAYS = new Set(["2026-12-25", "2026-12-28", "2027-01-01", "2026-05-04", "2026-08-31"]);

const request = (o: Partial<DsarInput> = {}): DsarInput => ({
  receivedOn: "2026-09-03",
  identity: { required: false, receivedOn: null },
  pauses: [],
  extension: null,
  respondedOn: null,
  ...o,
});

describe("PLAT-022 the DSAR clock", () => {
  it.each([
    ["a weekday, to the corresponding date", "2026-09-03", "2026-10-05"],
    ["a Saturday: the clock still starts that day", "2026-10-03", "2026-11-03"],
    ["31 January in a common year: the last day of February", "2027-01-31", "2027-03-01"],
    ["31 January in a leap year: 29 February", "2028-01-31", "2028-02-29"],
    ["31 March: 30 April", "2026-03-31", "2026-04-30"],
    ["due on Christmas Day: the next working day", "2026-11-25", "2026-12-29"],
    ["due on a bank holiday Monday: Tuesday", "2026-07-31", "2026-09-01"],
  ])("received on %s", (_name, receivedOn, dueOn) => {
    // 3 October 2026 is a Saturday; 5 October the Monday after 3 October (a Saturday).
    const clock = dsarClock(request({ receivedOn }), RATES, HOLIDAYS, receivedOn);
    expect(clock).toMatchObject({ ok: true, startedOn: receivedOn, dueOn });
  });

  it("does not start until identity information arrives, then counts from that day", () => {
    const waiting = dsarClock(
      request({ identity: { required: true, receivedOn: null } }),
      RATES,
      HOLIDAYS,
      "2026-09-20",
    );
    expect(waiting).toMatchObject({ ok: true, state: "awaiting_identity", dueOn: null });
    const started = dsarClock(
      request({ identity: { required: true, receivedOn: "2026-09-10" } }),
      RATES,
      HOLIDAYS,
      "2026-09-20",
    );
    expect(started).toMatchObject({ ok: true, startedOn: "2026-09-10", dueOn: "2026-10-12" });
  });

  it("adds each whole day paused for clarification, and shows no due date while paused", () => {
    const paused = dsarClock(
      request({ pauses: [{ from: "2026-09-10", to: null }] }),
      RATES,
      HOLIDAYS,
      "2026-12-01",
    );
    expect(paused).toMatchObject({ ok: true, state: "paused", dueOn: null });
    const resumed = dsarClock(
      request({ pauses: [{ from: "2026-09-10", to: "2026-09-17" }] }),
      RATES,
      HOLIDAYS,
      "2026-09-20",
    );
    // 3 October plus 7 days paused is 10 October, a Saturday: Monday 12 October.
    expect(resumed).toMatchObject({ ok: true, pausedDays: 7, dueOn: "2026-10-12" });
  });

  it.each([
    ["a pause before the clock starts", [{ from: "2026-09-01", to: "2026-09-04" }]],
    ["a pause that ends before it starts", [{ from: "2026-09-10", to: "2026-09-09" }]],
    [
      "overlapping pauses",
      [
        { from: "2026-09-10", to: "2026-09-15" },
        { from: "2026-09-14", to: "2026-09-20" },
      ],
    ],
    [
      "a pause after one still open",
      [
        { from: "2026-09-10", to: null },
        { from: "2026-09-20", to: "2026-09-21" },
      ],
    ],
  ])("refuses %s", (_name, pauses) => {
    expect(dsarClock(request({ pauses }), RATES, HOLIDAYS, "2026-09-25")).toMatchObject({
      ok: false,
      problem: "invalid_pause",
    });
  });

  it("extends by up to two months when complex, decided before the original due date", () => {
    const clock = dsarClock(
      request({
        extension: {
          decidedOn: "2026-09-25",
          grounds: "complex",
          reason: "Records span three services",
          months: 2,
        },
      }),
      RATES,
      HOLIDAYS,
      "2026-09-26",
    );
    // 3 September plus three months: 3 December 2026, a Thursday.
    expect(clock).toMatchObject({
      ok: true,
      originalDueOn: "2026-10-05",
      dueOn: "2026-12-03",
      extended: true,
    });
  });

  it.each([
    [
      "after the original due date",
      { decidedOn: "2026-10-06", grounds: "complex", reason: "Late", months: 2 },
      "extension_too_late",
    ],
    [
      "beyond three months in total",
      { decidedOn: "2026-09-25", grounds: "complex", reason: "Large", months: 3 },
      "extension_too_long",
    ],
    [
      "without a reason",
      { decidedOn: "2026-09-25", grounds: "multiple_requests", reason: " ", months: 1 },
      "extension_reason_required",
    ],
    [
      "of no months",
      { decidedOn: "2026-09-25", grounds: "complex", reason: "Records", months: 0 },
      "extension_too_long",
    ],
  ] as const)("refuses an extension %s", (_name, extension, problem) => {
    expect(
      dsarClock(request({ extension: { ...extension } }), RATES, HOLIDAYS, "2026-09-26"),
    ).toMatchObject({ ok: false, problem });
  });

  it.each([
    ["well before the due date", "2026-09-10", "running"],
    ["within the warning days", "2026-09-30", "due_soon"],
    ["on the due date", "2026-10-05", "due_soon"],
    ["after the due date", "2026-10-06", "overdue"],
  ])("is %s", (_name, today, state) => {
    expect(dsarClock(request(), RATES, HOLIDAYS, today)).toMatchObject({ ok: true, state });
  });

  it("closes on the response, recording a late one as late", () => {
    expect(
      dsarClock(request({ respondedOn: "2026-10-01" }), RATES, HOLIDAYS, "2026-11-01"),
    ).toMatchObject({ ok: true, state: "closed", late: false });
    expect(
      dsarClock(request({ respondedOn: "2026-10-07" }), RATES, HOLIDAYS, "2026-11-01"),
    ).toMatchObject({ ok: true, state: "closed", late: true });
  });

  it("refuses dates that are not real", () => {
    expect(
      dsarClock(request({ receivedOn: "2026-02-30" }), RATES, HOLIDAYS, "2026-03-01"),
    ).toMatchObject({ ok: false, problem: "invalid_date" });
  });
});

const factors = (o: Partial<BreachFactors> = {}): BreachFactors => ({
  peopleAffected: 1,
  identifiable: true,
  specialCategory: false,
  safeguardingOrLocationAtRisk: false,
  disclosedOutsideOrganisation: false,
  careRecordsUnavailable: false,
  contained: true,
  ...o,
});

describe("PLAT-022 the breach clock and decision support", () => {
  const HOURS = { reportHours: 72 };

  it("runs 72 hours from awareness through a weekend and the clock change", () => {
    // Aware on Friday 23 October 2026 at 16:00 BST; the clocks go back on Sunday 25 October.
    const awareAt = new Date("2026-10-23T15:00:00Z");
    const clock = breachClock({ awareAt, reportedAt: null, delayReason: null }, HOURS, awareAt);
    expect(clock.deadline.toISOString()).toBe("2026-10-26T15:00:00.000Z");
    expect(clock).toMatchObject({ state: "open", hoursLeft: 72 });
    const late = breachClock(
      { awareAt, reportedAt: null, delayReason: null },
      HOURS,
      new Date("2026-10-26T16:00:00Z"),
    );
    expect(late).toMatchObject({ state: "overdue", hoursLeft: 0 });
  });

  it("records a report on time, and a late one with the reasons for the delay", () => {
    const awareAt = new Date("2026-10-23T15:00:00Z");
    expect(
      breachClock(
        { awareAt, reportedAt: new Date("2026-10-25T10:00:00Z"), delayReason: null },
        HOURS,
        new Date("2026-10-27T00:00:00Z"),
      ),
    ).toMatchObject({ state: "reported_on_time" });
    expect(
      breachClock(
        {
          awareAt,
          reportedAt: new Date("2026-10-27T10:00:00Z"),
          delayReason: "Scope was not known",
        },
        HOURS,
        new Date("2026-10-28T00:00:00Z"),
      ),
    ).toMatchObject({ state: "reported_late", delayReasonRequired: true, delayReasonGiven: true });
    expect(
      breachClock(
        { awareAt, reportedAt: new Date("2026-10-27T10:00:00Z"), delayReason: "  " },
        HOURS,
        new Date("2026-10-28T00:00:00Z"),
      ),
    ).toMatchObject({ state: "reported_late", delayReasonGiven: false });
  });

  it.each([
    ["an email deleted unread inside the organisation", factors({ specialCategory: false }), "low"],
    ["nobody can be identified", factors({ identifiable: false, specialCategory: true }), "low"],
    [
      "one person's care record seen without a care relationship",
      factors({ specialCategory: true }),
      "medium",
    ],
    [
      "several people's records disclosed outside the organisation",
      factors({ peopleAffected: 4, disclosedOutsideOrganisation: true, specialCategory: true }),
      "high",
    ],
    ["a lost device not contained", factors({ contained: false, specialCategory: true }), "high"],
    [
      "the location of a person at risk disclosed",
      factors({ safeguardingOrLocationAtRisk: true }),
      "critical",
    ],
    [
      "care records unavailable (ransomware)",
      factors({ identifiable: false, careRecordsUnavailable: true }),
      "critical",
    ],
  ])("suggests a severity for %s, never a decision", (_name, f, severity) => {
    const assessment = assessBreach(f);
    expect(assessment.suggestedSeverity).toBe(severity);
    expect(assessment.reasons.length).toBeGreaterThan(0);
    expect(assessment).not.toHaveProperty("decision");
    expect(assessment.considerReportingToIco).toBe(severity !== "low");
    expect(assessment.considerTellingIndividuals).toBe(
      severity === "high" || severity === "critical",
    );
  });

  it("refuses a negative or fractional count of people", () => {
    expect(() => assessBreach(factors({ peopleAffected: -1 }))).toThrow(RangeError);
    expect(() => assessBreach(factors({ peopleAffected: 1.5 }))).toThrow(RangeError);
  });

  const reasoning = "x".repeat(BREACH_REASONING_MIN);
  it.each([
    [
      "no reasoning",
      "low",
      { reportToIco: false, tellIndividuals: false, reasoning: "short" },
      "reasoning_required",
    ],
    [
      "no decider",
      "low",
      { reportToIco: false, tellIndividuals: false, reasoning, decidedBy: null },
      "decider_required",
    ],
    [
      "not reporting a medium breach without saying the suggestion was considered",
      "medium",
      { reportToIco: false, tellIndividuals: false, reasoning },
      "acknowledgement_required",
    ],
    [
      "not telling individuals of a high-risk breach without acknowledgement",
      "high",
      { reportToIco: true, tellIndividuals: false, reasoning },
      "acknowledgement_required",
    ],
  ] as const)("refuses a decision with %s", (_name, severity, decision, problem) => {
    const assessment = assessBreach(
      severity === "low"
        ? factors()
        : severity === "medium"
          ? factors({ specialCategory: true })
          : factors({ contained: false, specialCategory: true }),
    );
    expect(
      checkBreachDecision(
        { decidedBy: "tenant-user-1", acknowledgedSuggestion: false, ...decision },
        assessment,
      ),
    ).toMatchObject({ ok: false, problem });
  });

  it("takes a person's decision against the suggestion when they say they considered it", () => {
    const assessment = assessBreach(factors({ specialCategory: true }));
    expect(
      checkBreachDecision(
        {
          reportToIco: false,
          tellIndividuals: false,
          reasoning,
          decidedBy: "tenant-user-1",
          acknowledgedSuggestion: true,
        },
        assessment,
      ),
    ).toEqual({ ok: true });
  });
});

describe("PLAT-022 complaint clocks", () => {
  const COMPLAINT = { acknowledgeDays: 30, targetWorkingDays: 3, updateIntervalMonths: 1 };

  it("acknowledges within 30 calendar days of receipt, with the working-day target alongside", () => {
    const clock = complaintClock(
      { receivedOn: "2026-07-03", acknowledgedOn: null, lastContactOn: null, closedOn: null },
      COMPLAINT,
      HOLIDAYS,
      "2026-07-04",
    );
    // Friday 3 July: the target is Wednesday 8 July, the duty Sunday 2 August.
    expect(clock).toMatchObject({
      acknowledgeDueOn: "2026-08-02",
      acknowledgeTargetOn: "2026-07-08",
      acknowledgement: "due",
    });
  });

  it("has no statutory acknowledgement clock before the duty began", () => {
    const clock = complaintClock(
      { receivedOn: "2026-06-01", acknowledgedOn: null, lastContactOn: null, closedOn: null },
      { ...COMPLAINT, acknowledgeDays: null },
      HOLIDAYS,
      "2026-08-01",
    );
    expect(clock).toMatchObject({ acknowledgeDueOn: null, acknowledgement: "not_applicable" });
  });

  it.each([
    ["overdue", { acknowledgedOn: null }, "2026-08-03", "overdue"],
    ["done in time", { acknowledgedOn: "2026-07-10" }, "2026-08-03", "done"],
    ["done late", { acknowledgedOn: "2026-08-05" }, "2026-08-06", "done_late"],
  ])("says when the acknowledgement is %s", (_name, o, today, acknowledgement) => {
    expect(
      complaintClock(
        {
          receivedOn: "2026-07-03",
          lastContactOn: null,
          closedOn: null,
          ...o,
        },
        COMPLAINT,
        HOLIDAYS,
        today,
      ),
    ).toMatchObject({ acknowledgement });
  });

  it("asks for an update at least monthly from the last contact while open", () => {
    const open = complaintClock(
      {
        receivedOn: "2026-07-03",
        acknowledgedOn: "2026-07-06",
        lastContactOn: "2026-07-31",
        closedOn: null,
      },
      COMPLAINT,
      HOLIDAYS,
      "2026-09-01",
    );
    expect(open).toMatchObject({ nextUpdateDueOn: "2026-08-31", update: "overdue" });
    const closed = complaintClock(
      {
        receivedOn: "2026-07-03",
        acknowledgedOn: "2026-07-06",
        lastContactOn: "2026-07-31",
        closedOn: "2026-08-10",
      },
      COMPLAINT,
      HOLIDAYS,
      "2026-09-01",
    );
    expect(closed).toMatchObject({ nextUpdateDueOn: null, update: "closed" });
  });

  it("closes only with an outcome that names the right to complain to the ICO", () => {
    expect(checkComplaintClosure({ outcomeRecorded: true, icoRightStated: false })).toMatchObject({
      ok: false,
      problem: "ico_right_required",
    });
    expect(checkComplaintClosure({ outcomeRecorded: false, icoRightStated: true })).toMatchObject({
      ok: false,
      problem: "outcome_required",
    });
    expect(checkComplaintClosure({ outcomeRecorded: true, icoRightStated: true })).toEqual({
      ok: true,
    });
  });
});

describe("resolveDataRightsRates", () => {
  const row = (key: string, value: number, validFrom = "2018-05-25"): RateRow => ({
    key,
    value,
    unit: "x",
    nation: "uk",
    validFrom,
    validTo: null,
    tenantId: null,
    verificationStatus: "master-prompt",
    source: "rates.md",
  });
  const rows = [
    row("dsar.response_months", 1),
    row("dsar.extension_months", 2),
    row("dsar.due_soon_days", 7),
    row("ico.breach.report_hours", 72),
    row("dp_complaint.acknowledge_days", 30, "2026-06-19"),
    row("dp_complaint.acknowledge_target_working_days", 3, "2026-06-19"),
    row("dp_complaint.update_interval_months", 1, "2026-06-19"),
    row("import.undo_window_days", 7, "2026-10-31"),
  ];

  it("reads every figure from the rate table", () => {
    expect(resolveDataRightsRates(rows, "england", "2026-11-01", null)).toEqual({
      dsarResponseMonths: 1,
      dsarExtensionMonths: 2,
      dsarDueSoonDays: 7,
      breachReportHours: 72,
      complaintAcknowledgeDays: 30,
      complaintAcknowledgeTargetWorkingDays: 3,
      complaintUpdateIntervalMonths: 1,
      importUndoWindowDays: 7,
    });
    expect(Object.keys(DATA_RIGHTS_RATE_KEYS)).toHaveLength(8);
  });

  it("fails loudly when a figure is missing", () => {
    expect(() => resolveDataRightsRates(rows.slice(1), "england", "2026-11-01", null)).toThrow(
      /dsar.response_months/,
    );
  });

  it("gives no figure, rather than failing, for a duty not yet in force on the date", () => {
    expect(
      resolveOptionalRate(rows, "dp_complaint.acknowledge_days", "england", "2026-06-01", null),
    ).toBeNull();
    expect(
      resolveOptionalRate(rows, "dp_complaint.acknowledge_days", "england", "2026-07-01", null),
    ).toBe(30);
  });
});
