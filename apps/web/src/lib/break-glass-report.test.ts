import { describe, expect, it } from "vitest";
import {
  actionsProblem,
  breakGlassReportShown,
  flagChip,
  flagCount,
  flagSentence,
  flagsText,
  listHref,
  personNamer,
  readSummary,
  reportEntries,
  reportHref,
  reportPersonIds,
  reportWeek,
  reviewChip,
  reviewOffer,
  reviewProblem,
  staffNamer,
  weekParam,
} from "./break-glass-report";
import { t } from "./i18n";

const USER_A = "0194d000-0000-7000-8000-00000000000a";
const USER_B = "0194d000-0000-7000-8000-00000000000b";
const PERSON_1 = "0194d000-0000-7000-8600-000000000001";
const PERSON_2 = "0194d000-0000-7000-8600-000000000002";

/** The item at an index, failing the test when it is missing. */
function nth<T>(list: readonly T[], index: number): T {
  const item = list[index];
  if (item === undefined) throw new Error(`no item ${index}`);
  return item;
}

/** A stored summary as the worker writes it (packages/domain breakGlassWeeklyReport). */
const SUMMARY = {
  week: { start: "2026-10-18T23:00:00.000Z", end: "2026-10-26T00:00:00.000Z" },
  totalEvents: 4,
  distinctUsers: 2,
  distinctPeople: 2,
  unreviewedEventIds: ["e1", "e2", "e3"],
  byUser: [
    {
      tenantUserId: USER_A,
      events: 3,
      people: 1,
      unreviewed: 2,
      flags: ["repeated_use", "same_person_repeatedly"],
      eventIds: ["e1", "e2", "e3"],
    },
    { tenantUserId: USER_B, events: 1, people: 1, unreviewed: 1, flags: [], eventIds: ["e4"] },
  ],
  byPerson: [
    { personId: PERSON_1, events: 3, users: 1, flags: [], eventIds: ["e1", "e2", "e3"] },
    { personId: PERSON_2, events: 1, users: 1, flags: [], eventIds: ["e4"] },
  ],
  byReason: [
    { reason: "covering_another_area", events: 3 },
    { reason: "not_categorised", events: 1 },
  ],
  flagged: [
    { flag: "repeated_use", tenantUserId: USER_A, personId: null, count: 3, eventIds: [] },
    {
      flag: "same_person_repeatedly",
      tenantUserId: USER_A,
      personId: PERSON_1,
      count: 3,
      eventIds: [],
    },
  ],
  searches: {
    total: 2,
    distinctUsers: 1,
    byUser: [{ tenantUserId: USER_B, searches: 2, flags: [], eventIds: ["s1", "s2"] }],
    byReason: [{ reason: "emergency_care", events: 2 }],
  },
};

const report = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "0194d000-0000-7000-8000-0000000000r1",
  locationId: "0194d000-0000-7000-8000-0000000000l1",
  supersedesId: null as string | null,
  reviewedAt: null as string | null,
  reviewedBy: null as string | null,
  actionsTaken: null as string | null,
  ...over,
});

describe("the weekly break-glass report screens", () => {
  it.each([
    [["platform.audit.read"], true],
    [["people.person.break_glass", "platform.user.manage"], false],
    [[], false],
  ] as const)("shows the report to %j: %s", (permissions, shown) => {
    expect(breakGlassReportShown(permissions)).toBe(shown);
  });

  it.each([
    ["2026-10-21", "2026-10-21"],
    ["2026-02-30", null],
    ["21/10/2026", null],
    [undefined, null],
    [["2026-10-21"], null],
  ] as const)("reads the week %j from the address as %j", (value, expected) => {
    expect(weekParam(value as string | string[] | undefined)).toBe(expected);
  });

  it("says the week in UK dates, whatever the clocks did, and offers the next only once it has ended", () => {
    // The week the clocks went back: Monday 19 October 00:00 BST is 18 October 23:00 UTC.
    const list = { weekStart: "2026-10-18T23:00:00.000Z", weekEnd: "2026-10-26T00:00:00.000Z" };
    expect(reportWeek(list, new Date("2026-10-31T12:00:00Z"))).toEqual({
      monday: "2026-10-19",
      sunday: "2026-10-25",
      previous: "2026-10-12",
      next: null,
    });
    expect(reportWeek(list, new Date("2026-11-02T08:00:00Z")).next).toBe("2026-10-26");
  });

  it("builds the list and report addresses", () => {
    expect(listHref(null)).toBe("/break-glass/weekly-report");
    expect(listHref("2026-10-19")).toBe("/break-glass/weekly-report?week=2026-10-19");
    expect(reportHref("abc", "2026-10-19")).toBe("/break-glass/weekly-report/abc?week=2026-10-19");
  });

  it("reads a stored summary", () => {
    const summary = readSummary(SUMMARY);
    expect(summary.unreadable).toBe(false);
    expect(summary).toMatchObject({ totalEvents: 4, distinctUsers: 2, unreviewed: 3 });
    expect(summary.byUser[0]?.flags).toEqual(["repeated_use", "same_person_repeatedly"]);
    expect(summary.searches.byUser[0]).toMatchObject({ tenantUserId: USER_B, searches: 2 });
    expect(flagCount(summary)).toBe(2);
  });

  it("warns rather than reading a damaged summary as nothing to report (HZ-011)", () => {
    const summary = readSummary({ totalEvents: "4", byUser: "x", flagged: [{ flag: "new" }] });
    expect(summary.unreadable).toBe(true);
    expect(summary.flagged[0]?.flag).toBe("unknown");
    expect(
      flagSentence(
        nth(summary.flagged, 0),
        3,
        () => "",
        () => "",
        t,
      ),
    ).toContain("Contact Harbour support");
  });

  it("counts a searcher's repeated use among the things flagged", () => {
    const summary = readSummary({
      ...SUMMARY,
      flagged: [],
      searches: {
        ...SUMMARY.searches,
        byUser: [{ ...SUMMARY.searches.byUser[0], flags: ["repeated_use"] }],
      },
    });
    expect(flagCount(summary)).toBe(1);
  });

  it("pairs each report with its review, and keeps a review whose report is missing", () => {
    const original = report();
    const reviewed = report({
      id: "review",
      supersedesId: original.id,
      reviewedAt: "2026-10-27T09:00:00.000Z",
      reviewedBy: USER_B,
      actionsTaken: "Spoke to the member of staff.",
    });
    const other = report({ id: "other", locationId: "l2" });
    const orphan = report({ id: "orphan", locationId: "l3", supersedesId: "gone" });
    const entries = reportEntries([original, reviewed, other, orphan]);
    expect(entries.map((e) => [e.report.id, e.review?.id ?? null])).toEqual([
      [original.id, "review"],
      ["other", null],
      ["orphan", "orphan"],
    ]);
    expect(reviewChip(nth(entries, 0), t)).toMatchObject({ status: "done", label: "Reviewed" });
    expect(reviewChip(nth(entries, 1), t)).toMatchObject({ status: "due", label: "To review" });
  });

  it("says what is flagged as an icon and words, and nothing when nothing is", () => {
    expect(flagChip(0, t)).toBeNull();
    expect(flagChip(2, t)).toEqual({
      status: "overdue",
      icon: "triangle-alert",
      label: "2 things flagged",
    });
  });

  it("offers the review once, never to someone the report flags", () => {
    const summary = readSummary(SUMMARY);
    const open = { report: report(), review: null };
    expect(reviewOffer(open, summary, USER_B)).toEqual({ kind: "form" });
    expect(reviewOffer(open, summary, USER_A)).toEqual({ kind: "own" });
    expect(reviewOffer({ report: report(), review: report() }, summary, USER_B)).toEqual({
      kind: "reviewed",
    });
  });

  it.each([
    ["", "tooShort"],
    ["  ok  ", "tooShort"],
    ["Spoke to them.", null],
    ["x".repeat(2001), "tooLong"],
  ] as const)("checks the actions taken %#", (text, problem) => {
    expect(actionsProblem(text)).toBe(problem);
  });

  it("says a refused review in the page's words", () => {
    expect(reviewProblem({ code: "version_conflict", message: "x" }, t).message).toContain(
      "already recorded the review",
    );
    expect(reviewProblem({ code: "separation_of_duties", message: "x" }, t).message).toContain(
      "your own use",
    );
    expect(reviewProblem({ code: "unavailable", message: "Try again" }, t).message).toBe(
      "Try again",
    );
  });

  it("names staff from the report and says when it cannot", () => {
    const staff = staffNamer(
      [{ id: USER_A, displayName: "Nell Nurse", jobTitle: "Clinical lead" }, null],
      t,
    );
    expect(staff(USER_A)).toBe("Nell Nurse, Clinical lead");
    expect(staff(USER_B)).toBe("A member of staff Harbour cannot name");
    expect(staff(null)).toBe("A member of staff Harbour cannot name");
  });

  it("names the reader's own people and numbers the others in the report's order", () => {
    const summary = readSummary(SUMMARY);
    const person = personNamer(reportPersonIds(summary), new Map([[PERSON_2, "Ada Example"]]), t);
    expect(person(PERSON_1)).toBe("Person 1 (not shown to you)");
    expect(person(PERSON_2)).toBe("Ada Example");
    expect(person("someone-else")).toBe("A person we support (not shown to you)");
  });

  it("says each flag in words with who and whom", () => {
    const summary = readSummary(SUMMARY);
    const staff = () => "Nell Nurse";
    const person = () => "Ada Example";
    expect(flagSentence(nth(summary.flagged, 0), 3, staff, person, t)).toBe(
      "Nell Nurse opened records outside their access 3 times, at or above the limit of 3 a week.",
    );
    expect(flagSentence(nth(summary.flagged, 1), 3, staff, person, t)).toBe(
      "Nell Nurse opened the record of Ada Example 3 times. Their access may need changing.",
    );
    expect(
      flagSentence(
        { flag: "opened_by_many", tenantUserId: null, personId: PERSON_1, count: 4 },
        3,
        staff,
        person,
        t,
      ),
    ).toBe("The record of Ada Example was opened by 4 different members of staff.");
    expect(flagsText([], t)).toBe("None");
    expect(flagsText(["repeated_use", "opened_by_many"], t)).toBe("Repeated use, Opened by many");
  });

  it("says each reason chosen, including none and one it does not know", () => {
    const summary = readSummary({
      ...SUMMARY,
      byReason: [
        { reason: "other", events: 1 },
        { reason: "not_categorised", events: 1 },
        { reason: "brand_new", events: 1 },
      ],
    });
    expect(summary.byReason.map((l) => t("breakGlassReport.reason", { reason: l.reason }))).toEqual(
      ["Something else", "No reason chosen", "A reason Harbour cannot describe"],
    );
  });
});
