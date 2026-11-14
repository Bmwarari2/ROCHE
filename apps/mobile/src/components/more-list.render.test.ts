import { createElement } from "react";
import { describe, expect, it } from "vitest";
import {
  HANDOVER_PERMISSION,
  LONE_WORKER_CHECK_IN,
  TIMESHEET_SELF,
  TRAINING_SELF,
} from "../app-state/care-destinations";
import { render } from "../test-support/render";
import { type MoreDestination, MoreList, moreRows } from "./MoreList";

describe("More (ADR-0138)", () => {
  it("lists only what the member has, each with a line saying what it holds", () => {
    expect(moreRows([]).map((r) => [r.title, r.subtitle])).toEqual([
      ["Settings", "Account, sync, security and display"],
    ]);
    const all = [HANDOVER_PERMISSION, TIMESHEET_SELF, LONE_WORKER_CHECK_IN, TRAINING_SELF];
    expect(moreRows(all).map((r) => [r.title, r.subtitle])).toEqual([
      ["Handover", "Read and acknowledge the handover"],
      ["Shifts", "Clock in and out, and lone working"],
      ["Training", "Your courses, also without a signal"],
      ["Settings", "Account, sync, security and display"],
    ]);
  });

  it("says what Shifts holds for each kind of member", () => {
    const shifts = (permissions: string[]) =>
      moreRows(permissions).find((r) => r.key === "shifts")?.subtitle;
    expect(shifts([TIMESHEET_SELF])).toBe("Clock in and out");
    expect(shifts([LONE_WORKER_CHECK_IN])).toBe("Lone working");
  });

  it("reads each row as one button with its title and line, and opens it", async () => {
    const opened: MoreDestination[] = [];
    const view = await render(
      createElement(MoreList, {
        permissions: [HANDOVER_PERMISSION, LONE_WORKER_CHECK_IN],
        onOpen: (d: MoreDestination) => opened.push(d),
      }),
    );
    expect(view.find("more-handover")?.props.accessibilityLabel).toBe(
      "Handover, Read and acknowledge the handover",
    );
    expect(view.find("more-handover")?.props.accessibilityRole).toBe("button");
    await view.press("more-shifts");
    await view.press("more-settings");
    expect(opened).toEqual(["shifts", "settings"]);
  });
});
