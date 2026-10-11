import { describe, expect, it } from "vitest";
import {
  type FormDefinition,
  isFieldVisible,
  scoreAnswers,
  validateAnswers,
  validateDefinition,
} from "./forms";
import {
  channelsToSend,
  dueEscalationSteps,
  type EscalationStep,
  inQuietHours,
  nextEscalationAt,
  validateChain,
} from "./notifications";

const satisfaction: FormDefinition = {
  fields: [
    {
      key: "visited",
      label: "Did your relative have visitors this week?",
      type: "single_choice",
      required: true,
      options: [
        { value: "yes", label: "Yes", score: 2 },
        { value: "no", label: "No", score: 0 },
      ],
    },
    {
      key: "who",
      label: "Who visited?",
      type: "text",
      required: true,
      showWhen: { field: "visited", equals: ["yes"] },
    },
    { key: "rating", label: "Rating", type: "number", min: 1, max: 5 },
    { key: "on", label: "Date", type: "date" },
    { key: "consent", label: "Happy to share", type: "boolean" },
    {
      key: "topics",
      label: "Topics",
      type: "multi_choice",
      options: [
        { value: "food", label: "Food", score: 1 },
        { value: "activities", label: "Activities", score: 3 },
      ],
    },
    { key: "notes", label: "Notes", type: "long_text" },
  ],
  scoring: {
    bands: [
      { from: 0, to: 2, label: "Low" },
      { from: 3, to: 10, label: "High" },
    ],
  },
};

describe("validateDefinition", () => {
  it("accepts a well-formed definition", () => {
    expect(validateDefinition(satisfaction)).toEqual([]);
  });

  it.each([
    [{ fields: [{ key: "Bad Key", label: "x", type: "text" }] }, /lower case/],
    [
      {
        fields: [
          { key: "a", label: "x", type: "text" },
          { key: "a", label: "y", type: "text" },
        ],
      },
      /Duplicate/,
    ],
    [{ fields: [{ key: "a", label: "x", type: "single_choice" }] }, /at least one option/],
    [
      {
        fields: [
          { key: "a", label: "x", type: "text", showWhen: { field: "later", equals: ["x"] } },
        ],
      },
      /earlier field/,
    ],
    [{ fields: [{ key: "a", label: "x", type: "number", min: 5, max: 1 }] }, /Minimum/],
    [
      {
        fields: [],
        scoring: {
          bands: [
            { from: 0, to: 5, label: "a" },
            { from: 5, to: 9, label: "b" },
          ],
        },
      },
      /overlap/,
    ],
  ] as const)("rejects %o", (definition, message) => {
    const problems = validateDefinition(definition as FormDefinition);
    expect(problems.map((p) => p.message).join(" ")).toMatch(message);
  });
});

describe("validateAnswers", () => {
  it.each([
    [
      "complete and valid",
      {
        visited: "yes",
        who: "Ben",
        rating: 4,
        on: "2026-10-11",
        consent: true,
        topics: ["food"],
        notes: "Fine",
      },
      [],
    ],
    ["conditional field skipped when hidden", { visited: "no" }, []],
    ["required missing", {}, [{ field: "visited", problem: "required" }]],
    [
      "conditional required when shown",
      { visited: "yes" },
      [{ field: "who", problem: "required" }],
    ],
    ["unknown option", { visited: "maybe" }, [{ field: "visited", problem: "unknown_option" }]],
    ["out of range", { visited: "no", rating: 9 }, [{ field: "rating", problem: "out_of_range" }]],
    [
      "wrong number type",
      { visited: "no", rating: "4" },
      [{ field: "rating", problem: "wrong_type" }],
    ],
    ["bad date", { visited: "no", on: "11/10/2026" }, [{ field: "on", problem: "wrong_type" }]],
    [
      "bad boolean",
      { visited: "no", consent: "yes" },
      [{ field: "consent", problem: "wrong_type" }],
    ],
    ["bad multi", { visited: "no", topics: "food" }, [{ field: "topics", problem: "wrong_type" }]],
    [
      "unknown multi option",
      { visited: "no", topics: ["weather"] },
      [{ field: "topics", problem: "unknown_option" }],
    ],
    ["bad choice type", { visited: 1 }, [{ field: "visited", problem: "wrong_type" }]],
    ["bad text type", { visited: "no", notes: 3 }, [{ field: "notes", problem: "wrong_type" }]],
    [
      "unknown field",
      { visited: "no", extra: "x" },
      [{ field: "extra", problem: "unknown_field" }],
    ],
  ] as const)("%s", (_name, answers, expected) => {
    expect(validateAnswers(satisfaction, answers)).toEqual(expected);
  });
});

describe("scoreAnswers", () => {
  it.each([
    [{ visited: "no" }, 0, "Low", []],
    [{ visited: "yes", who: "Ben" }, 2, "Low", [{ field: "visited", points: 2 }]],
    [
      { visited: "yes", who: "Ben", topics: ["food", "activities"] },
      6,
      "High",
      [
        { field: "visited", points: 2 },
        { field: "topics", points: 4 },
      ],
    ],
  ] as const)("%o scores %s (%s)", (answers, total, band, workings) => {
    expect(scoreAnswers(satisfaction, answers)).toEqual({ total, band, workings });
  });

  it("returns no band when the total falls outside every band", () => {
    expect(scoreAnswers({ fields: satisfaction.fields }, { visited: "yes" }).band).toBeNull();
  });

  it("evaluates visibility", () => {
    expect(isFieldVisible(satisfaction.fields[1] as never, { visited: "no" })).toBe(false);
  });
});

describe("escalation chains", () => {
  const steps: EscalationStep[] = [
    { afterMinutes: 10, targetRoleKey: "care_coordinator", channels: ["push"] },
    { afterMinutes: 20, targetRoleKey: "registered_manager", channels: ["push", "sms"] },
  ];
  const createdAt = new Date("2026-10-11T08:00:00Z");

  it("validates chains", () => {
    expect(validateChain(steps)).toEqual([]);
    expect(
      validateChain([
        { afterMinutes: 0, channels: [] },
        { afterMinutes: 0, targetRoleKey: "x", channels: ["push"] },
      ]),
    ).toEqual([
      "Step 1 has no target.",
      "Step 1 has no channel.",
      "Step 1 must wait at least a minute.",
      "Step 2 must come after step 1.",
      "Step 2 must wait at least a minute.",
    ]);
  });

  it.each([
    [0, null, "2026-10-11T08:10:00.000Z"],
    [1, null, "2026-10-11T08:20:00.000Z"],
    [2, null, null],
    [0, new Date("2026-10-11T08:05:00Z"), null],
  ] as const)(
    "after %s steps (acknowledged %s) next is %s",
    (stepsFired, acknowledgedAt, expected) => {
      expect(
        nextEscalationAt(steps, { createdAt, stepsFired, acknowledgedAt })?.toISOString() ?? null,
      ).toBe(expected);
    },
  );

  it.each([
    ["08:09", 0, []],
    ["08:10", 0, [0]],
    ["08:25", 0, [0, 1]],
    ["08:25", 1, [1]],
  ] as const)("at %s with %s fired, due %o", (time, stepsFired, expected) => {
    const now = new Date(`2026-10-11T${time}:00Z`);
    expect(
      dueEscalationSteps(steps, { createdAt, stepsFired, acknowledgedAt: null }, now).map(
        (d) => d.index,
      ),
    ).toEqual(expected);
  });

  it("stops escalating once acknowledged", () => {
    const now = new Date("2026-10-11T09:00:00Z");
    expect(
      dueEscalationSteps(steps, { createdAt, stepsFired: 0, acknowledgedAt: now }, now),
    ).toEqual([]);
  });
});

describe("quiet hours", () => {
  const overnight = { start: "22:00", end: "07:00" };
  it.each([
    [overnight, 23 * 60, true],
    [overnight, 6 * 60 + 59, true],
    [overnight, 7 * 60, false],
    [{ start: "12:00", end: "13:00" }, 12 * 60 + 30, true],
    [{ start: "12:00", end: "13:00" }, 14 * 60, false],
    [{ start: "09:00", end: "09:00" }, 9 * 60, false],
    [null, 0, false],
  ] as const)("%o at minute %s -> %s", (quiet, minute, expected) => {
    expect(inQuietHours(quiet, minute)).toBe(expected);
  });

  it.each([
    ["urgent ignores quiet hours", "urgent", 23 * 60, ["in_app", "push", "sms"]],
    ["warning held to in-app", "warning", 23 * 60, ["in_app"]],
    ["warning outside quiet hours", "warning", 12 * 60, ["in_app", "push", "sms"]],
  ] as const)("%s", (_name, severity, minute, expected) => {
    expect(channelsToSend(["push", "sms"], severity, overnight, minute)).toEqual(expected);
  });
});
