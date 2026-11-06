import { describe, expect, it, vi } from "vitest";
import { admitCareMode, CareModeOffError, careModeOn, sessionEndNotices } from "./care-mode-gate";

const on = { flags: { "care.mobile_care_mode": true } };
const off = { flags: { "care.mobile_care_mode": false } };

describe("hazard HZ-006 Care mode on the phone is a control, not an instruction (H-381)", () => {
  it.each([
    ["switched on", on, false, true],
    ["switched off", off, false, false],
    ["not in the answer (an older API or cached answer)", { flags: {} }, false, false],
    ["with no flags at all", {}, false, false],
    ["off, in the demonstration build", off, true, true],
  ])("is %s", (_label, me, demoMode, expected) => {
    expect(careModeOn(me, demoMode)).toBe(expected);
  });

  it("refuses a sign-in while it is off, ending the new session", async () => {
    const signOut = vi.fn(async () => undefined);
    await expect(
      admitCareMode({ me: off, demoMode: false, holdsEntries: false, token: "t", signOut }),
    ).rejects.toBeInstanceOf(CareModeOffError);
    expect(signOut).toHaveBeenCalledWith("t");
    await expect(
      admitCareMode({ me: off, demoMode: false, holdsEntries: false, token: "t", signOut }),
    ).rejects.toThrow(/switched off for your organisation/);
  });

  it.each([
    ["it is on", on, false],
    ["the phone holds unsent entries, so they can leave it", off, true],
  ])("admits a sign-in when %s", async (_label, me, holdsEntries) => {
    const signOut = vi.fn(async () => undefined);
    await expect(
      admitCareMode({ me, demoMode: false, holdsEntries, token: "t", signOut }),
    ).resolves.toBeUndefined();
    expect(signOut).not.toHaveBeenCalled();
  });

  it.each([
    ["nothing unsent", "wipe"],
    ["unsent entries kept", "held"],
  ] as const)(
    "hazard HZ-006 says Care mode was switched off when a session ends for it, with %s",
    (_label, which) => {
      const notices = sessionEndNotices({
        revoked: false,
        careModeOff: true,
        wipeNotice: "Sign in",
      });
      expect(notices[which]).toMatch(/switched off for your organisation/);
      expect(notices[which]).not.toBe("Sign in");
    },
  );

  it("keeps the usual notices otherwise, and a revoked device's over Care mode", () => {
    expect(
      sessionEndNotices({ revoked: false, careModeOff: false, wipeNotice: "Sign in" }),
    ).toEqual({ wipe: "Sign in", held: undefined });
    const revoked = sessionEndNotices({ revoked: true, careModeOff: true, wipeNotice: "Sign in" });
    expect(revoked.held).toMatch(/withdrew this device/);
  });
});
