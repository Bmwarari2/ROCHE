import { describe, expect, it } from "vitest";
import {
  checkIddsiEntry,
  compareIddsiLevels,
  describeIddsiLevel,
  IDDSI_DRINK_LEVELS,
  IDDSI_FOOD_LEVELS,
  iddsiLevel,
} from "./iddsi";

/** IDDSI levels and the prescribed-level check (hazard HZ-016). */

describe("hazard HZ-016 IDDSI levels show number, name and colour", () => {
  it.each([
    ["food", "3", "Level 3 Liquidised (yellow)"],
    ["food", "4", "Level 4 Pureed (green)"],
    ["food", "5", "Level 5 Minced and moist (orange)"],
    ["food", "6", "Level 6 Soft and bite-sized (blue)"],
    ["food", "7EC", "Level 7EC Easy to chew (black)"],
    ["food", "7", "Level 7 Regular (black)"],
    ["drink", "0", "Level 0 Thin (white)"],
    ["drink", "1", "Level 1 Slightly thick (grey)"],
    ["drink", "2", "Level 2 Mildly thick (pink)"],
    ["drink", "3", "Level 3 Moderately thick (yellow)"],
    ["drink", "4", "Level 4 Extremely thick (green)"],
  ] as const)("%s level %s is %s", (kind, code, text) => {
    expect(describeIddsiLevel(kind, code)).toBe(text);
  });

  it("has food levels 3 to 7 with 7EC and drink levels 0 to 4", () => {
    expect(Object.keys(IDDSI_FOOD_LEVELS).sort()).toEqual(["3", "4", "5", "6", "7", "7EC"]);
    expect(Object.keys(IDDSI_DRINK_LEVELS).sort()).toEqual(["0", "1", "2", "3", "4"]);
  });

  it.each([
    ["food", "2"],
    ["food", "8"],
    ["drink", "5"],
    ["drink", "toString"],
  ] as const)("does not recognise %s level %s", (kind, code) => {
    expect(iddsiLevel(kind, code)).toBeNull();
    expect(() => describeIddsiLevel(kind, code)).toThrow(RangeError);
  });
});

describe("hazard HZ-016 recorded IDDSI levels are checked against the prescribed level", () => {
  it.each([
    ["food at the prescribed level", "food", "4", "4", "match"],
    ["food more solid than prescribed", "food", "4", "5", "unsafe_mismatch"],
    ["regular food when easy to chew is prescribed", "food", "7EC", "7", "unsafe_mismatch"],
    ["easy to chew when soft and bite-sized is prescribed", "food", "6", "7EC", "unsafe_mismatch"],
    ["food softer than prescribed", "food", "5", "4", "mismatch"],
    ["easy to chew when regular is prescribed", "food", "7", "7EC", "mismatch"],
    ["a drink at the prescribed level", "drink", "2", "2", "match"],
    ["a drink thinner than prescribed", "drink", "2", "1", "unsafe_mismatch"],
    ["thin drinks when moderately thick is prescribed", "drink", "3", "0", "unsafe_mismatch"],
    ["a drink thicker than prescribed", "drink", "2", "3", "mismatch"],
    ["no level prescribed", "food", null, "7", "no_prescribed_level"],
  ] as const)("%s: %s", (_name, kind, prescribed, recorded, outcome) => {
    expect(compareIddsiLevels(kind, prescribed, recorded).outcome).toBe(outcome);
  });

  it("refuses to compare a level that is not an IDDSI level", () => {
    expect(() => compareIddsiLevels("drink", "2", "9")).toThrow(RangeError);
    expect(() => compareIddsiLevels("drink", "9", "2")).toThrow(RangeError);
  });
});

describe("hazard HZ-016 a food entry at a different IDDSI level needs an override reason", () => {
  it.each([
    ["no reason", undefined],
    ["a blank reason", "   "],
    ["a null reason", null],
  ])("refuses an unsafe food entry with %s", (_name, reason) => {
    const check = checkIddsiEntry({ kind: "food", prescribed: "4", recorded: "6", reason });
    expect(check).toMatchObject({
      ok: false,
      comparison: { outcome: "unsafe_mismatch" },
      message:
        "This is not the prescribed food level (Level 4 Pureed (green)) and may not be safe. Give an override reason.",
    });
  });

  it("saves an unsafe entry with an override reason and alerts the nurse in charge", () => {
    expect(
      checkIddsiEntry({ kind: "food", prescribed: "4", recorded: "6", reason: "SLT advice today" }),
    ).toEqual({
      ok: true,
      comparison: { outcome: "unsafe_mismatch", needsReason: true, raisesAlert: true },
      alertNurseInCharge: true,
    });
  });

  it("asks for a reason, without an alert, when the level is safer than prescribed", () => {
    expect(checkIddsiEntry({ kind: "drink", prescribed: "1", recorded: "2" })).toMatchObject({
      ok: false,
      message:
        "This is not the prescribed drink level (Level 1 Slightly thick (grey)). Give a reason.",
    });
    expect(
      checkIddsiEntry({
        kind: "drink",
        prescribed: "1",
        recorded: "2",
        reason: "Only thickened left",
      }),
    ).toMatchObject({ ok: true, alertNurseInCharge: false });
  });

  it.each([
    ["the prescribed level", "food", "5", "5"],
    ["no prescribed level", "drink", null, "0"],
  ] as const)("saves an entry at %s without a reason", (_name, kind, prescribed, recorded) => {
    expect(checkIddsiEntry({ kind, prescribed, recorded })).toMatchObject({
      ok: true,
      alertNurseInCharge: false,
    });
  });

  it("refuses an entry whose recorded or prescribed level is not an IDDSI level", () => {
    expect(checkIddsiEntry({ kind: "food", prescribed: "4", recorded: "1" })).toMatchObject({
      ok: false,
      comparison: null,
      message: "Choose an IDDSI food level from the list.",
    });
    expect(checkIddsiEntry({ kind: "drink", prescribed: "6", recorded: "1" })).toMatchObject({
      ok: false,
      comparison: null,
    });
  });
});
