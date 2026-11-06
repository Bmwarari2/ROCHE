import { describe, expect, it } from "vitest";
import {
  dependencyShown,
  EMPTY_DRAFT,
  keyFromLabel,
  mayManageScales,
  readDefinition,
  toDraft,
  versionChip,
} from "./dependency";
import { t } from "./i18n";

/** The dependency scale screens (CARE-004, SCHED-001; HZ-123): the organisation's own tool. */

describe("who sees the scales", () => {
  it.each([
    [["scheduling.dependency.manage"], true, true],
    [["care.dependency.assess"], true, false],
    [["scheduling.rota.read"], true, false],
    [["care.note.read"], false, false],
  ])("%j", (permissions, shown, manage) => {
    expect(dependencyShown(permissions)).toBe(shown);
    expect(mayManageScales(permissions)).toBe(manage);
  });
});

describe("keys from labels stay stable and unique", () => {
  it.each([
    ["Low", [], "low"],
    ["High needs (1:1)", [], "high_needs_1_1"],
    ["Café", [], "cafe"],
    ["Low", ["low"], "low_2"],
    ["", [], "item"],
  ])("%j", (label, taken, key) => expect(keyFromLabel(label, new Set(taken))).toBe(key));
});

describe("the editor reads into the API's definition, and back", () => {
  const draft = {
    periods: [
      { key: "day", label: "Day", start: "08:00" },
      { key: "night", label: "Night", start: "20:00" },
    ],
    categories: [
      { key: "low", label: "Low", description: "", minutes: { day: "60", night: "" } },
      {
        key: "high",
        label: "High",
        description: "Two carers",
        minutes: { day: "240", night: "120" },
      },
    ],
    skillMix: [{ skill: "registered_nurse", periodKey: "night", minimumStaff: "1" }],
    reviewIntervalDays: "90",
  };

  it("reads every row", () => {
    const read = readDefinition(draft, t);
    expect(read).toEqual({
      ok: true,
      definition: {
        periods: [
          { key: "day", label: "Day", startMinute: 480 },
          { key: "night", label: "Night", startMinute: 1200 },
        ],
        categories: [
          {
            key: "low",
            label: "Low",
            description: null,
            careMinutes: [{ periodKey: "day", minutes: 60 }],
          },
          {
            key: "high",
            label: "High",
            description: "Two carers",
            careMinutes: [
              { periodKey: "day", minutes: 240 },
              { periodKey: "night", minutes: 120 },
            ],
          },
        ],
        skillMix: [{ skill: "registered_nurse", periodKey: "night", minimumStaff: 1 }],
        reviewIntervalDays: 90,
      },
    });
    if (read.ok)
      expect(toDraft(read.definition).categories[1]?.minutes).toEqual({ day: "240", night: "120" });
  });

  it("says each problem in words", () => {
    const read = readDefinition(
      {
        ...draft,
        periods: [{ key: "day", label: "", start: "8am" }],
        categories: [{ key: "low", label: "Low", description: "", minutes: { day: "lots" } }],
        skillMix: [{ skill: "registered_nurse", periodKey: "night", minimumStaff: "1" }],
        reviewIntervalDays: "never",
      },
      t,
    );
    expect(read.ok).toBe(false);
    // Each problem names its field, so it is shown there.
    if (!read.ok) {
      expect(read.problems.map((p) => p.field)).toEqual([
        "period-0-label",
        "period-0-start",
        "category-0-minutes-day",
        "skill-0-minimum",
        "review",
      ]);
    }
  });

  it("starts with a day and a night period", () => {
    expect(EMPTY_DRAFT.periods.map((p) => p.key)).toEqual(["day", "night"]);
  });
});

describe("version states as an icon and a word", () => {
  it.each([
    ["approved", "In use"],
    ["draft", "Draft"],
    ["superseded", "Replaced"],
    ["discarded", "Discarded"],
    ["odd", "Unknown: check with Harbour support"],
  ])("%s", (state, label) => expect(versionChip(state, t).label).toBe(label));
});
