import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  MAX_PARTICIPANT_LENGTH,
  MAX_PARTICIPANTS,
  orderReviews,
  participantsFromLines,
  reviewChip,
  trackerRows,
} from "./reviews";

const t = createTranslator("en-GB");

describe("reviewChip", () => {
  it.each([
    ["overdue", "overdue", "overdue", "Overdue"],
    ["due", "due", "due", "Due"],
    ["upcoming", "neutral", "upcoming", "Upcoming"],
    ["paused", "notApplicable", "paused", "Paused while in hospital"],
  ] as const)("hazard HZ-008 shows %s as an icon and a word", (state, status, icon, label) => {
    expect(reviewChip(state, t)).toEqual({ status, icon, label });
  });
});

describe("orderReviews", () => {
  it("puts overdue first, then due, upcoming and paused, soonest first within each", () => {
    const ordered = orderReviews([
      { state: "upcoming", dueOn: "2026-11-01" },
      { state: "paused", dueOn: "2026-10-01" },
      { state: "overdue", dueOn: "2026-10-20" },
      { state: "due", dueOn: "2026-11-05" },
      { state: "overdue", dueOn: "2026-10-02" },
    ] as const);
    expect(ordered.map((r) => `${r.state} ${r.dueOn}`)).toEqual([
      "overdue 2026-10-02",
      "overdue 2026-10-20",
      "due 2026-11-05",
      "upcoming 2026-11-01",
      "paused 2026-10-01",
    ]);
  });
});

describe("participantsFromLines", () => {
  it("takes one role per line and drops blank lines", () => {
    expect(participantsFromLines(" Key worker \n\nSocial worker\r\n")).toEqual([
      { role: "Key worker" },
      { role: "Social worker" },
    ]);
    expect(participantsFromLines("")).toEqual([]);
  });

  it("refuses rather than cuts off too many lines or a line too long", () => {
    expect(
      participantsFromLines(
        Array(MAX_PARTICIPANTS + 1)
          .fill("Nurse")
          .join("\n"),
      ),
    ).toEqual({
      problem: "too_many",
    });
    expect(participantsFromLines("x".repeat(MAX_PARTICIPANT_LENGTH + 1))).toEqual({
      problem: "too_long",
    });
  });
});

describe("trackerRows", () => {
  const item = (personId: string, state: "due" | "overdue", dueOn: string) => ({
    personId,
    kind: "care_plan_review" as const,
    dueOn,
    windowOpensOn: null,
    dueAt: null,
    state,
    changeIds: [],
    basis: [],
    locationId: "loc",
  });

  it("names each person from the viewer's list, leaving out anyone the list does not name", () => {
    const rows = trackerRows(
      [item("a", "due", "2026-11-01"), item("b", "overdue", "2026-11-03"), item("c", "due", "x")],
      new Map([
        ["a", "Ada Example"],
        ["b", "Ben Sample"],
      ]),
      new Map([["loc", "Harbour House"]]),
    );
    expect(rows.map((r) => [r.name, r.state, r.locationName])).toEqual([
      ["Ben Sample", "overdue", "Harbour House"],
      ["Ada Example", "due", "Harbour House"],
    ]);
  });
});
