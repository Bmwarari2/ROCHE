import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { LoneWorkKind } from "../scheduling/actions";
import { type ClockEventRow, clockView, type ShiftRow } from "../scheduling/clock-view";
import type { WriteOutcome } from "../scheduling/hooks";
import {
  type LoneWorkerEventKind,
  type LoneWorkerView,
  loneWorkerView,
  type Mine,
} from "../scheduling/lone-worker-view";
import { type RenderedNode, render } from "../test-support/render";
import { ClockCard } from "./ClockCard";
import { LoneWorkingPanel } from "./LoneWorkingPanel";
import { ShiftList } from "./ShiftList";

/**
 * The Shifts tab, rendered (scheduling.md section 18; SCHED-002, SCHED-004, SCHED-012; HZ-124,
 * HZ-125): what a member reads and presses. Invented ids only.
 */

const LOCATION = "0199d000-0000-7000-8000-000000000401";
const SESSION = "0199d000-0000-7000-8000-000000000601";
const NOW = new Date("2026-10-11T09:45:00.000Z");

const shift = (overrides: Partial<ShiftRow> = {}): ShiftRow => ({
  id: "shift-1",
  location_id: LOCATION,
  label: "Early",
  kind: "work",
  starts_at: "2026-10-11T07:00:00.000Z",
  ends_at: "2026-10-11T15:00:00.000Z",
  break_minutes: 30,
  changed_after_publish_at: null,
  ...overrides,
});

describe("the clock card, rendered", () => {
  it("says the state and the shift in words, and offers clock in", async () => {
    const pressed: string[] = [];
    const view = await render(
      createElement(ClockCard, {
        view: clockView([shift()], [], NOW),
        onAction: async (kind) => {
          pressed.push(kind);
          return "saved" as WriteOutcome;
        },
      }),
    );
    expect(view.texts()).toEqual(expect.arrayContaining(["Not clocked in", "For: Early"]));
    expect(view.find("clock-in")?.props.accessibilityLabel).toBe("Clock in, for Early");
    await view.press("clock-in");
    expect(pressed).toEqual(["in"]);
    expect(view.texts()).toContain(
      "Saved on this phone. It is sent to Harbour when there is a connection.",
    );
  });

  it("counts clock events waiting to send, in words", async () => {
    const waiting: ClockEventRow = {
      id: "e1",
      kind: "in",
      shift_id: "shift-1",
      location_id: LOCATION,
      device_time: "2026-10-11T07:02:00.000Z",
      recorded_at: null,
    };
    const view = await render(
      createElement(ClockCard, {
        view: clockView([shift()], [waiting], NOW),
        onAction: async () => "saved" as WriteOutcome,
      }),
    );
    expect(view.texts()).toEqual(
      expect.arrayContaining([
        "Clocked in at 08:02",
        "1 clock event is waiting to send. Harbour checks it against your organisation's rules when it arrives.",
      ]),
    );
    expect(view.find("clock-break_start")).toBeTruthy();
    expect(view.find("clock-out")).toBeTruthy();
  });

  it("says, in words, when the phone cannot tell where the member is working", async () => {
    const view = await render(
      createElement(ClockCard, {
        view: clockView([], [], NOW),
        onAction: async () => "no_location" as WriteOutcome,
      }),
    );
    await view.press("clock-in");
    expect(view.texts()).toContain(
      "This phone cannot tell where you are working, so it cannot record this. Ask the person in charge of your shift.",
    );
  });
});

describe("my shifts, rendered", () => {
  it("lists each shift with when, kind and a change said in words", async () => {
    const items = clockView(
      [shift({ changed_after_publish_at: "2026-10-09T12:00:00Z" })],
      [],
      NOW,
    ).shifts;
    const view = await render(createElement(ShiftList, { items }));
    expect(view.texts()).toEqual(
      expect.arrayContaining([
        "Early",
        "11/10/2026 at 08:00 to 16:00",
        "Work",
        "Under way",
        "Changed after it was published",
      ]),
    );
  });

  it("says when there are none", async () => {
    const view = await render(createElement(ShiftList, { items: [] }));
    expect(view.find("shift-list-empty")).toBeTruthy();
  });
});

/** Every button's spoken label, in order. */
function buttonLabels(nodes: readonly RenderedNode[]): string[] {
  return nodes.flatMap((n) => [
    ...(n.props.accessibilityRole === "button" ? [String(n.props.accessibilityLabel)] : []),
    ...buttonLabels((n.children ?? []).filter((c): c is RenderedNode => typeof c !== "string")),
  ]);
}

describe("lone working, rendered (HZ-125)", () => {
  const mine: Mine = {
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

  function panel(view: LoneWorkerView, connected = true) {
    const sent: LoneWorkerEventKind[] = [];
    const started: Array<{ workKind: LoneWorkKind; hours: number; intervalMinutes: number }> = [];
    const element = createElement(LoneWorkingPanel, {
      view,
      connected,
      asked: true,
      locationId: LOCATION,
      locationName: "Example House",
      now: () => NOW,
      onStart: async (input) => {
        started.push(input);
        return "saved" as WriteOutcome;
      },
      onEvent: async (kind) => {
        sent.push(kind);
        return "saved" as WriteOutcome;
      },
    });
    return { element, sent, started };
  }

  it("draws exactly the same screen after a duress press as after a check-in", async () => {
    const checkIn = panel(loneWorkerView(mine, [], NOW));
    const duress = panel(loneWorkerView(mine, [], NOW));
    const a = await render(checkIn.element);
    const b = await render(duress.element);
    await a.press("lone-check-in");
    await b.longPress("lone-check-in");
    expect(checkIn.sent).toEqual(["check_in"]);
    expect(duress.sent).toEqual(["duress"]);
    expect(JSON.stringify(b.nodes())).toBe(JSON.stringify(a.nodes()));
    expect(b.texts()).toContain("Checked in at 10:45.");
    expect(JSON.stringify(b.nodes())).not.toMatch(/duress/i);
  });

  it("offers no duress control of its own: only Check in, Ask for help and Finish", async () => {
    const view = await render(panel(loneWorkerView(mine, [], NOW)).element);
    const buttons = buttonLabels(view.nodes());
    expect(buttons).toEqual(["Check in", "Ask for help", "Finish lone working"]);
  });

  it("says a help press has not reached anyone when the phone is offline, and to call 999", async () => {
    const queued = [
      {
        id: "e1",
        action: "event" as const,
        sessionId: SESSION,
        body: { id: "e1", kind: "help", deviceAt: NOW.toISOString() },
      },
    ];
    const view = await render(panel(loneWorkerView(mine, queued, NOW), false).element);
    expect(view.texts()).toContain(
      "Your request for help has not reached anyone yet: this phone has no connection. If you are in danger, call 999.",
    );
    expect(view.texts()).toContain("Asked for help at 10:45. Waiting to send");
  });

  it("never says help is on its way: online it is being sent, with 999 said too", async () => {
    const view = await render(panel(loneWorkerView(mine, [], NOW)).element);
    await view.press("lone-help");
    expect(view.texts()).toContain(
      "Your request for help is being sent. If you are in danger, call 999.",
    );
  });

  it("starts a session with the choices made, each choice said in words", async () => {
    const { element, started } = panel(loneWorkerView({ on: true, session: null }, [], NOW));
    const view = await render(element);
    expect(view.texts()).toEqual(
      expect.arrayContaining(["Where: Example House", "Home visit, chosen", "4 hours, chosen"]),
    );
    await view.press("lone-kind-night_shift");
    await view.press("lone-interval-30");
    await view.press("lone-start");
    expect(started).toEqual([
      { locationId: LOCATION, workKind: "night_shift", hours: 4, intervalMinutes: 30 },
    ]);
  });

  it("says when lone working is off for the organisation", async () => {
    const view = await render(panel(loneWorkerView({ on: false, session: null }, [], NOW)).element);
    expect(view.texts()).toContain("Lone working is not switched on for your organisation.");
    expect(view.find("lone-start")).toBeNull();
  });
});
