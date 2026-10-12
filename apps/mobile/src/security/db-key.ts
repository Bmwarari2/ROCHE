/**
 * Per-install database encryption key (sections 5.3 and 17.2).
 *
 * A random 32-byte key is generated on first unlock and kept in the platform keystore through
 * expo-secure-store with `requireAuthentication` and `WHEN_PASSCODE_SET_THIS_DEVICE_ONLY`, so
 * reading it needs the user's biometrics: that read is the unlock. The key never leaves the device,
 * never enters a backup, and deleting it makes the database file unreadable (crypto-shredding).
 *
 * The key is passed to SQLCipher in raw-key form (x'<64 hex>'), which skips the passphrase key
 * derivation: the key is already uniformly random, and cold start stays fast.
 *
 * Pure apart from the injected store and random source, so it is unit-tested.
 */

export const DB_KEY_ITEM = "harbour.db-key.v1";
export const DB_ID_ITEM = "harbour.db-id.v1";
export const DB_KEY_PROTECTION_ITEM = "harbour.db-key-protection.v1";

/** How the key is protected: by biometrics in the keystore, or by the device passcode only. */
export type KeyProtection = "biometric" | "passcode";

export interface SecretStoreOptions {
  readonly requireAuthentication?: boolean;
  readonly authenticationPrompt?: string;
  readonly keychainAccessible?: number;
}

export interface SecretStore {
  getItem(key: string, options?: SecretStoreOptions): Promise<string | null>;
  setItem(key: string, value: string, options?: SecretStoreOptions): Promise<void>;
  deleteItem(key: string, options?: SecretStoreOptions): Promise<void>;
}

export interface KeyOptions {
  /** Options for the key itself (with authentication when protection is biometric). */
  readonly protectedOptions: (protection: KeyProtection) => SecretStoreOptions;
  /** Options for non-secret bookkeeping items. */
  readonly plainOptions: SecretStoreOptions;
}

export interface DatabaseKey {
  /** Random non-secret identifier, used in the database file name. */
  readonly id: string;
  /** SQLCipher raw key, x'<64 hex chars>'. */
  readonly sqlcipherKey: string;
  readonly protection: KeyProtection;
}

export interface LoadKeyResult {
  readonly key: DatabaseKey;
  /** True when a new key was made; any file from `previousId` can no longer be read. */
  readonly created: boolean;
  readonly previousId: string | null;
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export function isValidKeyHex(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function sqlcipherRawKey(hex: string): string {
  if (!isValidKeyHex(hex)) throw new Error("Database key must be 64 lowercase hex characters");
  return `x'${hex}'`;
}

/** File name for the database protected by key `id`; demo data never shares a file with care data. */
export function databaseFilename(id: string, demo = false): string {
  if (!/^[0-9a-f]{16}$/.test(id)) throw new Error("Invalid database id");
  return demo ? `harbour-demo-${id}.db` : `harbour-${id}.db`;
}

function parseProtection(value: string | null): KeyProtection | null {
  return value === "biometric" || value === "passcode" ? value : null;
}

/**
 * Reads the key (prompting for biometrics) or, if there is none or it was invalidated (for example
 * because biometric enrolment changed), creates a new one.
 */
export async function loadOrCreateDatabaseKey(deps: {
  readonly store: SecretStore;
  readonly randomBytes: (length: number) => Uint8Array;
  readonly options: KeyOptions;
  /** Protection to use when a new key is created. */
  readonly preferredProtection: KeyProtection;
}): Promise<LoadKeyResult> {
  const { store, options } = deps;
  const previousId = await store.getItem(DB_ID_ITEM, options.plainOptions);
  const storedProtection = parseProtection(
    await store.getItem(DB_KEY_PROTECTION_ITEM, options.plainOptions),
  );

  if (previousId && storedProtection) {
    const hex = await store.getItem(DB_KEY_ITEM, options.protectedOptions(storedProtection));
    if (isValidKeyHex(hex)) {
      return {
        key: { id: previousId, sqlcipherKey: sqlcipherRawKey(hex), protection: storedProtection },
        created: false,
        previousId,
      };
    }
  }

  const protection = deps.preferredProtection;
  const hex = bytesToHex(deps.randomBytes(32));
  const id = bytesToHex(deps.randomBytes(8));
  if (!isValidKeyHex(hex)) throw new Error("Random source did not return 32 bytes");
  // Write the key first: if that fails (no passcode set), nothing else changes.
  await store.setItem(DB_KEY_ITEM, hex, options.protectedOptions(protection));
  await store.setItem(DB_KEY_PROTECTION_ITEM, protection, options.plainOptions);
  await store.setItem(DB_ID_ITEM, id, options.plainOptions);
  return {
    key: { id, sqlcipherKey: sqlcipherRawKey(hex), protection },
    created: true,
    previousId,
  };
}

/**
 * Reads the key without ever making one (deleting held entries reads their ids first): null when
 * there is none or it is not usable. With biometric protection the read shows the system prompt.
 */
export async function readDatabaseKey(
  store: SecretStore,
  options: KeyOptions,
): Promise<DatabaseKey | null> {
  const id = await store.getItem(DB_ID_ITEM, options.plainOptions);
  const protection = parseProtection(
    await store.getItem(DB_KEY_PROTECTION_ITEM, options.plainOptions),
  );
  if (!id || !protection) return null;
  const hex = await store.getItem(DB_KEY_ITEM, options.protectedOptions(protection));
  return isValidKeyHex(hex) ? { id, sqlcipherKey: sqlcipherRawKey(hex), protection } : null;
}

/**
 * True while the key or its bookkeeping is still in the keystore (S5, checked after a deletion).
 * The bookkeeping is plain, and a passcode-protected key is readable without a prompt, so both are
 * read back. A biometric-protected key cannot be read without a prompt; its deletion is repeated
 * instead, which throws if the keystore refuses it.
 */
export async function databaseKeyRemains(
  store: SecretStore,
  options: KeyOptions,
): Promise<boolean> {
  const [id, protection, passcodeKey] = await Promise.all([
    store.getItem(DB_ID_ITEM, options.plainOptions),
    store.getItem(DB_KEY_PROTECTION_ITEM, options.plainOptions),
    store.getItem(DB_KEY_ITEM, options.protectedOptions("passcode")),
  ]);
  if (id !== null || protection !== null || passcodeKey !== null) return true;
  await store.deleteItem(DB_KEY_ITEM, options.protectedOptions("biometric"));
  return false;
}

/** Deletes the key and its bookkeeping. The database file becomes unreadable. */
export async function destroyDatabaseKey(store: SecretStore, options: KeyOptions): Promise<void> {
  const protection = parseProtection(
    await store.getItem(DB_KEY_PROTECTION_ITEM, options.plainOptions),
  );
  for (const p of protection ? [protection] : (["biometric", "passcode"] as const)) {
    await store.deleteItem(DB_KEY_ITEM, options.protectedOptions(p)).catch(() => undefined);
  }
  await store.deleteItem(DB_KEY_PROTECTION_ITEM, options.plainOptions).catch(() => undefined);
  await store.deleteItem(DB_ID_ITEM, options.plainOptions).catch(() => undefined);
}
