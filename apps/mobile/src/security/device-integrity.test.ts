import { describe, expect, it } from "vitest";
import {
  allowsHighRiskFeatures,
  type DeviceIntegrityResult,
  stubIntegrityChecker,
} from "./device-integrity";

const result = (status: DeviceIntegrityResult["status"]): DeviceIntegrityResult => ({
  status,
  reasons: [],
  checkedAt: new Date("2026-10-11T10:00:00Z"),
});

describe("device integrity (section 17.2: root or jailbreak warns and disables eMAR)", () => {
  it("reports unknown until a real check ships, never trusted", async () => {
    await expect(stubIntegrityChecker.check()).resolves.toMatchObject({ status: "unknown" });
  });

  it.each([
    [null, false],
    ["unknown", false],
    ["compromised", false],
    ["trusted", true],
  ] as const)("allows high-risk features for %s: %s", (status, expected) => {
    expect(allowsHighRiskFeatures(status === null ? null : result(status))).toBe(expected);
  });
});
