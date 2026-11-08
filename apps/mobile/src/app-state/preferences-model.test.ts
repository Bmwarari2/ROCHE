import { describe, expect, it } from "vitest";
import {
  defaultPreferences,
  mayChangeDeviceMode,
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
