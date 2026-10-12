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
  handedOverBy: null,
  chart: "repositioning",
  values: { position: "left_side", skinChecked: true },
  flags: {},
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
