import { describe, expect, it } from "vitest";
import {
  allowsHighRiskFeatures,
  type DeviceIntegrityResult,
  integrityFromSignals,
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

describe("eMAR is off on a rooted or jailbroken phone (MASVS L2; slice 69)", () => {
  const at = new Date("2026-11-07T10:00:00Z");
  it.each([
    ["no signal", { jailBroken: false, hookDetected: false }, "trusted"],
    ["rooted or jailbroken", { jailBroken: true, hookDetected: false }, "compromised"],
    ["a hooking tool", { jailBroken: false, hookDetected: true }, "compromised"],
    ["checks that could not run", null, "unknown"],
  ] as const)("%s", (_case, signals, status) => {
    const result = integrityFromSignals(signals, at);
    expect(result.status).toBe(status);
    expect(allowsHighRiskFeatures(result)).toBe(status === "trusted");
  });
});
