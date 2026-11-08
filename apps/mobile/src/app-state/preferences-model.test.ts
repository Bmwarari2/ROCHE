import { describe, expect, it } from "vitest";
import {
  defaultPreferences,
  mayChangeDeviceMode,
  mayChangeLockTime,
  parseAppMode,
  parsePreferences,
} from "./preferences-model";

describe("parsePreferences", () => {
  it.each([null, "", "not json", "[]", "42"])("falls back to defaults for %j", (raw) => {
    expect(parsePreferences(raw)).toEqual(defaultPreferences);
  });

  it("reads stored values", () => {
    expect(
      parsePreferences(
        JSON.stringify({
          theme: { scheme: "dark", highContrast: true },
          deviceMode: "shared",
          sharedAutoLockMs: 60_000,
        }),
      ),
    ).toEqual({
      theme: { scheme: "dark", highContrast: true },
      deviceMode: "shared",
      sharedAutoLockMs: 60_000,
    });
  });

  it("repairs out-of-range or malformed fields one by one", () => {
    expect(
      parsePreferences(
        JSON.stringify({ theme: { scheme: "purple" }, deviceMode: 3, sharedAutoLockMs: 5 }),
      ),
    ).toEqual({
      theme: { scheme: "system", highContrast: false },
      deviceMode: "personal",
      sharedAutoLockMs: 30_000,
    });
  });
});

describe("parseAppMode", () => {
  it.each([
    ["care", "care"],
    ["manage", "manage"],
    ["family", "family"],
    ["kiosk", null],
    [null, null],
  ])("%s -> %s", (raw, expected) => {
    expect(parseAppMode(raw)).toBe(expected);
  });
});

describe("hazard HZ-001 only a manager who may withdraw devices sets the device mode (guides review, H-1530)", () => {
  it.each([
    ["a care worker", ["care.note.write"], false],
    ["a manager", ["platform.device.revoke", "care.note.write"], true],
    ["no session", undefined, false],
  ] as const)("%s", (_case, permissions, may) => {
    expect(mayChangeDeviceMode(permissions)).toBe(may);
  });
});

describe("hazard HZ-001 anyone may make a shared phone lock sooner; only a manager makes it later (security review M2)", () => {
  it.each([
    ["a care worker choosing a shorter lock", ["care.note.write"], 300_000, 60_000, true],
    ["a care worker choosing a longer lock", ["care.note.write"], 60_000, 300_000, false],
    ["a manager choosing a longer lock", ["platform.device.revoke"], 60_000, 300_000, true],
  ] as const)("%s", (_case, permissions, current, choice, may) => {
    expect(mayChangeLockTime(permissions, current, choice)).toBe(may);
  });
});
