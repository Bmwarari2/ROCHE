import { describe, expect, it } from "vitest";
import {
  bytesToHex,
  DB_ID_ITEM,
  DB_KEY_ITEM,
  DB_KEY_PROTECTION_ITEM,
  databaseFilename,
  destroyDatabaseKey,
  isValidKeyHex,
  type KeyOptions,
  type KeyProtection,
  loadOrCreateDatabaseKey,
  type SecretStore,
  type SecretStoreOptions,
  StrongBiometricsRequiredError,
  sqlcipherRawKey,
} from "./db-key";

/** In-memory store that, like expo-secure-store, keeps authenticated items apart. */
function memoryStore() {
  const items = new Map<string, string>();
  const reads: Array<{ key: string; options?: SecretStoreOptions }> = [];
  const slot = (key: string, options?: SecretStoreOptions) =>
    `${options?.requireAuthentication ? "auth" : "plain"}:${key}`;
  const store: SecretStore = {
    async getItem(key, options) {
      reads.push({ key, options });
      return items.get(slot(key, options)) ?? null;
    },
    async setItem(key, value, options) {
      items.set(slot(key, options), value);
    },
    async deleteItem(key, options) {
      items.delete(slot(key, options));
    },
  };
  return { store, items, reads, slot };
}

const options: KeyOptions = {
  protectedOptions: (p: KeyProtection) => ({
    requireAuthentication: p === "biometric",
    keychainAccessible: 6,
    authenticationPrompt: "Unlock Harbour",
  }),
  plainOptions: { keychainAccessible: 6 },
};

let counter = 0;
const randomBytes = (n: number) => new Uint8Array(n).map(() => (counter++ * 73 + 5) % 256);

describe("key helpers", () => {
  it("hex-encodes bytes", () => {
    expect(bytesToHex(new Uint8Array([0, 15, 16, 255]))).toBe("000f10ff");
  });

  it("formats the SQLCipher raw key", () => {
    const hex = "ab".repeat(32);
    expect(sqlcipherRawKey(hex)).toBe(`x'${hex}'`);
    expect(() => sqlcipherRawKey("ab")).toThrow();
    expect(isValidKeyHex("AB".repeat(32))).toBe(false);
  });

  it("names database files from the id only", () => {
    expect(databaseFilename("0123456789abcdef")).toBe("harbour-0123456789abcdef.db");
    expect(databaseFilename("0123456789abcdef", true)).toBe("harbour-demo-0123456789abcdef.db");
    expect(() => databaseFilename("../../etc")).toThrow();
  });
});

describe("MASVS-STORAGE Care mode on a live organisation enrols only devices with strong biometrics (H-125)", () => {
  it("refuses to make a passcode-only key on a live organisation, writing nothing", async () => {
    const { store, items } = memoryStore();
    await expect(
      loadOrCreateDatabaseKey({
        store,
        randomBytes,
        options,
        preferredProtection: "passcode",
        allowNewPasscodeKey: false,
      }),
    ).rejects.toBeInstanceOf(StrongBiometricsRequiredError);
    expect(items.size).toBe(0);
    await expect(
      loadOrCreateDatabaseKey({
        store,
        randomBytes,
        options,
        preferredProtection: "passcode",
        allowNewPasscodeKey: false,
      }),
    ).rejects.toThrow(/Face ID or a fingerprint/);
  });

  it.each([
    ["with strong biometrics", "biometric" as const, false],
    ["in the demonstration build", "passcode" as const, true],
  ])("makes the key %s", async (_label, preferredProtection, allowNewPasscodeKey) => {
    const { store } = memoryStore();
    const result = await loadOrCreateDatabaseKey({
      store,
      randomBytes,
      options,
      preferredProtection,
      allowNewPasscodeKey,
    });
    expect(result.created).toBe(true);
  });

  it("keeps opening a passcode-only key made before the rule, so nothing on the phone is lost", async () => {
    const { store } = memoryStore();
    const first = await loadOrCreateDatabaseKey({
      store,
      randomBytes,
      options,
      preferredProtection: "passcode",
    });
    const again = await loadOrCreateDatabaseKey({
      store,
      randomBytes,
      options,
      preferredProtection: "passcode",
      allowNewPasscodeKey: false,
    });
    expect(again).toMatchObject({ created: false, key: first.key });
  });
});

describe("loadOrCreateDatabaseKey", () => {
  it("creates a 32-byte key on first use and stores it with authentication", async () => {
    const { store, items, slot } = memoryStore();
    const result = await loadOrCreateDatabaseKey({
      store,
      randomBytes,
      options,
      preferredProtection: "biometric",
    });
    expect(result.created).toBe(true);
    expect(result.previousId).toBeNull();
    expect(result.key.sqlcipherKey).toMatch(/^x'[0-9a-f]{64}'$/);
    expect(result.key.id).toMatch(/^[0-9a-f]{16}$/);
    expect(items.get(slot(DB_KEY_ITEM, { requireAuthentication: true }))).toMatch(/^[0-9a-f]{64}$/);
    expect(items.has(slot(DB_KEY_ITEM))).toBe(false);
    expect(items.get(slot(DB_KEY_PROTECTION_ITEM))).toBe("biometric");
  });

  it("returns the same key on the next unlock, read with authentication", async () => {
    const { store, reads } = memoryStore();
    const first = await loadOrCreateDatabaseKey({
      store,
      randomBytes,
      options,
      preferredProtection: "biometric",
    });
    const second = await loadOrCreateDatabaseKey({
      store,
      randomBytes,
      options,
      preferredProtection: "biometric",
    });
    expect(second.created).toBe(false);
    expect(second.key).toEqual(first.key);
    const keyRead = reads.find((r) => r.key === DB_KEY_ITEM);
    expect(keyRead?.options?.requireAuthentication).toBe(true);
  });

  it("reads a passcode-protected key with the options it was written with", async () => {
    const { store } = memoryStore();
    const first = await loadOrCreateDatabaseKey({
      store,
      randomBytes,
      options,
      preferredProtection: "passcode",
    });
    const second = await loadOrCreateDatabaseKey({
      store,
      randomBytes,
      options,
      preferredProtection: "biometric",
    });
    expect(second.created).toBe(false);
    expect(second.key.protection).toBe("passcode");
    expect(second.key.sqlcipherKey).toBe(first.key.sqlcipherKey);
  });

  it("replaces an invalidated key and reports the old database id", async () => {
    const { store, items, slot } = memoryStore();
    const first = await loadOrCreateDatabaseKey({
      store,
      randomBytes,
      options,
      preferredProtection: "biometric",
    });
    // Biometric enrolment changed: the keystore drops the item.
    items.delete(slot(DB_KEY_ITEM, { requireAuthentication: true }));
    const second = await loadOrCreateDatabaseKey({
      store,
      randomBytes,
      options,
      preferredProtection: "biometric",
    });
    expect(second.created).toBe(true);
    expect(second.previousId).toBe(first.key.id);
    expect(second.key.id).not.toBe(first.key.id);
  });

  it("changes nothing when the keystore refuses the key (no passcode set)", async () => {
    const { store, items } = memoryStore();
    const refusing: SecretStore = {
      ...store,
      async setItem(key, value, opts) {
        if (key === DB_KEY_ITEM) throw new Error("passcode not set");
        return store.setItem(key, value, opts);
      },
    };
    await expect(
      loadOrCreateDatabaseKey({
        store: refusing,
        randomBytes,
        options,
        preferredProtection: "biometric",
      }),
    ).rejects.toThrow(/passcode/);
    expect(items.size).toBe(0);
  });
});

describe("destroyDatabaseKey", () => {
  it("removes the key and bookkeeping", async () => {
    const { store, items } = memoryStore();
    await loadOrCreateDatabaseKey({
      store,
      randomBytes,
      options,
      preferredProtection: "biometric",
    });
    expect(items.size).toBe(3);
    await destroyDatabaseKey(store, options);
    expect(items.size).toBe(0);
    expect(DB_ID_ITEM).toBe("harbour.db-id.v1");
  });
});
