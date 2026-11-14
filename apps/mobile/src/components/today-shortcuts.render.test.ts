import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { WriteOutcome } from "../scheduling/hooks";
import {
  type LoneWorkerEventKind,
  type LoneWorkerView,
  loneWorkerView,
  type Mine,
} from "../scheduling/lone-worker-view";
import { type RenderedNode, render } from "../test-support/render";
import { HandoverShortcut, TodayLoneWorking } from "./TodayShortcuts";

const LOCATION = "0199d000-0000-7000-8000-000000000401";
const SESSION = "0199d000-0000-7000-8000-000000000601";
const NOW = new Date("2026-10-11T09:45:00.000Z");

const open: Mine = {
  on: true,
  session: {
    id: SESSION,
    locationId: LOCATION,
    workKind: "domiciliary_visit",
    startedAt: "2026-10-11T09:00:00.000Z",
    plannedEndAt: "2026-10-11T13:00:00.000Z",
    intervalMinutes: 60,
    finishedAt: null,
    status: "ok",
    nextDueAt: "2026-10-11T10:00:00.000Z",
    overdueAlarmOpen: false,
    events: [],
  },
};

function today(view: LoneWorkerView) {
  const sent: LoneWorkerEventKind[] = [];
  const element = createElement(TodayLoneWorking, {
    view,
    connected: true,
    answeredAt: "2026-10-11T09:40:00.000Z",
    locationId: LOCATION,
    locationName: "Example House",
    now: () => NOW,
    onStart: async () => "saved" as WriteOutcome,
    onEvent: async (kind) => {
      sent.push(kind);
      return "saved" as WriteOutcome;
    },
  });
  return { element, sent };
}

/** Every button's spoken label, in order. */
function buttonLabels(nodes: readonly RenderedNode[]): string[] {
  return nodes.flatMap((n) => [
    ...(n.props.accessibilityRole === "button" ? [String(n.props.accessibilityLabel)] : []),
    ...buttonLabels((n.children ?? []).filter((c): c is RenderedNode => typeof c !== "string")),
  ]);
}

describe("Today's shortcuts (ADR-0138)", () => {
  it("hazard HZ-125 an open session shows check in and ask for help on Today", async () => {
    const { element, sent } = today(loneWorkerView(open, [], NOW));
    const view = await render(element);
    expect(buttonLabels(view.nodes())).toEqual(["Check in", "Ask for help", "Finish lone working"]);
    // The duress long press works from Today too, and reads exactly like a check-in.
    await view.longPress("lone-check-in");
    expect(sent).toEqual(["duress"]);
    expect(view.texts()).toContain("Checked in at 10:45.");
  });

  it("hazard HZ-125 shows nothing on Today when no session is open: starting stays under More", async () => {
    const none = await render(today(loneWorkerView({ on: true, session: null }, [], NOW)).element);
    expect(none.nodes()).toEqual([]);
    const off = await render(today(loneWorkerView({ on: false, session: null }, [], NOW)).element);
    expect(off.nodes()).toEqual([]);
  });

  it("opens the handover in one tap", async () => {
    let opened = 0;
    const view = await render(
      createElement(HandoverShortcut, {
        onOpen: () => {
          opened += 1;
        },
      }),
    );
    expect(buttonLabels(view.nodes())).toEqual(["Open handover"]);
    await view.press("today-handover-open");
    expect(opened).toBe(1);
  });
});
