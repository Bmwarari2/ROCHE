/**
 * Device authentication with expo-local-authentication: strong biometrics (Face ID, Class 3
 * fingerprint or face) with the device passcode as the fallback (section 17.2).
 */
import * as LocalAuthentication from "expo-local-authentication";
import { t } from "../i18n/t";

export type UnlockFailure = "cancelled" | "not_secure" | "locked_out" | "unavailable" | "failed";

export class DeviceNotSecureError extends Error {
  constructor() {
    super(
      "Set a screen lock (passcode, PIN or pattern) on this device to use Thapsus Care. Care records are only stored on locked devices.",
    );
    this.name = "DeviceNotSecureError";
  }
}

/** Care data is only stored on devices with a screen lock (MASVS-STORAGE, section 5.3). */
export async function assertDeviceSecure(): Promise<void> {
  const level = await LocalAuthentication.getEnrolledLevelAsync();
  if (level === LocalAuthentication.SecurityLevel.NONE) throw new DeviceNotSecureError();
}

export async function authenticate(
  promptMessage: string,
): Promise<{ ok: true } | { ok: false; reason: UnlockFailure }> {
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage,
    biometricsSecurityLevel: "strong",
    disableDeviceFallback: false,
    cancelLabel: "Cancel",
    fallbackLabel: "Use passcode",
  });
  if (result.success) return { ok: true };
  switch (result.error) {
    case "user_cancel":
    case "system_cancel":
    case "app_cancel":
      return { ok: false, reason: "cancelled" };
    case "passcode_not_set":
    case "not_enrolled":
      return { ok: false, reason: "not_secure" };
    case "lockout":
      return { ok: false, reason: "locked_out" };
    case "not_available":
      return { ok: false, reason: "unavailable" };
    default:
      return { ok: false, reason: "failed" };
  }
}

/** What each unlock failure says, from the catalogue (`mobile.unlock.failure`; section 5.4). */
export const unlockFailureMessages: Record<UnlockFailure, string> = {
  cancelled: t("mobile.unlock.failure", { reason: "cancelled" }),
  not_secure: t("mobile.unlock.failure", { reason: "not_secure" }),
  locked_out: t("mobile.unlock.failure", { reason: "locked_out" }),
  unavailable: t("mobile.unlock.failure", { reason: "unavailable" }),
  failed: t("mobile.unlock.failure", { reason: "failed" }),
};
