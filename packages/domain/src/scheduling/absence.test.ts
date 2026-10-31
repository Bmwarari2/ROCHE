import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
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
  fitNoteNeeded,
  periodsOfIncapacity,
  qualifyingDaysIn,
  resolveAbsenceRates,
  STATUTORY_LEAVE_KINDS,
} from "./absence";

/** Absence and leave (scheduling.md section 15; SCHED-010; HZ-123, HZ-124). Invented people. */

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
