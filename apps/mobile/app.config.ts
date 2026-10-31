import type { ConfigContext, ExpoConfig } from "expo/config";
import { type ConfigPlugin, withAndroidManifest } from "expo/config-plugins";

/**
 * Harbour mobile app configuration (Expo SDK 57).
 *
 * - Bundle ID / application ID `uk.co.thapsus.harbour` (publisher: Thapsus Cargo Ltd; decision to
 *   record in an ADR because store identifiers cannot change after first submission).
 * - The New Architecture and Hermes are the only options in React Native 0.86 / Expo SDK 57, so the
 *   old `newArchEnabled` and `jsEngine` keys no longer exist in the config schema; there is
 *   nothing to switch on.
 * - Usage strings are British English and say why, as App Review and section 17.2 require. Camera,
 *   location and microphone are declared for later phases; Android permissions are limited to what
 *   Phase 0 uses, and the rest are blocked so a dependency cannot add them silently.
 */

const BUNDLE_ID = "uk.co.thapsus.harbour";
const VERSION = process.env.HARBOUR_APP_VERSION ?? "0.1.0";
const BUILD_NUMBER = process.env.HARBOUR_BUILD_NUMBER ?? "1";

const FACE_ID_REASON =
  "Harbour uses Face ID to unlock the encrypted care records stored on this device.";

/**
 * The CI emulator build (`.github/workflows/mobile.yml`, HARBOUR_E2E_BUILD=1) talks to the runner's
 * API and PowerSync over the phone's loopback (`adb reverse`), in plain http, so Android's release
 * default that blocks cleartext is lifted for that build alone. The app still refuses any http URL
 * but loopback (`src/config/env.ts`). Never in an EAS build: no store or tester binary carries it.
 */
const E2E_BUILD = process.env.HARBOUR_E2E_BUILD === "1";
if (E2E_BUILD && process.env.EAS_BUILD) {
  throw new Error("HARBOUR_E2E_BUILD is for the CI emulator build only, never an EAS build");
}
const withE2eLoopbackCleartext: ConfigPlugin = (expoConfig) =>
  withAndroidManifest(expoConfig, (mod) => {
    const application = mod.modResults.manifest.application?.[0];
    if (application) application.$["android:usesCleartextTraffic"] = "true";
    return mod;
  });

const appConfig = ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "Harbour",
  slug: "harbour",
  scheme: "harbour",
  // Phones and tablets only: the web app is apps/web.
  platforms: ["ios", "android"],
  owner: process.env.EXPO_OWNER,
  version: VERSION,
  orientation: "default",
  userInterfaceStyle: "automatic",
  runtimeVersion: { policy: "fingerprint" },
  ios: {
    bundleIdentifier: BUNDLE_ID,
    buildNumber: BUILD_NUMBER,
    supportsTablet: true,
    infoPlist: {
      NSFaceIDUsageDescription: FACE_ID_REASON,
      NSCameraUsageDescription:
        "Harbour uses the camera to take photos for care records and to scan medicine barcodes.",
      NSLocationWhenInUseUsageDescription:
        "Harbour uses your location only while the app is open, to confirm you have arrived at a home care visit.",
      NSMicrophoneUsageDescription:
        "Harbour uses the microphone to record voice notes that you add to care records.",
    },
    privacyManifests: {
      NSPrivacyTracking: false,
      NSPrivacyTrackingDomains: [],
      NSPrivacyAccessedAPITypes: [
        {
          // React Native and Expo modules keep app settings in NSUserDefaults.
          NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryUserDefaults",
          NSPrivacyAccessedAPITypeReasons: ["CA92.1"],
        },
        {
          // SQLite (op-sqlite, SQLCipher) and expo-file-system read file timestamps inside the app container.
          NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryFileTimestamp",
          NSPrivacyAccessedAPITypeReasons: ["C617.1"],
        },
        {
          // React Native measures elapsed time for performance and timers.
          NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategorySystemBootTime",
          NSPrivacyAccessedAPITypeReasons: ["35F9.1"],
        },
        {
          // expo-file-system checks free space before writing the offline database and files.
          NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryDiskSpace",
          NSPrivacyAccessedAPITypeReasons: ["E174.1"],
        },
      ],
      NSPrivacyCollectedDataTypes: [
        {
          NSPrivacyCollectedDataType: "NSPrivacyCollectedDataTypeHealth",
          NSPrivacyCollectedDataTypeLinked: true,
          NSPrivacyCollectedDataTypeTracking: false,
          NSPrivacyCollectedDataTypePurposes: ["NSPrivacyCollectedDataTypePurposeAppFunctionality"],
        },
        {
          NSPrivacyCollectedDataType: "NSPrivacyCollectedDataTypeName",
          NSPrivacyCollectedDataTypeLinked: true,
          NSPrivacyCollectedDataTypeTracking: false,
          NSPrivacyCollectedDataTypePurposes: ["NSPrivacyCollectedDataTypePurposeAppFunctionality"],
        },
        {
          NSPrivacyCollectedDataType: "NSPrivacyCollectedDataTypeEmailAddress",
          NSPrivacyCollectedDataTypeLinked: true,
          NSPrivacyCollectedDataTypeTracking: false,
          NSPrivacyCollectedDataTypePurposes: ["NSPrivacyCollectedDataTypePurposeAppFunctionality"],
        },
      ],
    },
  },
  android: {
    package: BUNDLE_ID,
    versionCode: Number.parseInt(BUILD_NUMBER, 10),
    // Care data must not leave the device through Android backup or device transfer.
    allowBackup: false,
    permissions: [
      "android.permission.INTERNET",
      "android.permission.ACCESS_NETWORK_STATE",
      "android.permission.USE_BIOMETRIC",
      "android.permission.USE_FINGERPRINT",
      "android.permission.VIBRATE",
      // Local notifications when held entries reach their last day and escalate (HZ-040).
      "android.permission.POST_NOTIFICATIONS",
    ],
    blockedPermissions: [
      "android.permission.READ_EXTERNAL_STORAGE",
      "android.permission.WRITE_EXTERNAL_STORAGE",
      "android.permission.READ_MEDIA_IMAGES",
      "android.permission.ACCESS_WIFI_STATE",
      "android.permission.SYSTEM_ALERT_WINDOW",
      "android.permission.CAMERA",
      "android.permission.RECORD_AUDIO",
      "android.permission.ACCESS_FINE_LOCATION",
      "android.permission.ACCESS_COARSE_LOCATION",
      "android.permission.ACCESS_BACKGROUND_LOCATION",
    ],
  },
  plugins: [
    "expo-router",
    "expo-dev-client",
    ["expo-secure-store", { faceIDPermission: FACE_ID_REASON, configureAndroidBackup: true }],
    ["expo-local-authentication", { faceIDPermission: FACE_ID_REASON }],
    // Local notifications only (held entries, HZ-040); no push service is configured.
    "expo-notifications",
  ],
  experiments: {
    typedRoutes: true,
  },
  extra: {
    eas: process.env.EAS_PROJECT_ID ? { projectId: process.env.EAS_PROJECT_ID } : undefined,
  },
});

export default (context: ConfigContext): ExpoConfig => {
  const expoConfig = appConfig(context);
  return E2E_BUILD ? withE2eLoopbackCleartext(expoConfig) : expoConfig;
};
