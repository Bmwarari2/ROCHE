import { describe, expect, it } from "vitest";
import { DEMO_TENANT_ID } from "../demo/demo-data";
import { t } from "../i18n/t";
import { FINAL_WARNING_MS } from "../sync/held-limit";
import { heldView } from "./held-view";
import { type HeldWork, UNKNOWN_OWNER, withDeadline } from "./held-work";

/** Invented staff: Sam Example wrote the entries. */
const held: HeldWork = {
  tenantId: DEMO_TENANT_ID,
  tenantUserId: "00000000-0000-4000-8000-0000000000c1",
  userId: "user-sam",
  ownerName: "Sam Example",
  entries: 2,
  heldAt: "2026-10-11T07:30:00.000Z",
  expiresAt: "2026-10-18T07:30:00.000Z",
  lastServerTime: null,
};
const DEADLINE = Date.parse("2026-10-18T07:30:00.000Z");

describe("hazard HZ-040 the sign-in screen on held entries (clinical review H2, C8)", () => {
  it("says when a manager will need to resolve them, and that nothing is deleted", () => {
    const view = heldView(held, new Date("2026-10-11T08:00:00Z"));
    expect(view).toMatchObject({ state: "open", urgent: false });
    expect(view.time).toBe(
      "If they are not sent by 18/10/2026 at 08:30, a manager will need to resolve them. Nothing is deleted automatically.",
    );
    expect(view.owner).toBe("Entries from Sam Example are waiting to be sent.");
    expect(view.discardLabel).toBe("Delete 2 unsent entries");
  });

  it("hazard HZ-040 says entries from a deletion that did not finish will not be sent (round 4, H1)", () => {
    const view = heldView({ ...held, uploadBlocked: true }, new Date("2026-10-11T08:00:00Z"));
    expect(view.body).toBe(t("mobile.held.blocked"));
    expect(view.body).toContain("they will not be sent");
  });

  it("gives a final warning naming the count in the last day", () => {
    const view = heldView(held, new Date(DEADLINE - FINAL_WARNING_MS + 60_000));
    expect(view).toMatchObject({ state: "final", urgent: true });
    expect(view.time).toBe(
      "Final warning: 2 unsent entries need to be sent by 18/10/2026 at 08:30. Sam Example needs to sign in to send them. After that, a manager must resolve them.",
    );
  });

  it("escalates to a manager at the deadline, never deleting", () => {
    const view = heldView(held, new Date(DEADLINE + 60_000));
    expect(view).toMatchObject({ state: "escalated", urgent: true });
    expect(view.time).toBe(
      "2 unsent entries were not sent in the time allowed and are still on this device. A manager must now resolve this. Sam Example can still sign in to send them, or a manager can sign in here to delete them with a reason. Tell the nurse in charge.",
    );
    expect(view.time).not.toMatch(/will be deleted|were deleted/);
  });

  it("says when the device clock cannot be trusted, and changes nothing", () => {
    const view = heldView(held, new Date("2026-10-10T08:00:00Z"));
    expect(view).toMatchObject({ state: "clockBehind", urgent: true });
    expect(view.time).toBe(t("mobile.held.clockBehind"));
  });

  it("says only a manager can resolve entries whose owner is unknown", () => {
    const unknown = withDeadline(UNKNOWN_OWNER, new Date("2026-10-11T08:00:00Z"));
    const view = heldView(unknown, new Date("2026-10-11T08:30:00Z"));
    expect(view.owner).toBe(
      "Entries from another member of staff are waiting to be sent. This device cannot tell whose they are, so only a manager can resolve them.",
    );
    expect(view.title).toBe(t("mobile.held.titleUnknown"));
    expect(view.discardLabel).toBe("Delete the unsent entries");
  });

  it("writes the notifications without names, counts or care details", () => {
    for (const key of [
      "mobile.held.notificationTitle",
      "mobile.held.notificationFinal",
      "mobile.held.notificationEscalated",
    ] as const) {
      expect(t(key)).not.toMatch(/\d|Sam|Example/);
    }
  });
});
