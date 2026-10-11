import { describe, expect, it } from "vitest";
import {
  FINAL_WARNING_MS,
  HELD_NOTIFICATION_IDS,
  type HeldTimes,
  heldDeadline,
  heldTimeState,
  planHeldNotifications,
} from "./held-limit";

const HELD_AT = new Date("2026-10-11T07:30:00.000Z");
const DEADLINE = heldDeadline(HELD_AT, 7);
const hold = (overrides: Partial<HeldTimes> = {}): HeldTimes => ({
  heldAt: HELD_AT.toISOString(),
  expiresAt: DEADLINE.toISOString(),
  lastServerTime: "2026-10-11T07:00:00.000Z",
  ...overrides,
});
const at = (ms: number) => new Date(ms);

describe("hazard HZ-040 a hold escalates to a manager and is never deleted (security review M3)", () => {
  it.each([
    ["just held", HELD_AT.getTime(), "open"],
    ["six days in", DEADLINE.getTime() - FINAL_WARNING_MS - 1, "open"],
    ["the last day", DEADLINE.getTime() - FINAL_WARNING_MS, "final"],
    ["the deadline", DEADLINE.getTime(), "escalated"],
    ["a month later", DEADLINE.getTime() + 30 * 86_400_000, "escalated"],
  ])("%s reads as %s", (_case, now, state) => {
    expect(heldTimeState(hold(), at(now))).toBe(state);
  });

  it("is never open-ended: a hold without a usable deadline escalates (L2)", () => {
    expect(heldTimeState(hold({ expiresAt: null }), HELD_AT)).toBe("escalated");
    expect(heldTimeState(hold({ expiresAt: "not a date" }), HELD_AT)).toBe("escalated");
  });

  it("hazard HZ-010 does not act on a clock earlier than the hold's start or the last server time", () => {
    expect(heldTimeState(hold(), at(HELD_AT.getTime() - 60_000))).toBe("clockBehind");
    // The server was last reached after the hold started on a wrong device clock.
    const serverLater = hold({ lastServerTime: "2026-10-12T09:00:00.000Z" });
    expect(heldTimeState(serverLater, at(Date.parse("2026-10-12T08:00:00.000Z")))).toBe(
      "clockBehind",
    );
  });

  it("hazard HZ-010 treats a clock that jumped forward as a reason to escalate, nothing more", () => {
    const jumped = at(DEADLINE.getTime() + 365 * 86_400_000);
    expect(heldTimeState(hold(), jumped)).toBe("escalated");
  });

  it("plans a notification for the start of the last day and for the escalation", () => {
    expect(planHeldNotifications(hold(), HELD_AT)).toEqual([
      {
        identifier: HELD_NOTIFICATION_IDS.final,
        kind: "final",
        at: at(DEADLINE.getTime() - FINAL_WARNING_MS),
      },
      { identifier: HELD_NOTIFICATION_IDS.escalated, kind: "escalated", at: DEADLINE },
    ]);
  });

  it("plans only what is still ahead", () => {
    const lastDay = at(DEADLINE.getTime() - 3600_000);
    expect(planHeldNotifications(hold(), lastDay).map((p) => p.kind)).toEqual(["escalated"]);
    expect(planHeldNotifications(hold(), DEADLINE)).toEqual([]);
    expect(planHeldNotifications(hold({ expiresAt: null }), HELD_AT)).toEqual([]);
  });
});
