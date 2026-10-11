/**
 * expo-secure-store adapters. Items written here live in the iOS Keychain or Android Keystore,
 * "this device only", so they are excluded from backups and device transfer.
 */
import * as SecureStore from "expo-secure-store";
import type { KeyOptions, KeyProtection, SecretStore } from "../security/db-key";

export const secretStore: SecretStore = {
  getItem: (key, options) => SecureStore.getItemAsync(key, options),
  setItem: (key, value, options) => SecureStore.setItemAsync(key, value, options),
  deleteItem: (key, options) => SecureStore.deleteItemAsync(key, options),
};

/** Non-secret bookkeeping and the session token: readable while the device is unlocked. */
export const plainOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/**
 * The database key. Biometric protection uses `requireAuthentication`, so reading the key shows
 * the system Face ID or fingerprint prompt; `WHEN_PASSCODE_SET_THIS_DEVICE_ONLY` makes the item
 * disappear if the device passcode is removed.
 */
export const keyOptions: KeyOptions = {
  plainOptions,
  protectedOptions: (protection: KeyProtection) => ({
    requireAuthentication: protection === "biometric",
    authenticationPrompt: "Unlock Harbour",
    keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
  }),
};

/** Biometric keystore protection when the device supports it, otherwise passcode-gated. */
export function preferredKeyProtection(): KeyProtection {
  try {
    return SecureStore.canUseBiometricAuthentication() ? "biometric" : "passcode";
  } catch {
    return "passcode";
  }
}

export const SESSION_TOKEN_ITEM = "harbour.session-token.v1";
export const ME_ITEM = "harbour.me.v1";
export const MODE_ITEM = "harbour.mode.v1";
export const PREFERENCES_ITEM = "harbour.preferences.v1";

export async function readPlain(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key, plainOptions);
  } catch {
    return null;
  }
}

export async function writePlain(key: string, value: string): Promise<void> {
  await SecureStore.setItemAsync(key, value, plainOptions);
}

export async function deletePlain(key: string): Promise<void> {
  await SecureStore.deleteItemAsync(key, plainOptions).catch(() => undefined);
}
