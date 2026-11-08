import type { Translator } from "../i18n/t";
/**
 * Auto-lock policy (section 5.3 and 17.2): 2 minutes on personal devices; 30 seconds by default on
 * shared and kiosk devices, configurable from 30 seconds to 2 minutes. These are security policy
 * values from the specification, not statutory figures.
 */

export type DeviceMode = "personal" | "shared";

export const PERSONAL_AUTO_LOCK_MS = 120_000;
export const SHARED_AUTO_LOCK_DEFAULT_MS = 30_000;
export const SHARED_AUTO_LOCK_MIN_MS = 30_000;
export const SHARED_AUTO_LOCK_MAX_MS = 120_000;

/** Choices offered in Settings for shared devices. */
export const SHARED_AUTO_LOCK_CHOICES_MS = [30_000, 60_000, 90_000, 120_000] as const;

export function clampSharedTimeout(ms: number | null | undefined): number {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return SHARED_AUTO_LOCK_DEFAULT_MS;
  return Math.min(SHARED_AUTO_LOCK_MAX_MS, Math.max(SHARED_AUTO_LOCK_MIN_MS, Math.round(ms)));
}

export function resolveAutoLockMs(mode: DeviceMode, sharedTimeoutMs?: number | null): number {
  return mode === "personal" ? PERSONAL_AUTO_LOCK_MS : clampSharedTimeout(sharedTimeoutMs);
}

/** "30 seconds", "1 minute", "1 minute 30 seconds", "2 minutes". */
export function describeTimeout(ms: number, t: Translator): string {
  const totalSeconds = Math.round(ms / 1000);
  return t("mobile.autoLock.duration", {
    minutes: Math.floor(totalSeconds / 60),
    seconds: totalSeconds % 60,
  });
}

/**
 * A fresh install is personal. Any stored value other than "personal" (including "kiosk" from a
 * future MDM setting, or corruption) is treated as shared, the stricter policy.
 */
export function parseDeviceMode(value: string | null | undefined): DeviceMode {
  if (value === null || value === undefined || value === "personal") return "personal";
  return "shared";
}
