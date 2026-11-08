import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { addDays, addMonths } from "./dates";
import { resolveWorkforceRates } from "./rates";
import {
  intervalMonths,
  type MeetingDue,
  meetingReminderKey,
  meetingReminders,
  meetingsDue,
  meetingsNeedAttention,
  nextMeeting,
  type SupervisionRecord,
} from "./supervision";

const rates = resolveWorkforceRates(readRateTable(), "england", "2026-10-31", null);
const STARTED = "2026-01-12";

describe("supervision and appraisal (workforce.md rule 7)", () => {
  it.each([
    [6, 2],
    [4, 3],
    [1, 12],
    [12, 1],
    [24, 1],
  ])("%i a year means one every %i months", (perYear, months) => {
    expect(intervalMonths(perYear)).toBe(months);
  });

  it("refuses a number a year of zero", () => {
    expect(() => intervalMonths(0)).toThrow(RangeError);
  });

  it("is due one interval after the start date when none has been held", () => {
    const due = addMonths(STARTED, intervalMonths(rates.supervisionsPerYear));
    expect(
      nextMeeting("supervision", [], STARTED, rates.supervisionsPerYear, "2026-01-20"),
    ).toEqual({
      kind: "supervision",
      dueOn: due,
      state: "upcoming",
    });
  });

  it("is due one interval after the last held, never counting spot checks", () => {
    const records: SupervisionRecord[] = [
      { kind: "supervision", heldOn: "2026-05-04" },
      { kind: "spot_check", heldOn: "2026-09-01" },
      { kind: "appraisal", heldOn: "2026-02-01" },
    ];
    const due = addMonths("2026-05-04", intervalMonths(rates.supervisionsPerYear));
    expect(nextMeeting("supervision", records, STARTED, rates.supervisionsPerYear, due).state).toBe(
      "due",
    );
    expect(
      nextMeeting("supervision", records, STARTED, rates.supervisionsPerYear, addDays(due, 1))
        .state,
    ).toBe("overdue");
    expect(
      nextMeeting("appraisal", records, STARTED, rates.appraisalsPerYear, "2026-10-31").dueOn,
    ).toBe(addMonths("2026-02-01", intervalMonths(rates.appraisalsPerYear)));
  });

  it("shows as due within a window before the date", () => {
    const due = addMonths(STARTED, intervalMonths(rates.supervisionsPerYear));
    expect(
      nextMeeting("supervision", [], STARTED, rates.supervisionsPerYear, addDays(due, -7), 7).state,
    ).toBe("due");
    expect(
      nextMeeting("supervision", [], STARTED, rates.supervisionsPerYear, addDays(due, -8), 7).state,
    ).toBe("upcoming");
  });
});

describe("WORK-009 supervisions and appraisals due across staff (rule 7)", () => {
  const perYear = { supervision: rates.supervisionsPerYear, appraisal: rates.appraisalsPerYear };
  const window = rates.supervisionDueWindowDays;
  const last = "2026-05-04";
  const due = addMonths(last, intervalMonths(rates.supervisionsPerYear));
  const held: SupervisionRecord[] = [
    { kind: "supervision", heldOn: last },
    { kind: "spot_check", heldOn: "2026-06-01" },
  ];

  it.each([
    ["well before the window", addDays(due, -(window + 1)), "upcoming"],
    ["on the first day of the window", addDays(due, -window), "due"],
    ["on the day it falls due", due, "due"],
    ["the day after", addDays(due, 1), "overdue"],
  ])("a supervision %s is %s", (_when, today, state) => {
    const [supervision] = meetingsDue(held, perYear, today, window);
    expect(supervision).toEqual({ kind: "supervision", lastHeldOn: last, dueOn: due, state });
  });

  it("never counts a spot check, and says none is recorded rather than guessing a date", () => {
    const [supervision, appraisal] = meetingsDue(
      [{ kind: "spot_check", heldOn: "2026-06-01" }],
      perYear,
      "2026-10-31",
      window,
    );
    expect(supervision).toEqual({
      kind: "supervision",
      lastHeldOn: null,
      dueOn: null,
      state: "none_recorded",
    });
    expect(appraisal.state).toBe("none_recorded");
    expect(meetingsNeedAttention([supervision, appraisal])).toBe(true);
  });

  it("counts from the start date when it is known and none has been held", () => {
    const [, appraisal] = meetingsDue([], perYear, "2026-02-01", window, STARTED);
    expect(appraisal.dueOn).toBe(addMonths(STARTED, intervalMonths(rates.appraisalsPerYear)));
    expect(appraisal.state).toBe("upcoming");
  });

  it("ignores a meeting recorded for a date after today", () => {
    const [supervision] = meetingsDue(
      [{ kind: "supervision", heldOn: "2027-01-01" }],
      perYear,
      "2026-10-31",
      window,
    );
    expect(supervision.state).toBe("none_recorded");
  });

  it.each([
    [["upcoming", "upcoming"], false],
    [["upcoming", "due"], true],
    [["overdue", "upcoming"], true],
    [["none_recorded", "upcoming"], true],
  ] as const)("states %j need attention: %s", (states, attention) => {
    const meetings = states.map((state, i) => ({
      kind: i === 0 ? ("supervision" as const) : ("appraisal" as const),
      lastHeldOn: null,
      dueOn: null,
      state,
    }));
    expect(meetingsNeedAttention(meetings)).toBe(attention);
  });
});

describe("WORK-009 reminder tasks for supervisions and appraisals due (rule 7)", () => {
  const meeting = (
    kind: "supervision" | "appraisal",
    state: MeetingDue["state"],
    dueOn: string | null,
  ): MeetingDue => ({ kind, lastHeldOn: null, dueOn, state });
  it.each([
    [
      "overdue: urgent",
      [meeting("supervision", "overdue", "2026-10-01")],
      [],
      [["supervision", "2026-10-01", "urgent"]],
    ],
    [
      "due inside the window: routine",
      [meeting("appraisal", "due", "2026-11-10")],
      [],
      [["appraisal", "2026-11-10", "routine"]],
    ],
    ["upcoming: none", [meeting("supervision", "upcoming", "2027-01-01")], [], []],
    [
      "none recorded: none, never a guessed date",
      [meeting("supervision", "none_recorded", null)],
      [],
      [],
    ],
    [
      "already raised for that date: none",
      [meeting("supervision", "overdue", "2026-10-01")],
      ["supervision:2026-10-01"],
      [],
    ],
    [
      "raised for an earlier date, now due again: a new one",
      [meeting("supervision", "due", "2027-01-01")],
      ["supervision:2026-10-01"],
      [["supervision", "2027-01-01", "routine"]],
    ],
    [
      "each kind on its own",
      [meeting("supervision", "overdue", "2026-10-01"), meeting("appraisal", "due", "2026-11-10")],
      ["appraisal:2026-11-10"],
      [["supervision", "2026-10-01", "urgent"]],
    ],
  ] as const)("%s", (_name, meetings, raised, expected) => {
    expect(
      meetingReminders(meetings, new Set(raised)).map((r) => [r.kind, r.dueOn, r.priority]),
    ).toEqual(expected);
  });

  it("keys a reminder by kind and due date", () => {
    expect(meetingReminderKey("appraisal", "2026-11-10")).toBe("appraisal:2026-11-10");
  });
});
