import type { ObservationItem } from "@harbour/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ObservationList } from "./ObservationList";

/** The words a reader hears, without markup. */
const words = (html: string) => {
  let text = "";
  let inTag = false;
  for (const char of html) {
    if (char === "<") inTag = true;
    else if (char === ">") {
      inTag = false;
      text += " ";
    } else if (!inTag) text += char;
  }
  return text.split(" ").filter(Boolean).join(" ");
};

const turn = (overrides: Partial<ObservationItem>): ObservationItem => ({
  id: "0193a000-0000-7000-8000-00000000a001",
  personId: "0193a000-0000-7000-8000-00000000a002",
  locationId: "0193a000-0000-7000-8000-00000000a003",
  occurredAt: "2026-10-11T09:05:00.000Z",
  recordedAt: "2026-10-11T09:15:00.000Z",
  deviceTime: "2026-10-11T09:05:00.000Z",
  lateEntry: false,
  clockDrift: false,
  recordedAfterExit: false,
  taskId: null,
  taskOutcome: null,
  supersedesId: null,
  correctionReason: null,
  superseded: false,
  recordedBy: "0193a000-0000-7000-8000-00000000a004",
  recordedByStaff: null,
  handedOverBy: null,
  handedOverByStaff: null,
  deviceDeletion: null,
  chart: "repositioning",
  values: { position: "left_side", skinChecked: true },
  flags: {},
  escalationPolicy: null,
  ...overrides,
});

const render = (items: ObservationItem[]) =>
  renderToStaticMarkup(
    createElement(ObservationList, {
      items,
      label: "Chart entries",
      tenantUserId: "0193a000-0000-7000-8000-00000000a005",
    }),
  );

describe("ObservationList shows what an exit did to an entry (C-M3)", () => {
  it("hazard HZ-006 flags a turn recorded offline before the person left, for a round the move cancelled", () => {
    const text = words(
      render([
        turn({
          recordedAfterExit: true,
          taskId: "0193a000-0000-7000-8000-00000000a006",
          taskOutcome: "task_cancelled",
        }),
      ]),
    );
    expect(text).toContain("Recorded after the person left");
    expect(text).toContain("Its round had been cancelled");
  });

  it("hazard HZ-004 flags a second entry for a round already recorded, for review", () => {
    const html = render([
      turn({ taskId: "0193a000-0000-7000-8000-00000000a006", taskOutcome: "task_already_closed" }),
    ]);
    expect(words(html)).toContain("Round already recorded: for review");
    expect(html).toContain('aria-hidden="true"');
  });

  it("adds nothing to an entry that completed its round", () => {
    const text = words(
      render([turn({ taskId: "0193a000-0000-7000-8000-00000000a006", taskOutcome: "completed" })]),
    );
    expect(text).not.toContain("for review");
    expect(text).not.toContain("Recorded after the person left");
  });
});

describe("ObservationList shows a food or drink entry the API kept from a device (C3)", () => {
  it("hazard HZ-016 says a drink was kept without its level though one is prescribed", () => {
    const html = render([
      turn({
        chart: "fluid_intake",
        values: { ml: 150 },
        flags: {
          iddsi: { outcome: "level_not_recorded", raisesAlert: true },
          iddsiAlert: true,
          iddsiProblem: "level_not_recorded",
        },
      }),
    ]);
    expect(words(html)).toContain(
      "No IDDSI level was recorded, though one is prescribed. The nurse in charge was told.",
    );
    expect(html).toContain('data-iddsi-problem="level_not_recorded"');
    expect(html).toContain('aria-hidden="true"');
  });

  it("hazard HZ-016 says a different level was kept with no reason, instead of an empty reason", () => {
    const text = words(
      render([
        turn({
          chart: "food",
          values: { meal: "lunch", portion: "half", iddsiLevel: "6" },
          flags: {
            iddsi: { outcome: "unsafe_mismatch", raisesAlert: true },
            iddsiAlert: true,
            iddsiProblem: "reason_missing",
          },
        }),
      ]),
    );
    expect(text).toContain("Not the prescribed level, and no reason was recorded.");
    expect(text).not.toContain("Reason given");
  });

  it("shows the reason given for a different level when nothing was kept with a problem", () => {
    const html = render([
      turn({
        chart: "food",
        values: { meal: "lunch", portion: "half", iddsiLevel: "6", overrideReason: "Asked for it" },
        flags: { iddsi: { outcome: "mismatch", raisesAlert: false } },
      }),
    ]);
    expect(words(html)).toContain("Asked for it");
    expect(html).not.toContain("data-iddsi-problem");
  });
});
