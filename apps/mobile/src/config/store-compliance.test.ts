import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import appConfig from "../../app.config";

/**
 * Store compliance (MOB-011; master prompt 17.3; docs/compliance/app-store-privacy.md). The
 * privacy manifest declares exactly what the app collects, with no tracking; nothing collected
 * without a declaration; Android permissions the app does not use yet stay blocked; the binary
 * targets API 36 and builds with Xcode 26 and the iOS 26 SDK. If this test changes, the privacy
 * answers in the stores change too: update docs/compliance/app-store-privacy.md in the same PR.
 */

const here = dirname(fileURLToPath(import.meta.url));
const config = appConfig({ config: {} } as Parameters<typeof appConfig>[0]);
const manifest = config.ios?.privacyManifests as {
  NSPrivacyTracking: boolean;
  NSPrivacyTrackingDomains: string[];
  NSPrivacyCollectedDataTypes: {
    NSPrivacyCollectedDataType: string;
    NSPrivacyCollectedDataTypeLinked: boolean;
    NSPrivacyCollectedDataTypeTracking: boolean;
    NSPrivacyCollectedDataTypePurposes: string[];
  }[];
};

describe("Apple privacy manifest and nutrition label (MOB-011)", () => {
  it("declares no tracking and no tracking domains", () => {
    expect(manifest.NSPrivacyTracking).toBe(false);
    expect(manifest.NSPrivacyTrackingDomains).toEqual([]);
  });

  it("declares exactly the data the app collects, each linked, for app functionality only", () => {
    expect(
      manifest.NSPrivacyCollectedDataTypes.map((d) => d.NSPrivacyCollectedDataType).sort(),
    ).toEqual([
      "NSPrivacyCollectedDataTypeDeviceID",
      "NSPrivacyCollectedDataTypeEmailAddress",
      "NSPrivacyCollectedDataTypeHealth",
      "NSPrivacyCollectedDataTypeName",
      "NSPrivacyCollectedDataTypeOtherDiagnosticData",
      "NSPrivacyCollectedDataTypeUserID",
    ]);
    for (const type of manifest.NSPrivacyCollectedDataTypes) {
      expect(type.NSPrivacyCollectedDataTypeLinked).toBe(true);
      expect(type.NSPrivacyCollectedDataTypeTracking).toBe(false);
      expect(type.NSPrivacyCollectedDataTypePurposes).toEqual([
        "NSPrivacyCollectedDataTypePurposeAppFunctionality",
      ]);
    }
  });

  it("collects no location, photos or audio yet, so Android blocks those permissions", () => {
    const blocked = config.android?.blockedPermissions ?? [];
    for (const permission of [
      "android.permission.CAMERA",
      "android.permission.RECORD_AUDIO",
      "android.permission.ACCESS_FINE_LOCATION",
      "android.permission.ACCESS_COARSE_LOCATION",
      "android.permission.ACCESS_BACKGROUND_LOCATION",
      "android.permission.READ_MEDIA_IMAGES",
    ]) {
      expect(blocked).toContain(permission);
      expect(config.android?.permissions ?? []).not.toContain(permission);
    }
    // Care data never leaves the device through Android backup.
    expect(config.android?.allowBackup).toBe(false);
  });
});

describe("SDK targets (MOB-011)", () => {
  it("targets and compiles against Android API 36 or later through React Native's defaults", () => {
    const require = createRequire(import.meta.url);
    const rn = dirname(require.resolve("react-native/package.json", { paths: [join(here, "..")] }));
    const versions = readFileSync(join(rn, "gradle", "libs.versions.toml"), "utf8");
    const level = (name: string) =>
      Number(new RegExp(`^${name} = "(\\d+)"`, "m").exec(versions)?.[1] ?? Number.NaN);
    expect(level("targetSdk")).toBeGreaterThanOrEqual(36);
    expect(level("compileSdk")).toBeGreaterThanOrEqual(36);
  });

  it("builds store binaries on an EAS image with Xcode 26 and the iOS 26 SDK", () => {
    const eas = JSON.parse(readFileSync(join(here, "..", "..", "eas.json"), "utf8")) as {
      build: Record<string, { distribution?: string; ios?: { image?: string } }>;
    };
    expect(eas.build.production?.distribution).toBe("store");
    // "latest" carries Xcode 26 from April 2026; pin a named Xcode 26 image once confirmed (H-563).
    expect(eas.build.production?.ios?.image).toMatch(/^(latest|.*xcode-2[6-9].*)$/);
  });
});
