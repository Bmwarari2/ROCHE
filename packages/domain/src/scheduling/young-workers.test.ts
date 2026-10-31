import { describe, expect, it } from "vitest";
import {
  check,
  findingsFor,
  HOUR,
  pattern,
  SETTING,
  shift,
  tableWorkingTimeRates,
  uk,
  YOUNG,
} from "../../test/working-time";
import type { WorkPeriod, YoungWorkerException } from "./working-time-types";

const rates = tableWorkingTimeRates();
const daily = rates.youngDailyMaxHours * HOUR;
const weekly = rates.youngWeeklyMaxHours * HOUR;

const continuity: YoungWorkerException = {
  basis: "continuity_or_surge",
  noAdultAvailable: true,
  educationUnaffected: true,
  reason: "Two staff off sick; no adult cover available",
};

describe("young workers' daily and weekly limits (reg 5A; scheduling.md rule 8)", () => {
  it.each<[string, WorkPeriod[], number | null]>([
    ["nine hours in a day", [shift("s", "2026-11-02 08:00", "2026-11-02 17:00")], 9],
    ["eight hours in a day", [shift("s", "2026-11-02 08:00", "2026-11-02 16:00")], null],
    [
      "five hours here and four for another employer",
      [
        shift("s", "2026-11-02 08:00", "2026-11-02 13:00"),
        shift("other", "2026-11-02 14:00", "2026-11-02 18:00", { employer: "other" }),
      ],
      9,
    ],
  ])("%s", (_name, periods, hours) => {
    const findings = findingsFor(
      check(periods, { on: "2026-11-02", worker: YOUNG }),
      "young_daily_max",
    );
    expect(findings.map((f) => f.actualMinutes)).toEqual(hours === null ? [] : [hours * HOUR]);
    for (const f of findings) expect(f).toMatchObject({ outcome: "breach", limitMinutes: daily });
  });

  it("counts the week from midnight between Sunday and Monday", () => {
    const sunday = shift("sun", "2026-11-01 08:00", "2026-11-01 14:00");
    const weekdays = pattern("w", "2026-11-02", "2026-11-06", [1, 2, 3, 4, 5], "08:00", "16:00");
    const saturday = shift("sat", "2026-11-07 08:00", "2026-11-07 10:00");
    const on = { on: "2026-11-02", to: "2026-11-08", worker: YOUNG };
    expect(findingsFor(check([sunday, ...weekdays], on), "young_weekly_max")).toEqual([]);
    expect(findingsFor(check([...weekdays, saturday], on), "young_weekly_max")).toMatchObject([
      {
        outcome: "breach",
        limitMinutes: weekly,
        actualMinutes: 42 * HOUR,
        from: uk("2026-11-02 00:00"),
      },
    ]);
  });

  it("allows the extra hours only with continuity or surge, no adult available and education unaffected", () => {
    const long = (exception?: YoungWorkerException) => [
      shift("s", "2026-11-02 08:00", "2026-11-02 17:00", { youngWorkerException: exception }),
    ];
    const run = (exception?: YoungWorkerException) =>
      findingsFor(
        check(long(exception), { on: "2026-11-02", worker: YOUNG }),
        "young_daily_max",
      )[0];
    expect(run(continuity)).toMatchObject({
      outcome: "conditional",
      conditions: ["reason_recorded"],
      basis: "continuity_or_surge",
    });
    expect(run({ ...continuity, noAdultAvailable: false })?.outcome).toBe("breach");
    expect(run({ ...continuity, educationUnaffected: false })?.outcome).toBe("breach");
    expect(run({ basis: "split_or_short_duration", reason: "Short task" })?.outcome).toBe("breach");
  });

  it("is not lifted by an opt-out from the 48-hour average", () => {
    const optedOut = {
      ...YOUNG,
      optOuts: [{ signedOn: "2026-09-07", endsOn: null, noticePeriod: null, noticeGivenOn: null }],
    };
    const periods = [shift("s", "2026-11-02 08:00", "2026-11-02 17:00")];
    expect(
      findingsFor(check(periods, { on: "2026-11-02", worker: optedOut }), "young_daily_max"),
    ).toHaveLength(1);
  });
});

describe("when a worker stops being a young worker", () => {
  const nineHours = (date: string) => shift(date, `${date} 08:00`, `${date} 17:00`);

  it("applies the limits only before 00:00 UK time on the birthday", () => {
    const turning18 = { ...YOUNG, dateOfBirth: "2008-11-04" };
    const report = check(["2026-11-02", "2026-11-03", "2026-11-04"].map(nineHours), {
      on: "2026-11-02",
      to: "2026-11-04",
      worker: turning18,
    });
    expect(report.youngWorkerUntil).toEqual(uk("2026-11-04 00:00"));
    expect(findingsFor(report, "young_daily_max").map((f) => f.periodIds)).toEqual([
      ["2026-11-02"],
      ["2026-11-03"],
    ]);
  });

  it("takes 1 March as the birthday of someone born on 29 February in other years", () => {
    const leapDay = { ...YOUNG, dateOfBirth: "2008-02-29" };
    const report = check(["2026-02-28", "2026-03-01"].map(nineHours), {
      on: "2026-02-28",
      to: "2026-03-01",
      worker: leapDay,
    });
    expect(report.youngWorkerUntil).toEqual(uk("2026-03-01 00:00"));
    expect(findingsFor(report, "young_daily_max").map((f) => f.periodIds)).toEqual([
      ["2026-02-28"],
    ]);
  });
});

describe("young workers in the restricted period (reg 6A, 27A; scheduling.md rule 8)", () => {
  const late = [shift("late", "2026-11-02 17:00", "2026-11-02 23:00")];

  it("is breached by work from 22:00", () => {
    expect(
      findingsFor(check(late, { on: "2026-11-02", worker: YOUNG }), "young_restricted_period"),
    ).toMatchObject([
      { outcome: "breach", actualMinutes: HOUR, limitMinutes: 0, from: uk("2026-11-02 22:00") },
    ]);
  });

  it("starts at 23:00 when the contract provides for work after 22:00", () => {
    const worker = { ...YOUNG, contractProvidesWorkAfter22: true };
    expect(
      findingsFor(check(late, { on: "2026-11-02", worker }), "young_restricted_period"),
    ).toEqual([]);
  });

  it("is allowed in a hospital or similar establishment for continuity, with supervision and compensatory rest", () => {
    const excepted = late.map((p) => ({ ...p, youngWorkerException: continuity }));
    const setting = { ...SETTING, hospitalOrSimilarEstablishment: true };
    expect(
      findingsFor(
        check(excepted, { on: "2026-11-02", worker: YOUNG, setting }),
        "young_restricted_period",
      ),
    ).toMatchObject([
      {
        outcome: "conditional",
        conditions: ["adult_supervision", "compensatory_rest"],
        compensatoryRestMinutes: HOUR,
      },
    ]);
    expect(
      findingsFor(
        check(excepted, { on: "2026-11-02", worker: YOUNG }),
        "young_restricted_period",
      )[0]?.outcome,
    ).toBe("breach");
  });

  it.each([
    ["the night the clocks go back", "2026-10-24", 9],
    ["the night the clocks go forward", "2026-03-28", 7],
  ])("counts elapsed time on %s", (_name, date, hours) => {
    const next = new Date(`${date}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const nextDate = next.toISOString().split("T")[0];
    const nightShift = [shift("n", `${date} 21:00`, `${nextDate} 07:00`)];
    expect(
      findingsFor(check(nightShift, { on: date, worker: YOUNG }), "young_restricted_period")[0]
        ?.actualMinutes,
    ).toBe(hours * HOUR);
  });
});
