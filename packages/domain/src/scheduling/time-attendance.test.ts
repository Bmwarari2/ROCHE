import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { resolveWorkingTimeRates } from "./rates";
import {
  approvalProblem,
  type ClockEventFact,
  clockFlags,
  currentApproved,
  optOutAgreement,
  pairClockEvents,
  type TimesheetFact,
  timesheetWorkPeriods,
  withinBookedWindow,
  workedMinutes,
} from "./time-attendance";
import { checkWorkingTime } from "./working-time";

const at = (iso: string) => new Date(iso);

describe("hazard HZ-010 clock events keep the device's and the server's time", () => {
  it.each([
    ["on time", "2026-11-02T08:00:00Z", "2026-11-02T08:01:00Z", []],
    ["at the tolerance", "2026-11-02T08:00:00Z", "2026-11-02T08:05:00Z", []],
    ["uploaded late (offline)", "2026-11-02T08:00:00Z", "2026-11-02T10:00:00Z", ["late_upload"]],
    [
      "the device clock ahead",
      "2026-11-02T08:10:00Z",
      "2026-11-02T08:00:00Z",
      ["device_clock_ahead"],
    ],
  ] as const)("hazard HZ-010 %s", (_, device, server, flags) => {
    expect(clockFlags(at(device), at(server), 5)).toEqual(flags);
  });
});

const ev = (id: string, kind: ClockEventFact["kind"], iso: string): ClockEventFact => ({
  id,
  kind,
  at: at(iso),
});

describe("pairing a shift's clock events (rule 4)", () => {
  it("makes a stretch with its breaks", () => {
    const paired = pairClockEvents([
      ev("o", "out", "2026-11-02T20:02:00Z"),
      ev("i", "in", "2026-11-02T07:58:00Z"),
      ev("b1", "break_start", "2026-11-02T12:00:00Z"),
      ev("b2", "break_end", "2026-11-02T12:30:00Z"),
    ]);
    expect(paired).toEqual({
      start: at("2026-11-02T07:58:00Z"),
      end: at("2026-11-02T20:02:00Z"),
      breaks: [{ start: at("2026-11-02T12:00:00Z"), end: at("2026-11-02T12:30:00Z") }],
      clockInId: "i",
      clockOutId: "o",
      problems: [],
    });
  });

  it.each([
    ["no clock-out", [ev("i", "in", "2026-11-02T08:00:00Z")], ["no_clock_out"]],
    ["no clock-in", [ev("o", "out", "2026-11-02T20:00:00Z")], ["no_clock_in"]],
    [
      "a break never ended",
      [
        ev("i", "in", "2026-11-02T08:00:00Z"),
        ev("b", "break_start", "2026-11-02T12:00:00Z"),
        ev("o", "out", "2026-11-02T20:00:00Z"),
      ],
      ["break_not_ended"],
    ],
    [
      "a break ended that never started",
      [
        ev("i", "in", "2026-11-02T08:00:00Z"),
        ev("b", "break_end", "2026-11-02T12:00:00Z"),
        ev("o", "out", "2026-11-02T20:00:00Z"),
      ],
      ["break_not_started"],
    ],
  ] as const)("lists %s and guesses nothing", (_, events, problems) => {
    expect(pairClockEvents(events).problems).toEqual(problems);
  });
});

const entry = (over: Partial<TimesheetFact>): TimesheetFact => ({
  id: "e1",
  workerId: "w",
  kind: "work",
  start: at("2026-11-02T08:00:00Z"),
  end: at("2026-11-02T20:00:00Z"),
  breaks: [],
  travel: null,
  status: "draft",
  supersedesId: null,
  ...over,
});

describe("approval never by the worker (rule 5)", () => {
  it.each([
    ["a draft by a manager", entry({}), "m", new Set<string>(), null],
    ["the worker's own", entry({}), "w", new Set<string>(), "own_entry"],
    ["an approved entry", entry({ status: "approved" }), "m", new Set<string>(), "not_draft"],
    ["a superseded draft", entry({}), "m", new Set(["e1"]), "superseded"],
    [
      "times out of order",
      entry({ end: at("2026-11-02T07:00:00Z") }),
      "m",
      new Set<string>(),
      "times_out_of_order",
    ],
  ] as const)("%s", (_, e, approver, superseded, problem) => {
    expect(approvalProblem(e, approver, superseded)).toBe(problem);
  });
});

describe("corrections supersede only once approved (rule 6)", () => {
  const original = entry({ id: "a", status: "approved" });
  it("keeps the original while the correction is a draft", () => {
    const { current } = currentApproved([original, entry({ id: "b", supersedesId: "a" })]);
    expect(current.map((e) => e.id)).toEqual(["a"]);
  });

  it("replaces the original once the correction is approved, and strikes it through", () => {
    const { current, superseded } = currentApproved([
      original,
      entry({ id: "b", supersedesId: "a", status: "approved" }),
    ]);
    expect(current.map((e) => e.id)).toEqual(["b"]);
    expect([...superseded]).toEqual(["a"]);
  });
});

describe("approved time as working time (rule 7)", () => {
  it("counts actual breaks and leaves drafts out", () => {
    const periods = timesheetWorkPeriods([
      entry({
        id: "a",
        status: "approved",
        breaks: [{ start: at("2026-11-02T12:00:00Z"), end: at("2026-11-02T12:30:00Z") }],
      }),
      entry({ id: "d", start: at("2026-11-03T08:00:00Z"), end: at("2026-11-03T20:00:00Z") }),
    ]);
    expect(periods.map((p) => p.id)).toEqual(["a"]);
    expect(periods[0]?.breaks?.length).toBe(1);
  });

  it("finds too little daily rest between two approved shifts", () => {
    const rates = resolveWorkingTimeRates(readRateTable(), "england", "2026-11-02");
    const report = checkWorkingTime({
      worker: {
        dateOfBirth: "1990-01-01",
        employmentStart: "2025-01-01",
        optOuts: [],
        designatedNightWorker: false,
        specialHazards: false,
        contractProvidesWorkAfter22: false,
      },
      setting: {
        derogations: [],
        successiveReferencePeriodsFrom: null,
        agreedReferencePeriodWeeks: null,
        agreedNightReferencePeriodWeeks: null,
        agreedNightTime: null,
        weeklyRestBasis: "each_week",
        weeklyRestPeriodsFrom: null,
        weeklyRestMayIncludeDailyRest: false,
        hospitalOrSimilarEstablishment: false,
      },
      periods: timesheetWorkPeriods([
        entry({
          id: "late",
          status: "approved",
          start: at("2026-11-02T14:00:00Z"),
          end: at("2026-11-02T22:00:00Z"),
        }),
        entry({
          id: "early",
          status: "approved",
          start: at("2026-11-03T06:00:00Z"),
          end: at("2026-11-03T14:00:00Z"),
        }),
      ]),
      excludedDays: [],
      evaluateFrom: "2026-11-02",
      evaluateTo: "2026-11-03",
      known: { start: at("2026-11-02T00:00:00Z"), end: at("2026-11-04T00:00:00Z") },
      rates,
    });
    expect(report.findings.some((f) => f.rule === "daily_rest")).toBe(true);
  });

  it.each([
    ["no break", [], 720],
    ["a 30-minute break", [["12:00", "12:30"]], 690],
    ["a break partly outside", [["19:45", "20:15"]], 705],
  ] as const)("worked minutes with %s", (_, breaks, minutes) => {
    expect(
      workedMinutes(
        entry({
          breaks: breaks.map(([s, e]) => ({
            start: at(`2026-11-02T${s}:00Z`),
            end: at(`2026-11-02T${e}:00Z`),
          })),
        }),
      ),
    ).toBe(minutes);
  });
});

describe("opt-outs and windows", () => {
  it("reads an opt-out on file with its notice", () => {
    expect(
      optOutAgreement({
        signedOn: "2026-01-01",
        endsOn: null,
        noticeAmount: 3,
        noticeUnit: "months",
        noticeGivenOn: null,
      }),
    ).toEqual({
      signedOn: "2026-01-01",
      endsOn: null,
      noticePeriod: { amount: 3, unit: "months" },
      noticeGivenOn: null,
    });
  });

  it.each([
    ["before the shift", "2026-11-02T07:59:00Z", false],
    ["during it", "2026-11-02T12:00:00Z", true],
    ["in the hours after", "2026-11-02T21:30:00Z", true],
    ["after them", "2026-11-02T22:00:00Z", false],
  ] as const)("a device time %s is in the booked window: %s", (_, device, inside) => {
    expect(
      withinBookedWindow(
        at(device),
        { start: at("2026-11-02T08:00:00Z"), end: at("2026-11-02T20:00:00Z") },
        2,
      ),
    ).toBe(inside);
  });
});
