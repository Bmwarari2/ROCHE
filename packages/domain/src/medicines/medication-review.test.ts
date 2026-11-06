import { describe, expect, it } from "vitest";
import { addMonthsToDate } from "../care/assessment";
import {
  checkReviewDone,
  overrideCounts,
  REVIEW_STATUS_WORDS,
  reviewStatus,
  USAGE_REPORT_NOTE,
  usageCounts,
} from "./medication-review";

const figures = { intervalMonths: 12, dueSoonDays: 28 };

describe("hazard HZ-131 medication reviews (slice 45, MEDS-013)", () => {
  it.each([
    ["2026-01-31", 1, "2026-02-28"],
    ["2028-01-31", 1, "2028-02-29"],
    ["2026-03-15", 12, "2027-03-15"],
    ["2026-11-30", 3, "2027-02-28"],
    ["2026-12-01", 1, "2027-01-01"],
  ] as const)(
    "adds months to %s (+%s) as %s, never overflowing a short month",
    (from, months, to) => {
      expect(addMonthsToDate(from, months)).toBe(to);
    },
  );

  it.each<[string, { dueOn: string; doneOn: string | null }[], string, object]>([
    [
      "nothing at all",
      [],
      "2026-11-01",
      { status: "not_scheduled", nextDueOn: null, lastDoneOn: null, nextFrom: null },
    ],
    [
      "a booked review well ahead",
      [{ dueOn: "2027-01-10", doneOn: null }],
      "2026-11-01",
      { status: "scheduled", nextDueOn: "2027-01-10", nextFrom: "scheduled" },
    ],
    [
      "a booked review on the last day of the window",
      [{ dueOn: "2026-11-29", doneOn: null }],
      "2026-11-01",
      { status: "due_soon", nextDueOn: "2026-11-29" },
    ],
    [
      "a booked review the day after the window",
      [{ dueOn: "2026-11-30", doneOn: null }],
      "2026-11-01",
      { status: "scheduled" },
    ],
    ["due today", [{ dueOn: "2026-11-01", doneOn: null }], "2026-11-01", { status: "due_soon" }],
    ["due yesterday", [{ dueOn: "2026-10-31", doneOn: null }], "2026-11-01", { status: "overdue" }],
    [
      "the last one done, nothing booked: the interval after it, overdue",
      [{ dueOn: "2025-10-01", doneOn: "2025-10-20" }],
      "2026-11-01",
      {
        status: "overdue",
        lastDoneOn: "2025-10-20",
        nextDueOn: "2026-10-20",
        nextFrom: "interval",
      },
    ],
    [
      "the interval ahead with nothing booked: due, not yet booked",
      [{ dueOn: "2026-06-01", doneOn: "2026-06-01" }],
      "2026-11-01",
      { status: "not_booked", nextDueOn: "2027-06-01", nextFrom: "interval", bookedOn: null },
    ],
    [
      "a review booked after the interval has run out: overdue by the interval",
      [
        { dueOn: "2025-10-01", doneOn: "2025-10-20" },
        { dueOn: "2027-03-01", doneOn: null },
      ],
      "2026-11-01",
      {
        status: "overdue",
        nextDueOn: "2026-10-20",
        nextFrom: "interval",
        bookedOn: "2027-03-01",
        bookedAfterInterval: true,
      },
    ],
    [
      "a review booked before the interval runs out",
      [
        { dueOn: "2026-06-01", doneOn: "2026-06-01" },
        { dueOn: "2026-12-15", doneOn: null },
      ],
      "2026-11-01",
      {
        status: "scheduled",
        nextDueOn: "2026-12-15",
        nextFrom: "scheduled",
        bookedAfterInterval: false,
      },
    ],
    [
      "the earliest of two booked",
      [
        { dueOn: "2027-02-01", doneOn: null },
        { dueOn: "2026-11-10", doneOn: null },
      ],
      "2026-11-01",
      { nextDueOn: "2026-11-10", status: "due_soon" },
    ],
  ])("shows %s", (_, reviews, today, expected) => {
    expect(reviewStatus(reviews, figures, today)).toMatchObject(expected);
  });

  it("words every status, never by colour alone", () => {
    for (const words of Object.values(REVIEW_STATUS_WORDS))
      expect(words).toMatch(/^Review|^No review/);
  });

  const done = {
    doneOn: "2026-11-01",
    clinicianName: "Dr Ada Example",
    clinicianRole: "gp",
    outcome: "No changes.",
  };
  it("accepts a review done by a named clinician with an outcome", () => {
    expect(checkReviewDone(done, "2026-11-01")).toEqual([]);
  });
  it.each<[string, Partial<typeof done>, string[]]>([
    ["a date to come", { doneOn: "2026-11-02" }, ["done_in_future"]],
    ["no date", { doneOn: "01/11/2026" }, ["done_not_a_date"]],
    ["no clinician", { clinicianName: " " }, ["clinician_required"]],
    ["an unknown role", { clinicianRole: "nurse" }, ["role_unknown"]],
    ["no outcome", { outcome: "" }, ["outcome_required"]],
    ["a long outcome", { outcome: "x".repeat(4001) }, ["text_too_long"]],
  ])("refuses %s", (_, change, problems) => {
    expect(checkReviewDone({ ...done, ...change }, "2026-11-01")).toEqual(problems);
  });
});

describe("hazard HZ-131 PRN and psychotropic use, information only (slice 45)", () => {
  const dose = (
    personId: string,
    medicineId: string,
    name: string,
    prn: boolean,
    psy: boolean,
    taken = true,
  ) => ({
    personId,
    medicineId,
    name,
    prn,
    psychotropic: psy,
    taken,
  });

  it("counts doses taken per person, by kind, leaving out other entries and doses not taken", () => {
    const rows = usageCounts([
      dose("p1", "m-prn", "Paracetamol", true, false),
      dose("p1", "m-prn", "Paracetamol", true, false),
      dose("p1", "m-both", "Lorazepam", true, true),
      dose("p1", "m-psy", "Risperidone", false, true, false),
      dose("p1", "m-reg", "Amlodipine", false, false),
      dose("p2", "m-psy", "Risperidone", false, true),
      dose("p3", "m-reg", "Amlodipine", false, false),
    ]);
    expect(rows).toEqual([
      {
        personId: "p1",
        prnGiven: 3,
        psychotropicGiven: 1,
        psychotropicPrnGiven: 1,
        byMedicine: [
          { medicineId: "m-both", name: "Lorazepam", prnGiven: 1, psychotropicGiven: 1 },
          { medicineId: "m-prn", name: "Paracetamol", prnGiven: 2, psychotropicGiven: 0 },
        ],
      },
      {
        personId: "p2",
        prnGiven: 0,
        psychotropicGiven: 1,
        psychotropicPrnGiven: 0,
        byMedicine: [
          { medicineId: "m-psy", name: "Risperidone", prnGiven: 0, psychotropicGiven: 1 },
        ],
      },
    ]);
  });

  it("classes each dose by the version it was given under when an entry changes in the period", () => {
    const rows = usageCounts([
      dose("p1", "m", "Haloperidol", false, true),
      dose("p1", "m", "Haloperidol", true, true),
      dose("p1", "m", "Haloperidol", true, false),
    ]);
    expect(rows[0]).toMatchObject({ prnGiven: 2, psychotropicGiven: 2, psychotropicPrnGiven: 1 });
  });

  it("says it is a count for a clinician, never a judgement", () => {
    expect(USAGE_REPORT_NOTE).toMatch(/does not judge/);
  });
});

describe("hazard HZ-119 competence overrides count against the right member (slice 45)", () => {
  it("counts an override and lapsed competence against the giver, late recording against the recorder", () => {
    expect(
      overrideCounts([
        { administeredBy: "giver", recordedBy: "recorder", flags: ["competence_override"] },
        {
          administeredBy: "giver",
          recordedBy: "recorder",
          flags: ["competence_not_current", "given_before_recorded"],
        },
        { administeredBy: "recorder", recordedBy: "recorder", flags: ["early"] },
      ]),
    ).toEqual([
      { memberId: "giver", competenceOverride: 1, competenceNotCurrent: 1, givenBeforeRecorded: 0 },
      {
        memberId: "recorder",
        competenceOverride: 0,
        competenceNotCurrent: 0,
        givenBeforeRecorded: 1,
      },
    ]);
  });
});
