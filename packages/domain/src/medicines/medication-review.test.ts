import { describe, expect, it } from "vitest";
import { addMonthsToDate } from "../care/assessment";
import {
  checkReviewDone,
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
      "a scheduled review well ahead",
      [{ dueOn: "2027-01-10", doneOn: null }],
      "2026-11-01",
      { status: "scheduled", nextDueOn: "2027-01-10", nextFrom: "scheduled" },
    ],
    [
      "a scheduled review on the last day of the window",
      [{ dueOn: "2026-11-29", doneOn: null }],
      "2026-11-01",
      { status: "due_soon", nextDueOn: "2026-11-29" },
    ],
    [
      "a scheduled review the day after the window",
      [{ dueOn: "2026-11-30", doneOn: null }],
      "2026-11-01",
      { status: "scheduled" },
    ],
    ["due today", [{ dueOn: "2026-11-01", doneOn: null }], "2026-11-01", { status: "due_soon" }],
    ["due yesterday", [{ dueOn: "2026-10-31", doneOn: null }], "2026-11-01", { status: "overdue" }],
    [
      "the last one done, nothing scheduled: the interval after it",
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
      "a scheduled review wins over the interval",
      [
        { dueOn: "2025-10-01", doneOn: "2025-10-20" },
        { dueOn: "2026-12-15", doneOn: null },
      ],
      "2026-11-01",
      {
        status: "scheduled",
        nextDueOn: "2026-12-15",
        nextFrom: "scheduled",
        lastDoneOn: "2025-10-20",
      },
    ],
    [
      "the earliest of two scheduled",
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
  const meds = new Map([
    ["m-prn", { name: "Paracetamol", prn: true, psychotropic: false }],
    ["m-psy", { name: "Risperidone", prn: false, psychotropic: true }],
    ["m-both", { name: "Lorazepam", prn: true, psychotropic: true }],
    ["m-reg", { name: "Amlodipine", prn: false, psychotropic: false }],
  ]);

  it("counts doses taken per person, by kind, leaving out other entries and doses not taken", () => {
    const rows = usageCounts(
      [
        { personId: "p1", medicineId: "m-prn", taken: true },
        { personId: "p1", medicineId: "m-prn", taken: true },
        { personId: "p1", medicineId: "m-both", taken: true },
        { personId: "p1", medicineId: "m-psy", taken: false },
        { personId: "p1", medicineId: "m-reg", taken: true },
        { personId: "p2", medicineId: "m-psy", taken: true },
        { personId: "p3", medicineId: "m-reg", taken: true },
      ],
      meds,
    );
    expect(rows).toEqual([
      {
        personId: "p1",
        prnGiven: 3,
        psychotropicGiven: 1,
        psychotropicPrnGiven: 1,
        byMedicine: [
          { medicineId: "m-both", name: "Lorazepam", prn: true, psychotropic: true, given: 1 },
          { medicineId: "m-prn", name: "Paracetamol", prn: true, psychotropic: false, given: 2 },
        ],
      },
      {
        personId: "p2",
        prnGiven: 0,
        psychotropicGiven: 1,
        psychotropicPrnGiven: 0,
        byMedicine: [
          { medicineId: "m-psy", name: "Risperidone", prn: false, psychotropic: true, given: 1 },
        ],
      },
    ]);
  });

  it("says it is a count for a clinician, never a judgement", () => {
    expect(USAGE_REPORT_NOTE).toMatch(/does not judge/);
  });
});
