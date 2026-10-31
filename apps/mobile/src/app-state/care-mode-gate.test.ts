import { describe, expect, it, vi } from "vitest";
import { admitCareMode, CareModeOffError, careModeOn } from "./care-mode-gate";

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
});
