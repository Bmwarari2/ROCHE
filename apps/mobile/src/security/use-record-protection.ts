import { usePreventScreenCapture } from "expo-screen-capture";

/**
 * Record screens block screenshots and screen recording while mounted: FLAG_SECURE on Android
 * (which also blanks the app-switcher preview), and capture prevention on iOS. Each screen passes
 * its own key so screens do not re-enable capture for each other.
 */
export function useRecordScreenProtection(screenKey: string): void {
  usePreventScreenCapture(`record:${screenKey}`);
}
