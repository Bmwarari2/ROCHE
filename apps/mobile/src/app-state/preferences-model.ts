/**
 * Device preferences kept outside the encrypted database (they are needed before it is unlocked):
 * theme, high contrast, device mode and the shared-device auto-lock. Nothing here is personal data.
 */
import type { SchemePreference, ThemePreference } from "@harbour/ui-native/logic";
import {
  clampSharedTimeout,
  type DeviceMode,
  parseDeviceMode,
  SHARED_AUTO_LOCK_DEFAULT_MS,
} from "../security/auto-lock";

export type AppMode = "care" | "manage" | "family";

export interface Preferences {
  readonly theme: ThemePreference;
  readonly deviceMode: DeviceMode;
  readonly sharedAutoLockMs: number;
}

export const defaultPreferences: Preferences = {
  theme: { scheme: "system", highContrast: false },
  deviceMode: "personal",
  sharedAutoLockMs: SHARED_AUTO_LOCK_DEFAULT_MS,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseScheme(value: unknown): SchemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

/** Tolerant parse: anything missing or malformed falls back to the default for that field. */
export function parsePreferences(raw: string | null | undefined): Preferences {
  if (!raw) return defaultPreferences;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return defaultPreferences;
  }
  if (!isRecord(value)) return defaultPreferences;
  const theme = isRecord(value.theme) ? value.theme : {};
  return {
    theme: { scheme: parseScheme(theme.scheme), highContrast: theme.highContrast === true },
    deviceMode:
      typeof value.deviceMode === "string" ? parseDeviceMode(value.deviceMode) : "personal",
    sharedAutoLockMs: clampSharedTimeout(
      typeof value.sharedAutoLockMs === "number" ? value.sharedAutoLockMs : null,
    ),
  };
}

export function parseAppMode(value: string | null | undefined): AppMode | null {
  return value === "care" || value === "manage" || value === "family" ? value : null;
}
