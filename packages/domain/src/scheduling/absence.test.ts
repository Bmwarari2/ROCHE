import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { addCalendarMonths } from "../platform/data-rights";
import {
  ABSENCE_KINDS,
  type AbsenceKind,
  type AbsenceState,
  absenceDays,
  absentOn,
  assignmentsNeedingCover,
  bradfordDays,
  carersLeaveTaken,
  checkAbsenceMove,
  checkNewAbsence,
  checkPostponement,
  fitNoteNeeded,
  POSTPONEMENT_RATE_KEYS,
  type PostponableKind,
  periodsOfIncapacity,
  postponementLimits,
  qualifyingDaysIn,
  resolveAbsenceRates,
  resolvePostponementRates,
  STATUTORY_LEAVE_KINDS,
} from "./absence";
import { plusDays } from "./intervals";

/** Absence and leave (scheduling.md section 17; SCHED-010; HZ-123, HZ-124). Invented people. */

const rates = resolveAbsenceRates(readRateTable(), "england", "2026-10-31", null);
const TODAY = "2026-10-31";
const ADA = "0194d000-0000-7000-8000-0000000003a1";
const MO = "0194d000-0000-7000-8000-0000000003a2";

describe("the figures come from the rate table, Great Britain only", () => {
  it("reads them for England", () => {
    expect(rates).toEqual({
      carersLeaveWeeks: 1,
      selfCertificationDays: 7,
      piwMinDays: 4,
      piwLinkWeeks: 8,
    });
  });
  it("has none for Northern Ireland, whose SSP is separate", () => {
    expect(resolveAbsenceRates(readRateTable(), "northern_ireland", TODAY, null)).toEqual({
      carersLeaveWeeks: null,
      selfCertificationDays: null,
      piwMinDays: null,
      piwLinkWeeks: null,
    });
  });
});

describe("rule 1: decisions and state moves", () => {
  it.each([
    ["approve another's request", "requested", "approved", MO, null, null],
    ["approve one's own request", "requested", "approved", ADA, null, "decider_is_member"],
    ["decline without a reason", "requested", "declined", MO, null, "reason_required"],
    ["decline with a reason", "requested", "declined", MO, "Short-staffed that week", null],
    ["cancel one's own request, no reason", "requested", "cancelled", ADA, null, null],
    [
      "cancel an approved absence without a reason",
      "approved",
      "cancelled",
      MO,
      null,
      "reason_required",
    ],
    [
      "cancel a recorded sickness with a reason",
      "recorded",
      "cancelled",
      MO,
      "Recorded twice",
      null,
    ],
    ["approve a declined request", "declined", "approved", MO, null, "wrong_state"],
    ["reopen a cancelled absence", "cancelled", "requested", MO, null, "wrong_state"],
    ["approve a recorded absence", "recorded", "approved", MO, null, "wrong_state"],
  ] as const)("%s", (_n, from, to, actorId, reason, problem) => {
    expect(checkAbsenceMove({ from, to, memberId: ADA, actorId, reason })).toBe(problem);
  });

  it.each([
    ["leave requested", "annual_leave", "2026-11-02", "2026-11-06", true, null],
    ["sickness is never requested", "sickness", "2026-11-02", null, true, "sickness_not_requested"],
    ["sickness recorded open", "sickness", "2026-11-02", null, false, null],
    ["leave needs an end", "annual_leave", "2026-11-02", null, false, "leave_needs_end"],
    [
      "ends before it starts",
      "annual_leave",
      "2026-11-06",
      "2026-11-02",
      true,
      "ends_before_start",
    ],
  ] as const)("%s", (_n, kind, startsOn, endsOn, requested, problem) => {
    expect(checkNewAbsence({ kind, startsOn, endsOn, requested })).toBe(problem);
  });
});

describe("the days of an absence", () => {
  it.each([
    ["a closed week", "2026-11-02", "2026-11-06", 5],
    ["one day", "2026-11-02", "2026-11-02", 1],
    ["open, counted to today", "2026-10-29", null, 3],
    ["open, starting later than today", "2026-11-05", null, 1],
    // The clocks went back on 25 October: still one day each.
    ["across the clock change", "2026-10-24", "2026-10-26", 3],
  ] as const)("%s", (_n, from, to, n) => {
    expect(absenceDays(from, to, TODAY)).toHaveLength(n);
  });
});

describe("rule 3: a fit note is needed after the self-certification days", () => {
  it.each([
    ["seven days, self-certified", "2026-10-01", "2026-10-07", [], false, []],
    ["eight days, no note", "2026-10-01", "2026-10-08", [], true, ["2026-10-08"]],
    [
      "ten days, a note covering day 8 to 10",
      "2026-10-01",
      "2026-10-10",
      [{ coversFrom: "2026-10-08", coversTo: "2026-10-14" }],
      true,
      [],
    ],
    [
      "ten days, a note from day 9",
      "2026-10-01",
      "2026-10-10",
      [{ coversFrom: "2026-10-09", coversTo: "2026-10-14" }],
      true,
      ["2026-10-08"],
    ],
  ] as const)("%s", (_n, from, to, notes, needed, uncovered) => {
    const out = fitNoteNeeded(from, to, TODAY, notes, rates);
    expect(out.needed).toBe(needed);
    if (out.needed) expect(out.uncoveredDays).toEqual(uncovered);
  });

  it("does not apply where the nation has no rate", () => {
    expect(
      fitNoteNeeded("2026-10-01", "2026-10-20", TODAY, [], { selfCertificationDays: null }),
    ).toEqual({
      needed: false,
      reason: "no_rate_for_nation",
    });
  });
});

describe("rule 6: periods of incapacity for work link within the link weeks", () => {
  const spell = (id: string, startsOn: string, endsOn: string | null) => ({ id, startsOn, endsOn });
  it.each([
    ["three days is not a period", [spell("a", "2026-09-01", "2026-09-03")], []],
    ["four days is one", [spell("a", "2026-09-01", "2026-09-04")], [["a"]]],
    [
      "two periods 56 days apart link",
      [spell("a", "2026-07-01", "2026-07-04"), spell("b", "2026-08-30", "2026-09-02")],
      [["a", "b"]],
    ],
    [
      "two periods 57 days apart do not",
      [spell("a", "2026-07-01", "2026-07-04"), spell("b", "2026-08-31", "2026-09-03")],
      [["a"], ["b"]],
    ],
    [
      "a short spell between them neither counts nor breaks the link",
      [
        spell("a", "2026-07-01", "2026-07-04"),
        spell("x", "2026-07-20", "2026-07-21"),
        spell("b", "2026-08-30", "2026-09-02"),
      ],
      [["a", "b"]],
    ],
    ["an open spell counts to today", [spell("a", "2026-10-28", null)], [["a"]]],
  ] as const)("%s", (_n, spells, groups) => {
    const out = periodsOfIncapacity(spells, TODAY, rates);
    expect(out?.map((p) => p.spellIds)).toEqual(groups);
  });

  it("does not apply where the nation has no rate", () => {
    expect(periodsOfIncapacity([], TODAY, { piwMinDays: null, piwLinkWeeks: 8 })).toBeNull();
  });

  it("counts qualifying days by the days of the week the member works", () => {
    // Monday 2 to Sunday 8 November 2026; works Monday, Wednesday and Friday.
    const days = absenceDays("2026-11-02", "2026-11-08", TODAY);
    expect(qualifyingDaysIn(days, new Set([1, 3, 5]))).toEqual([
      "2026-11-02",
      "2026-11-04",
      "2026-11-06",
    ]);
  });
});

describe("hazard HZ-123 rule 7: an absence flags the member's shifts for cover, never empties them", () => {
  const shifts = [
    { assignmentId: "1", shiftId: "s1", workerId: ADA, dates: ["2026-11-02"] },
    { assignmentId: "2", shiftId: "s2", workerId: ADA, dates: ["2026-11-06", "2026-11-07"] },
    { assignmentId: "3", shiftId: "s3", workerId: ADA, dates: ["2026-11-09"] },
    { assignmentId: "4", shiftId: "s4", workerId: MO, dates: ["2026-11-03"] },
  ];
  it.each([
    ["a week's leave", "2026-11-02", "2026-11-06", ["1", "2"]],
    ["a night ending on the first day", "2026-11-07", "2026-11-08", ["2"]],
    ["an open sickness", "2026-11-05", null, ["2", "3"]],
    ["nothing rostered", "2026-11-20", "2026-11-21", []],
  ] as const)("%s", (_n, startsOn, endsOn, ids) => {
    const out = assignmentsNeedingCover({ memberId: ADA, startsOn, endsOn }, shifts);
    expect(out.map((a) => a.assignmentId)).toEqual(ids);
  });
});

describe("hazard HZ-124 rule 8: nobody is rostered onto their own absence", () => {
  it.each([
    ["approved leave that day", "approved", "2026-11-02", "2026-11-06", ["2026-11-03"], true],
    ["recorded open sickness", "recorded", "2026-11-01", null, ["2026-11-20"], true],
    ["a request not yet decided", "requested", "2026-11-02", "2026-11-06", ["2026-11-03"], false],
    ["declined", "declined", "2026-11-02", "2026-11-06", ["2026-11-03"], false],
    [
      "a night ending on the first day",
      "approved",
      "2026-11-07",
      "2026-11-08",
      ["2026-11-06", "2026-11-07"],
      true,
    ],
    ["the day after", "approved", "2026-11-02", "2026-11-06", ["2026-11-07"], false],
  ] as const)("%s", (_n, state, startsOn, endsOn, dates, absent) => {
    expect(absentOn([{ state, startsOn, endsOn }], dates)).toBe(absent);
  });
});

describe("rule 5: the Bradford factor's days", () => {
  it("takes away sickness only, never cancelled or excluded", () => {
    const days = bradfordDays(
      [
        {
          kind: "sickness",
          state: "recorded",
          startsOn: "2026-10-05",
          endsOn: "2026-10-06",
          excluded: false,
        },
        {
          kind: "sickness",
          state: "cancelled",
          startsOn: "2026-10-12",
          endsOn: "2026-10-12",
          excluded: false,
        },
        {
          kind: "sickness",
          state: "recorded",
          startsOn: "2026-10-19",
          endsOn: "2026-10-19",
          excluded: true,
        },
        {
          kind: "annual_leave",
          state: "approved",
          startsOn: "2026-10-26",
          endsOn: "2026-10-27",
          excluded: false,
        },
      ],
      TODAY,
    );
    expect(days).toEqual(["2026-10-05", "2026-10-06"]);
  });
});

describe("H-970 statutory leave is never declined; carer's and parental leave only postponed", () => {
  const move = (kind: AbsenceKind, to: AbsenceState, reason: string | null = "Rota is short") =>
    checkAbsenceMove({ from: "requested", to, memberId: ADA, actorId: MO, reason, kind });
  it.each<[AbsenceKind, AbsenceState, string | null]>([
    ["maternity", "declined", "not_declinable"],
    ["paternity", "declined", "not_declinable"],
    ["adoption", "declined", "not_declinable"],
    ["parental_bereavement", "declined", "not_declinable"],
    ["carers_leave", "declined", "not_declinable"],
    ["parental_leave", "declined", "not_declinable"],
    ["annual_leave", "declined", null],
    ["carers_leave", "postponed", null],
    ["parental_leave", "postponed", null],
    ["annual_leave", "postponed", "not_postponable"],
    ["maternity", "postponed", "not_postponable"],
    ["maternity", "approved", null],
    ["parental_bereavement", "approved", null],
  ])("%s to %s", (kind, to, expected) => {
    expect(move(kind, to)).toBe(expected);
  });
  it("a postponement needs a reason and someone other than the member", () => {
    expect(move("carers_leave", "postponed", null)).toBe("reason_required");
    expect(
      checkAbsenceMove({
        from: "requested",
        to: "postponed",
        memberId: ADA,
        actorId: ADA,
        reason: "Moving it",
        kind: "carers_leave",
      }),
    ).toBe("decider_is_member");
  });
  it("parental bereavement is a kind of its own", () => {
    expect(ABSENCE_KINDS).toContain("parental_bereavement");
    expect(STATUTORY_LEAVE_KINDS).toContain("parental_bereavement");
  });
});

describe("H-970 carer's leave taken in any 12 months (advisory)", () => {
  const leave = (startsOn: string, endsOn: string, state: AbsenceState = "approved") => ({
    kind: "carers_leave" as AbsenceKind,
    state,
    startsOn,
    endsOn,
  });
  it.each<[string, ReturnType<typeof leave>[], number, boolean]>([
    ["none", [], 0, false],
    ["three days", [leave("2026-06-01", "2026-06-03")], 3, false],
    ["a full week", [leave("2026-06-01", "2026-06-07")], 7, false],
    [
      "more than a week",
      [leave("2026-06-01", "2026-06-05"), leave("2026-09-01", "2026-09-05")],
      10,
      true,
    ],
    ["older than 12 months is not counted", [leave("2025-10-01", "2025-10-30")], 0, false],
    [
      "the day 12 months ago is not counted, the day after is",
      [leave("2025-10-31", "2025-11-01")],
      1,
      false,
    ],
    [
      "a request not yet decided is not counted",
      [leave("2026-06-01", "2026-06-03", "requested")],
      0,
      false,
    ],
    [
      "a postponed request is not counted",
      [leave("2026-06-01", "2026-06-03", "postponed")],
      0,
      false,
    ],
  ])("%s", (_name, absences, taken, over) => {
    const out = carersLeaveTaken(absences, "2026-10-31", { carersLeaveWeeks: 1 });
    expect(out).toEqual({ takenDays: taken, allowanceDays: 7, overAllowance: over });
  });
  it("has no allowance where the nation has no row", () => {
    expect(carersLeaveTaken([], "2026-10-31", { carersLeaveWeeks: null })).toEqual({
      takenDays: 0,
      allowanceDays: null,
      overAllowance: false,
    });
  });
  it("on 29 February, counts from the day after 1 March a year before", () => {
    const out = carersLeaveTaken([leave("2027-03-01", "2027-03-02")], "2028-02-29", {
      carersLeaveWeeks: 1,
    });
    expect(out.takenDays).toBe(1);
  });
});

/**
 * H-970 postponing carer's leave (Carer's Leave Regulations 2024 reg 8) and unpaid parental leave
 * (Maternity and Parental Leave etc. Regulations 1999 Sch 2 para 6): the employer gives new dates
 * of the same length, no later than the rate table's months after the first day asked for, in
 * writing within the rate table's days of the request (and, for carer's leave, before the leave was
 * due to start). Every limit is read from the rate table; the cases are built from it.
 */
describe("H-970 postponing carer's and parental leave within the statutory limits", () => {
  const table = readRateTable();
  const ratesFor = (kind: PostponableKind) =>
    resolvePostponementRates(table, kind, "england", "2026-10-31", null);
  const carers = ratesFor("carers_leave");
  const parental = ratesFor("parental_leave");

  it("reads every limit from the rate table, for each nation of Great Britain only", () => {
    for (const kind of ["carers_leave", "parental_leave"] as const) {
      for (const nation of ["england", "wales", "scotland"] as const) {
        const r = resolvePostponementRates(table, kind, nation, "2026-10-31", null);
        expect(r.maxMonths).toBeGreaterThan(0);
        expect(r.noticeDays).toBeGreaterThan(0);
      }
      expect(resolvePostponementRates(table, kind, "northern_ireland", "2026-10-31", null)).toEqual(
        { maxMonths: null, noticeDays: null },
      );
    }
    const row = (key: string) =>
      Number(table.find((r) => r.key === key && r.nation === "england")?.value);
    expect(carers).toEqual({
      maxMonths: row(POSTPONEMENT_RATE_KEYS.carers_leave.maxMonths),
      noticeDays: row(POSTPONEMENT_RATE_KEYS.carers_leave.noticeDays),
    });
    expect(parental).toEqual({
      maxMonths: row(POSTPONEMENT_RATE_KEYS.parental_leave.maxMonths),
      noticeDays: row(POSTPONEMENT_RATE_KEYS.parental_leave.noticeDays),
    });
  });

  it("has no carer's leave to postpone before the regulations started", () => {
    expect(resolvePostponementRates(table, "carers_leave", "england", "2024-04-05", null)).toEqual({
      maxMonths: null,
      noticeDays: null,
    });
  });

  // Asked for on 1 October for 2 to 3 November (two days); decided on 3 October.
  const REQUESTED = "2026-10-01";
  const START = "2026-11-02";
  const END = "2026-11-03";
  const DECIDED = "2026-10-03";

  describe("the limits shown to the approver", () => {
    it.each<
      [string, PostponableKind, string, string, { latestStartsOn: string; noticeBy: string }]
    >([
      [
        "carer's leave: a month after the first day; notice within the days after the request",
        "carers_leave",
        REQUESTED,
        START,
        {
          latestStartsOn: addCalendarMonths(START, carers.maxMonths as number),
          noticeBy: plusDays(REQUESTED, carers.noticeDays as number),
        },
      ],
      [
        "carer's leave asked for close to the day: notice by the day before it starts",
        "carers_leave",
        "2026-10-30",
        START,
        {
          latestStartsOn: addCalendarMonths(START, carers.maxMonths as number),
          noticeBy: plusDays(START, -1),
        },
      ],
      [
        "parental leave: six months after the first day; notice within the days after the request",
        "parental_leave",
        REQUESTED,
        START,
        {
          latestStartsOn: addCalendarMonths(START, parental.maxMonths as number),
          noticeBy: plusDays(REQUESTED, parental.noticeDays as number),
        },
      ],
      [
        "a month from 31 January ends on the last day of February",
        "carers_leave",
        "2027-01-02",
        "2027-01-31",
        {
          latestStartsOn: addCalendarMonths("2027-01-31", carers.maxMonths as number),
          noticeBy: plusDays("2027-01-02", carers.noticeDays as number),
        },
      ],
    ])("%s", (_name, kind, requestedOn, startsOn, expected) => {
      expect(postponementLimits({ kind, startsOn, requestedOn }, ratesFor(kind))).toEqual(expected);
    });
    it("gives no limits where the nation has no rows", () => {
      expect(
        postponementLimits(
          { kind: "carers_leave", startsOn: START, requestedOn: REQUESTED },
          { maxMonths: null, noticeDays: null },
        ),
      ).toBeNull();
    });
    it("counts a calendar month to the last day of a short month", () => {
      expect(addCalendarMonths("2027-01-31", 1)).toBe("2027-02-28");
    });
  });

  describe("the rules a postponement must meet", () => {
    const limits = (kind: PostponableKind) =>
      postponementLimits({ kind, startsOn: START, requestedOn: REQUESTED }, ratesFor(kind)) as {
        latestStartsOn: string;
        noticeBy: string;
      };
    const cl = limits("carers_leave");
    const pl = limits("parental_leave");
    type Case = [
      string,
      PostponableKind,
      {
        decidedOn?: string;
        newStartsOn: string | null;
        newEndsOn: string | null;
        confirmsPostponable?: boolean;
      },
      string | null,
    ];
    it.each<Case>([
      [
        "carer's leave a week later",
        "carers_leave",
        { newStartsOn: "2026-11-09", newEndsOn: "2026-11-10" },
        null,
      ],
      [
        "carer's leave on the latest day allowed",
        "carers_leave",
        { newStartsOn: cl.latestStartsOn, newEndsOn: plusDays(cl.latestStartsOn, 1) },
        null,
      ],
      [
        "carer's leave the day after the latest day",
        "carers_leave",
        { newStartsOn: plusDays(cl.latestStartsOn, 1), newEndsOn: plusDays(cl.latestStartsOn, 2) },
        "postpone_too_late",
      ],
      [
        "carer's leave decided on the last day for notice",
        "carers_leave",
        { decidedOn: cl.noticeBy, newStartsOn: "2026-11-09", newEndsOn: "2026-11-10" },
        null,
      ],
      [
        "carer's leave decided the day after the last day for notice",
        "carers_leave",
        { decidedOn: plusDays(cl.noticeBy, 1), newStartsOn: "2026-11-09", newEndsOn: "2026-11-10" },
        "postpone_notice_passed",
      ],
      [
        "carer's leave decided on the day it was due to start",
        "carers_leave",
        { decidedOn: START, newStartsOn: "2026-11-09", newEndsOn: "2026-11-10" },
        "postpone_notice_passed",
      ],
      [
        "parental leave on the latest day allowed",
        "parental_leave",
        {
          newStartsOn: pl.latestStartsOn,
          newEndsOn: plusDays(pl.latestStartsOn, 1),
          confirmsPostponable: true,
        },
        null,
      ],
      [
        "parental leave the day after the latest day",
        "parental_leave",
        {
          newStartsOn: plusDays(pl.latestStartsOn, 1),
          newEndsOn: plusDays(pl.latestStartsOn, 2),
          confirmsPostponable: true,
        },
        "postpone_too_late",
      ],
      [
        "parental leave decided the day after the last day for notice",
        "parental_leave",
        {
          decidedOn: plusDays(pl.noticeBy, 1),
          newStartsOn: "2027-01-04",
          newEndsOn: "2027-01-05",
          confirmsPostponable: true,
        },
        "postpone_notice_passed",
      ],
      [
        "parental leave right after a birth or placement, or past the 18th birthday, is not confirmed",
        "parental_leave",
        { newStartsOn: "2027-01-04", newEndsOn: "2027-01-05", confirmsPostponable: false },
        "postpone_unconfirmed",
      ],
      [
        "new dates are needed",
        "carers_leave",
        { newStartsOn: null, newEndsOn: null },
        "postpone_dates_required",
      ],
      [
        "a last day is needed",
        "carers_leave",
        { newStartsOn: "2026-11-09", newEndsOn: null },
        "postpone_dates_required",
      ],
      [
        "the new last day cannot be before the new first day",
        "carers_leave",
        { newStartsOn: "2026-11-10", newEndsOn: "2026-11-09" },
        "ends_before_start",
      ],
      [
        "the same dates are not a postponement",
        "carers_leave",
        { newStartsOn: START, newEndsOn: END },
        "postpone_not_later",
      ],
      [
        "earlier dates are not a postponement",
        "carers_leave",
        { newStartsOn: "2026-10-26", newEndsOn: "2026-10-27" },
        "postpone_not_later",
      ],
      [
        "a new first day not after the day of the decision",
        "parental_leave",
        {
          decidedOn: "2026-10-08",
          newStartsOn: "2026-10-08",
          newEndsOn: "2026-10-09",
          confirmsPostponable: true,
        },
        "postpone_not_later",
      ],
      [
        "a shorter period is refused: the same length of leave is given",
        "carers_leave",
        { newStartsOn: "2026-11-09", newEndsOn: "2026-11-09" },
        "postpone_duration",
      ],
      [
        "a longer period is refused",
        "parental_leave",
        { newStartsOn: "2027-01-04", newEndsOn: "2027-01-06", confirmsPostponable: true },
        "postpone_duration",
      ],
    ])("%s", (_name, kind, given, expected) => {
      expect(
        checkPostponement(
          {
            kind,
            startsOn: START,
            endsOn: END,
            requestedOn: REQUESTED,
            decidedOn: given.decidedOn ?? DECIDED,
            newStartsOn: given.newStartsOn,
            newEndsOn: given.newEndsOn,
            confirmsPostponable: given.confirmsPostponable ?? false,
          },
          ratesFor(kind),
        ),
      ).toBe(expected);
    });

    it("refuses where the nation has no rows rather than guessing", () => {
      expect(
        checkPostponement(
          {
            kind: "carers_leave",
            startsOn: START,
            endsOn: END,
            requestedOn: REQUESTED,
            decidedOn: DECIDED,
            newStartsOn: "2026-11-09",
            newEndsOn: "2026-11-10",
            confirmsPostponable: false,
          },
          { maxMonths: null, noticeDays: null },
        ),
      ).toBe("postpone_no_rate");
    });

    it("refuses kinds that cannot be postponed", () => {
      expect(
        checkPostponement(
          {
            kind: "annual_leave",
            startsOn: START,
            endsOn: END,
            requestedOn: REQUESTED,
            decidedOn: DECIDED,
            newStartsOn: "2026-11-09",
            newEndsOn: "2026-11-10",
            confirmsPostponable: true,
          },
          carers,
        ),
      ).toBe("not_postponable");
    });
  });
});
