import { describe, expect, it } from "vitest";
import {
  clampSharedTimeout,
  describeTimeout,
  PERSONAL_AUTO_LOCK_MS,
  parseDeviceMode,
  resolveAutoLockMs,
  SHARED_AUTO_LOCK_CHOICES_MS,
  SHARED_AUTO_LOCK_DEFAULT_MS,
} from "./auto-lock";

describe("auto-lock policy (section 17.2)", () => {
  it("is 2 minutes on personal devices whatever the shared setting", () => {
    expect(resolveAutoLockMs("personal")).toBe(120_000);
    expect(resolveAutoLockMs("personal", 30_000)).toBe(PERSONAL_AUTO_LOCK_MS);
  });

  it("defaults to 30 seconds on shared devices", () => {
    expect(resolveAutoLockMs("shared")).toBe(30_000);
    expect(resolveAutoLockMs("shared", null)).toBe(SHARED_AUTO_LOCK_DEFAULT_MS);
  });

  it.each([
    [10_000, 30_000],
    [30_000, 30_000],
    [75_000, 75_000],
    [120_000, 120_000],
    [600_000, 120_000],
    [Number.NaN, 30_000],
  ])("clamps a shared setting of %d ms to %d ms", (input, expected) => {
    expect(clampSharedTimeout(input)).toBe(expected);
    expect(resolveAutoLockMs("shared", input)).toBe(expected);
  });

  it("offers only choices inside the allowed range", () => {
    for (const choice of SHARED_AUTO_LOCK_CHOICES_MS) {
      expect(clampSharedTimeout(choice)).toBe(choice);
    }
  });

  it.each([
    [30_000, "30 seconds"],
    [60_000, "1 minute"],
    [90_000, "1 minute 30 seconds"],
    [120_000, "2 minutes"],
    [1_000, "1 second"],
  ])("describes %d ms as %s", (ms, text) => {
    expect(describeTimeout(ms)).toBe(text);
  });

  it("starts personal and treats anything unexpected as shared (stricter)", () => {
    expect(parseDeviceMode(null)).toBe("personal");
    expect(parseDeviceMode("personal")).toBe("personal");
    expect(parseDeviceMode("shared")).toBe("shared");
    expect(parseDeviceMode("kiosk")).toBe("shared");
    expect(parseDeviceMode("garbage")).toBe("shared");
  });
});
