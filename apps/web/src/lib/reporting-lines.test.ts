import { describe, expect, it } from "vitest";
import { t } from "@/lib/i18n";
import {
  lineManagerHref,
  maintainsReportingLines,
  periodChip,
  sortMembers,
  sortTeams,
  staffOptions,
  teamChip,
  teamHref,
  teamsShown,
} from "./reporting-lines";

const MANAGE = "workforce.staff_file.manage";

describe("who maintains reporting lines (ADR-0137)", () => {
  it.each([
    [[MANAGE], "tenant", true],
    [[MANAGE], "locations", false],
    [[MANAGE], "assigned", false],
    [["workforce.staff_file.read"], "tenant", false],
    [[], "tenant", false],
  ])("permissions %j at scope %s: %s", (permissions, scope, maintains) => {
    expect(maintainsReportingLines({ permissions, scope })).toBe(maintains);
  });

  it.each([
    [[MANAGE], true],
    [["workforce.staff_file.read"], true],
    [["workforce.training.manage"], true],
    [["workforce.competence.observe"], true],
    [["workforce.supervision.manage"], true],
    [["workforce.self.read"], false],
    [["care.note.write"], false],
  ])("permissions %j see the teams: %s", (permissions, shown) => {
    expect(teamsShown(permissions)).toBe(shown);
  });

  it("links to each screen", () => {
    expect(lineManagerHref("f1")).toBe("/workforce/staff/f1/line-manager");
    expect(teamHref("t1")).toBe("/workforce/teams/t1");
  });
});

describe("states in words and icons, never colour alone", () => {
  it.each([
    [null, "Current", "circle-check"],
    ["2026-11-01", "Ended", "circle-minus"],
  ] as const)("a line ending %s is %s", (validTo, label, icon) => {
    expect(periodChip(validTo, t)).toMatchObject({ label, icon });
  });

  it.each([
    [false, "In use", "circle-check"],
    [true, "Archived", "circle-minus"],
  ] as const)("an archived flag of %s reads %s", (archived, label, icon) => {
    expect(teamChip(archived, t)).toMatchObject({ label, icon });
  });
});

describe("choices and order", () => {
  const staff = [
    { id: "b", displayName: "Bea Example", jobTitle: "Nurse" },
    { id: "a", displayName: "Ada Example", jobTitle: null },
    { id: "c", displayName: "Cal Example", jobTitle: "Carer" },
  ];

  it("offers current staff by name, never those excluded", () => {
    expect(staffOptions(staff, ["c"])).toEqual([
      { value: "a", label: "Ada Example" },
      { value: "b", label: "Bea Example, Nurse" },
    ]);
  });

  it("lists teams in use first, archived last", () => {
    expect(
      sortTeams([
        { name: "Night", archived: true },
        { name: "Day", archived: false },
        { name: "Ash", archived: false },
      ]).map((x) => x.name),
    ).toEqual(["Ash", "Day", "Night"]);
  });

  it("lists the lead first, then current members, then ended ones newest first", () => {
    const m = (name: string, isLead: boolean, validTo: string | null) => ({
      name,
      isLead,
      validFrom: "2026-01-01",
      validTo,
    });
    expect(
      sortMembers([
        m("Old", false, "2026-03-01"),
        m("Bea", false, null),
        m("Older", false, "2026-02-01"),
        m("Lead", true, null),
        m("Ada", false, null),
      ]).map((x) => x.name),
    ).toEqual(["Lead", "Ada", "Bea", "Old", "Older"]);
  });
});
